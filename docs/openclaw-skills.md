# OpenClaw Skills Reference — Quick Lookup Cards

> Fast reference for each skill the agent can perform. Each card shows: what, when, how, and gotchas.

---

## SKILL: Research Trends

**When:** Before creating character, weekly review, before content planning
**How:** Web search
**Queries to use:**
- `"trending Instagram content niches {year}"`
- `"most popular OnlyFans niches {year}"`
- `"AI influencer content trends"`
- `"{archetype} Instagram aesthetic guide"`
- `"what do {archetype} models post on Instagram"`
- `"viral Instagram post formats {month} {year}"`

**Output:** List of trend insights, competitor accounts, content ideas
**Gotcha:** Always verify trends are CURRENT (this year). Old trends hurt engagement.

---

## SKILL: Analyze Competitor Profile

**When:** During research phase, or when looking for style inspiration
**How:**
```
GET /api/profile-analyzer/analyze?username={igUsername}&postLimit=15&sort=newest
```
**Type:** SSE stream (parse events: `progress`, `atoms`, `contentPatterns`, `complete`)
**Save atoms:**
```
POST /api/profile-analyzer/save
{ "profileUsername": "username", "atoms": [atomIds] }
```
**Gotcha:** Requires Apify key. Profile must be public. Pre-check with `/api/availability/check`.

---

## SKILL: Check Instagram URL Accessibility

**When:** Before any cloning/scraping operation
**How:**
```
POST /api/availability/check
{ "url": "https://www.instagram.com/p/ABC123/" }
```
**Response:** `{ status, allowed, is_private }`. Only proceed if `allowed: true`.
**Gotcha:** Age-restricted profiles need authenticated Instagram session.

---

## SKILL: Create Character

**When:** Phase 2, only once per model concept
**How:**
```
POST /api/characters (multipart: name, masterPrompt, image)
```
**Critical:** Master prompt must be extremely detailed about physical features. See template in main doc.
**Gotcha:** Primary image must be high-quality. Generate 3-5 candidates first, pick best one.

---

## SKILL: Add Reference Image

**When:** After character creation, when identity drifts
**How:**
```
POST /api/characters/{charId}/references (multipart: image, category, overridePrompt)
```
**Categories:** `Expression`, `Hairstyle`, `Clothing`, `Pose`, `Accessory`, `Lighting`, `Custom`
**Gotcha:** Toggle active/inactive with `PATCH /api/characters/{charId}/references/{refId}/toggle`. Don't leave all refs active — pick relevant ones per shoot.

---

## SKILL: Generate Single Image

**When:** Targeted specific content, hero shots, test generations
**How:**
```
POST /api/generate
{ characterId, prompt, aspectRatio: "4:5", resolutionTier: "2K", imageModel, poseMode, expressionMode, sceneMode, cameraProfileId, styleAtomIds, activeReferenceIds }
```
**Timeout:** 2 minutes
**Response:** `{ imageId, galleryId, image: { base64Data, mimeType }, text }`
**Gotcha:** ALWAYS include `characterId` for identity lock. Without it, random face generated.

---

## SKILL: Batch Generate

**When:** Need multiple images (daily content production)
**Modes:**
- `variation` — Same prompt, N outputs with variation
- `multi` — Different prompts, one output each
- `override` — Same scene, different reference combos
- `edit` — Modify existing image N times
- `content-mix` — Auto-distribute by content type %

**How:**
```
POST /api/batch
{ mode, config, aspectRatio, resolutionTier, imageModel }
```
**Returns:** `202 { jobId }`. Poll `GET /api/batch/{jobId}` for results.
**Gotcha:** Max concurrency 5 tasks. Max 20 images per batch. Check `GET /api/batch/stats` for queue status before starting.

---

## SKILL: Quality Check Image

**When:** After EVERY generation
**Checks:**
1. `image.validation.identity_match_score` — must be ≥ 70%, prefer ≥ 85%
2. Visual quality — no artifacts, no extra fingers, no distortion
3. iPhone aesthetic — not studio, not CGI, not anime
4. Correct pose, expression, outfit
5. Brand fit — matches archetype

**If fail:** Regenerate with adjusted prompt or more refs.
**If close but not perfect:** Use tweak: `POST /api/tweak { imageId, modifications }`

---

## SKILL: Tweak/Edit Image

**When:** Image is 90%+ good but needs small adjustment
**How:**
```
POST /api/tweak
{ imageId, characterId, modifications: { pose?, expression?, clothing?, cameraAngle?, mood? } }
```
**Gotcha:** Only 5 modification types. For bigger changes, regenerate from scratch.

---

## SKILL: Create Style Atoms

**When:** Building style library (Phase 3), or adding new styles
**Single:**
```
POST /api/style-library
{ category: "pose", text: "Leaning against doorframe, one arm raised...", tags: ["lean", "doorway"] }
```
**Bulk:**
```
POST /api/style-library/bulk
{ atoms: [{ category, text }, ...] }
```
**Categories:** `pose`, `expression`, `outfit`, `scene`, `lighting`, `camera`, `vibe`, `accessories`, `format`
**Quality gate:** Atoms under 15 chars are rejected. Be descriptive.

---

## SKILL: Compose Style Prompt

**When:** Before generation, to preview what atoms produce
**How:**
```
POST /api/style-library/compose
{ atomIds: ["atom1", "atom2", "atom3"] }
```
**Returns:** Composed prompt string
**Gotcha:** Review the output — atoms from different sources may conflict. Remove conflicting atoms.

---

## SKILL: AI Fill Style Gaps

**When:** Style library has some categories but missing others
**How:**
```
POST /api/style-library/suggest
{ atomIds: [existing atoms], targetCategories: ["lighting", "vibe"] }
```
**Returns:** Suggested new atoms. Review and bulk-create the good ones.

---

## SKILL: Auto-Plan Content Week

**When:** Weekly planning (Phase 4)
**How:**
```
POST /api/auto/plan
{ theme, duration: 7, characterId, personaMode, spicinessLevel, carouselCount: 3, execute: false }
```
**Persona modes:** `luxury`, `of`, `fitness`, `girl_next_door`, `high_fashion`
**Spiciness (OF only):** 0-20 soft, 21-40 playful, 41-60 confident, 61-80 bold, 81-100 high-intensity
**Gotcha:** Set `execute: false` to review first. Then execute day-by-day or all at once.

---

## SKILL: Execute Plan Day

**When:** During daily content production
**How:**
```
POST /api/auto/plans/{planId}/execute-day
{ dayNumber: 1 }
```
**Returns:** `{ jobIds }`. Poll each batch job for completion.

---

## SKILL: Generate Captions

**When:** After selecting best images from a generation batch
**How:**
```
POST /api/story/generate
{ imageIds: [...], nicheId, includeHashtags: true, hashtagCount: 15, ctaType: "save", optimizeFor: "saves" }
```
**CTA types:** `follow`, `like`, `comment`, `share`, `save`, `link`, `dm`, `custom`
**Optimize targets:** `saves`, `shares`, `comments`, `reach`, `explore`
**Gotcha:** Images must be in the in-memory store (imageIds from recent generation). Gallery images need to be loaded first.

---

## SKILL: Set Brand Voice

**When:** Once during setup, update as needed
**How:**
```
PATCH /api/brand-voice
{ writingStyleDescription, vocabularyPreferences, emojiFrequency: "low"|"medium"|"high", forbiddenWords }
```
**Gotcha:** This affects ALL caption generation. Set it right the first time.

---

## SKILL: Clone Instagram Post

**When:** Found a trending post to replicate with your character
**How:**
```
POST /api/post-clone
{ sourceUrl, characterId, mode: "exact"|"creative", imageModel }
```
**Pre-check:** `POST /api/availability/check { url }`
**Gotcha:** Requires Apify key + Instagram session for some content. Cosplay mode preserves source wig.

---

## SKILL: Clone Reel Frames

**When:** Found a trending reel to replicate
**How:**
```
POST /api/reel-copy
{ reelUrl, characterId, poseMatchStrength: "strict", environmentMatchStrength: "medium", useSourceFrameReference: true, imageModel }
```
**Gotcha:** Extracts first + last frame only. Hair from source person is automatically stripped. Requires Apify + ffmpeg.

---

## SKILL: Generate Video

**When:** 2-3 times per week, from best images
**How:**
```
POST /api/video/generate
{ model: "kling-v2.5-turbo-std", galleryId, prompt: "motion description", duration: 5 }
```
**Poll:** `GET /api/video/{taskId}/status` every 3-5 seconds
**Models:**
- `kling-v2.5-turbo-std` — Fast, daily content
- `kling-v2.5-turbo-pro` — Hero content, supports end-frame
- `grok-imagine-video` — Alternative aesthetic
- `kling-v2.6-motion` — Copy motion from reference reel
- `kling-v2.6-motion-pro` — Higher quality motion copy
**Gotcha:** Requires WaveSpeed key. Videos take 1-5 minutes. Max duration depends on model.

---

## SKILL: Scene Recreation

**When:** Have a great scene/location photo, want to place character in it
**How:**
1. `POST /api/scene/analyze { image, mimeType }` → returns scene data
2. Review/edit scene fields
3. `POST /api/scene/recreate { sceneData, characterId, aspectRatio, resolutionTier }`
**Gotcha:** Hair from source scene is used unless stripped. Outfit from source applies unless overridden.

---

## SKILL: Gallery Management

**When:** After generation, during review
**List:** `GET /api/gallery?page=1&limit=24&tag=favorites`
**Favorite:** `PATCH /api/gallery/{id}/favorite`
**Tag:** `POST /api/gallery/{id}/tags { tag: "hero-shot" }`
**Delete:** `DELETE /api/gallery/{id}`
**Bulk delete:** `DELETE /api/gallery/bulk { ids: [...] }`
**Gotcha:** Gallery persists to disk. In-memory image store (imageIds) is temporary (1hr TTL).

---

## SKILL: Save/Load Templates

**When:** Found a generation configuration that works well
**Save:**
```
POST /api/templates
{ name: "Beach Sunset Golden Hour", page: "generate", config: { ...all form settings } }
```
**Load:** `GET /api/templates` → select → apply config to next generation

---

## SKILL: Carousel Follow-Up

**When:** Have a great image, want coherent multi-slide variations
**How:**
```
POST /api/carousel/follow-up
{ imageBase64, mimeType, characterId, count: 4, followUpMode: "ai", strictContinuityLock: true, aspectRatio: "4:5" }
```
**Returns:** Batch job ID. Poll for results.
**Gotcha:** Continuity lock keeps outfit/scene consistent across slides.

---

## SKILL: Generate Poll Pairs

**When:** Engagement content day (10% of mix)
**How:**
```
POST /api/carousel/polls
{ topic: "Beach vs Mountains?", characterId, pollCount: 2, aspectRatio: "4:5" }
```
**Returns:** Batch job with pairs of contrasting images.

---

## SKILL: Health Check

**When:** At start of every session, when errors occur
**How:** `GET /api/keys/health-check`
**Response:** Status for gemini, apify, wavespeed, instagram (each: connected/disconnected, latency)
**Gotcha:** 30-second cache. Won't reflect changes within 30s of last check.

---

## SKILL: Manage Outfits

**When:** Want to lock specific outfit across generations
**Create:**
```
POST /api/outfits
{ name: "Beach Day", top: "White ribbed bikini top", bottom: "High-waisted bikini bottom", accessories: "Gold chain anklet, oversized sunglasses", footwear: "Barefoot" }
```
**Use:** Pass `outfitId` in generation requests.

---

## SKILL: Manage Scene Memories

**When:** Want to reuse a specific location/environment
**Create:**
```
POST /api/scene-memory
{ name: "Miami Penthouse", architecture: "Modern minimalist, floor-to-ceiling windows", lightingProfile: "Golden afternoon light", colorPalette: "White, gold, teal accents", recurringElements: "Ocean view, marble floors", timeOfDayBias: "golden hour" }
```
**Use:** Pass `sceneMemoryId` in generation requests.
