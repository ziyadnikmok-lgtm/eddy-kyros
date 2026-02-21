const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError } = require('../middleware/errorHandler');
const { asText } = require('../utils/helpers');
const { initSSE } = require('../utils/sse');
const apiKeyManager = require('../services/apiKeyManager');
const geminiService = require('../services/geminiService');
const styleLibrary = require('../services/styleLibrary');
const {
  runPostActor,
  normalizePostsFromItems,
  downloadImageToTemp,
  mimeFromExt,
  ensureTempDir,
} = require('./postClone');

const router = express.Router();
const TEMP_DIR = path.join(process.cwd(), 'temp');

// Identity-agnostic extraction prompt for style atoms (Nano-Banana enriched)
const STYLE_EXTRACTION_PROMPT = `You are a style analysis engine for an AI image generation system. Analyze this image and extract ONLY stylistic elements as natural language descriptions.

CRITICAL RULES:
- DO NOT describe the person's identity, face shape, body type, skin color, hair color, or physical features.
- Write in directive tone ("Standing with weight on left hip" NOT "She is standing with weight on left hip").
- Each field must be a DESCRIPTIVE SENTENCE or SHORT PARAGRAPH — NOT a comma-separated tag list.
- Be specific and detailed. Describe like you're briefing a human photographer or artist.
- DO include expression details — expression is style direction, not identity.
- Write at least 10 words per field. If a category is not visible, return an empty string.

WRITING STYLE (Nano-Banana formula — how AI image generators understand prompts best):
- Use natural flowing language: "Soft golden hour sunlight streaming from camera-left, casting warm amber highlights on the skin with gentle elongated shadows" NOT "golden hour, warm, side lighting, amber"
- Include cause-and-effect: "Direct on-camera flash creating harsh highlights on metallic fabric with a crisp shadow on the wall behind" NOT "flash, harsh, metallic"
- Be specific about relationships: "White off-shoulder ribbed crop top with a relaxed drape, paired with high-waisted beige linen cargo pants and tan leather platform sandals" NOT "white crop top, beige pants, sandals"

Return a JSON object with these fields:
{
  "pose": "Full body positioning in directive tone — describe weight distribution, limb placement, torso angle, shoulder line, hand/finger placement and what they're touching or interacting with. Minimum 10 words",
  "expression": "Facial mood and energy — gaze direction and intensity, mouth position, eyebrow placement, overall emotional temperature. Directive tone. Minimum 8 words",
  "outfit": "All visible garments described with fit, fabric, color, texture, and how the fabric interacts with the body (draped, clinging, flowing, structured). Minimum 12 words",
  "scene": "Full environment description — setting type, architectural elements, surfaces, textures, color palette, spatial depth, foreground and background elements. Minimum 12 words",
  "lighting": "Light source type and direction, quality (hard/soft/diffused), color temperature, shadow character and placement. Describe the effect on the scene. Minimum 10 words",
  "camera": "Shot type, estimated focal length, shooting angle, depth of field, lens character. Describe the compositional framing. Minimum 8 words",
  "vibe": "Overall mood, aesthetic era or style movement, emotional tone, energy level, visual storytelling intent. One cohesive sentence. Minimum 8 words",
  "accessories": "All visible accessories — jewelry type and material, bags, hats, sunglasses, hair accessories. Describe placement and visual effect. Minimum 6 words",
  "format": "Visual rendering style — photography type (editorial/candid/selfie/studio), post-processing look (film grain/clean digital/vintage), visual treatment. Minimum 6 words",
  "recommended_prompt": "Write a complete identity-agnostic recreation prompt following Nano-Banana formula: SCENE → LIGHTING → CAMERA → POSE → EXPRESSION → OUTFIT → ACCESSORIES → DETAILS → FORMAT. One flowing paragraph, directive tone, no identity descriptors"
}

Return ONLY the JSON object, no markdown fences or extra text.`;

/**
 * GET /api/profile-analyzer/analyze
 * SSE endpoint — scrapes an IG profile via Apify, then analyzes each post with Gemini.
 * Query: ?username=xxx&postLimit=12&sort=newest|oldest&newerThan=30+days
 *
 * sort=newest (default) — take the first N posts (Instagram returns newest first)
 * sort=oldest — scrape up to 100 posts, sort by date ascending, take first N
 * newerThan — passed to Apify as onlyPostsNewerThan (e.g. "30 days", "2025-01-01")
 */
router.get('/analyze', async (req, res) => {
  // SSE headers
  const send = initSSE(res);

  const username = asText(req.query.username).replace(/^@/, '');
  const postLimit = Math.max(1, Math.min(30, parseInt(req.query.postLimit) || 12));
  const sort = asText(req.query.sort) || 'newest';
  const newerThan = asText(req.query.newerThan) || '';

  if (!username) {
    send('error', { message: 'Username is required' });
    return res.end();
  }

  const apiKey = apiKeyManager.getActiveKey();
  if (!apiKey) {
    send('error', { message: 'No active Gemini API key configured' });
    return res.end();
  }

  let closed = false;
  req.on('close', () => { closed = true; });

  try {
    // For "oldest" sort we need to scrape more posts so we can reverse-pick
    const scrapeLimit = sort === 'oldest' ? Math.min(100, postLimit * 8) : postLimit;

    send('progress', { current: 0, total: 0, status: sort === 'oldest'
      ? `Scraping @${username} (fetching up to ${scrapeLimit} posts to find oldest ${postLimit})...`
      : `Scraping @${username} via Apify...`
    });

    // Scrape the profile
    const profileUrl = `https://www.instagram.com/${username}/`;
    const items = await runPostActor({
      url: profileUrl,
      limit: scrapeLimit,
      ...(newerThan ? { onlyPostsNewerThan: newerThan } : {}),
    });
    if (!items || items.length === 0) {
      send('error', { message: `No posts found for @${username}` });
      return res.end();
    }

    // Build a timestamp map from raw items to help sort posts
    const timestampMap = new Map();
    for (const item of items) {
      const url = asText(item.url || item.inputUrl || item.shortCodeUrl || '');
      const ts = item.timestamp || item.taken_at_timestamp || item.takenAtTimestamp || item.date || '';
      if (url && ts) {
        timestampMap.set(url, new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts).getTime());
      }
    }

    // Normalize to get image URLs
    let posts = normalizePostsFromItems(items);

    // Apply sort order
    if (sort === 'oldest' && timestampMap.size > 0) {
      posts = posts
        .map(p => ({ ...p, _ts: timestampMap.get(p.sourceUrl) || Infinity }))
        .sort((a, b) => a._ts - b._ts)
        .slice(0, postLimit);
    } else {
      posts = posts.slice(0, postLimit);
    }

    const total = posts.length;
    send('progress', { current: 0, total, status: `Found ${total} posts, starting analysis...` });

    ensureTempDir();

    // Analyze each post
    for (let i = 0; i < total; i++) {
      if (closed) break;

      const post = posts[i];
      const imageUrl = post.imageUrls?.[0]; // Use first image of each post
      if (!imageUrl) {
        send('progress', { current: i + 1, total, status: `Post ${i + 1}: no image, skipping` });
        continue;
      }

      send('progress', { current: i + 1, total, status: `Analyzing post ${i + 1}/${total}...` });

      let tempFile = null;
      try {
        // Download image to temp
        const ext = path.extname(new URL(imageUrl).pathname) || '.jpg';
        tempFile = path.join(TEMP_DIR, `pa-${crypto.randomUUID()}${ext}`);
        await downloadImageToTemp(imageUrl, tempFile);
        if (closed) break;

        // Read as base64
        const imageBuffer = fs.readFileSync(tempFile);
        const base64 = imageBuffer.toString('base64');
        const mime = mimeFromExt(tempFile);

        // Analyze with Gemini
        const raw = await geminiService.analyzeImageWithPrompt(apiKey, base64, mime, STYLE_EXTRACTION_PROMPT);
        if (closed) break;

        // Parse the JSON response
        let parsed = {};
        try {
          const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
          parsed = JSON.parse(cleaned);
        } catch {
          // Try extracting JSON from response
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try { parsed = JSON.parse(jsonMatch[0]); } catch { /* skip */ }
          }
        }

        // Build atoms from parsed response
        const atoms = [];
        const categories = ['pose', 'expression', 'outfit', 'scene', 'lighting', 'camera', 'vibe', 'accessories', 'format'];
        for (const cat of categories) {
          const text = asText(parsed[cat]);
          if (text.length >= 10) {
            atoms.push({
              category: cat,
              text: styleLibrary.stripIdentity(text),
              tags: [],
            });
          }
        }

        // Extract recommended_prompt (not an atom — display-only convenience)
        const recommendedPrompt = asText(parsed.recommended_prompt);

        send('atoms', {
          postIndex: i,
          postUrl: post.sourceUrl || `https://instagram.com/p/${post.shortcode || ''}`,
          atoms,
          recommendedPrompt: recommendedPrompt.length >= 20 ? recommendedPrompt : '',
        });

      } catch (err) {
        send('progress', { current: i + 1, total, status: `Post ${i + 1}: analysis failed — ${err.message}` });
      } finally {
        if (tempFile) {
          try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
        }
      }
    }

    send('complete', { username, total });
  } catch (err) {
    send('error', { message: err.message || 'Profile analysis failed' });
  }

  res.end();
});

/**
 * POST /api/profile-analyzer/save
 * Save reviewed atoms to the style library.
 * Body: { profileUsername, atoms: [{category, text, tags}, ...] }
 */
router.post('/save', (req, res, next) => {
  try {
    const { profileUsername, atoms, analyzedPostCount } = req.body;
    if (!profileUsername || !Array.isArray(atoms) || atoms.length === 0) {
      throw new AppError('profileUsername and non-empty atoms array required', 400, 'VALIDATION_ERROR');
    }

    const toCreate = atoms.map(a => ({
      category: a.category,
      text: a.text,
      tags: a.tags || [],
      source: {
        type: 'profile_analysis',
        profileUsername: profileUsername.replace(/^@/, ''),
      },
    }));

    const created = styleLibrary.createBulk(toCreate);
    styleLibrary.markProfileAnalyzed(profileUsername.replace(/^@/, ''), {
      postCount: Number.isInteger(analyzedPostCount) && analyzedPostCount >= 0 ? analyzedPostCount : undefined,
      selectedAtomCount: atoms.length,
    });

    res.status(201).json({ success: true, data: { saved: created.length } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
