const { AppError } = require('../../middleware/errorHandler');
const apiKeyManager = require('../apiKeyManager');
const geminiService = require('../geminiService');
const log = require('../../utils/logger');

const personaInstructions = {
  luxury: `
    Emphasize exclusivity, elegance, yacht life, fine dining, quiet confidence.
    Solo subject only.
    High-end aesthetic.
    Refined, minimal emotion.
  `,
  of: `
    Emphasize sensual solo energy.
    Confident, flirtatious, main-character.
    No men.
    No couples.
    No romantic framing.
    Slightly provocative but not explicit.
    Focus on body language, gaze, and presence.
  `,
  fitness: `
    Athletic focus.
    Gym scenes.
    Healthy lifestyle.
    Strong posture.
    Active movement.
    No romantic framing.
  `,
  girl_next_door: `
    Soft, relatable, cozy moments.
    Cafe, bookstore, beach walks.
    Natural expressions.
    No romantic partner.
  `,
  high_fashion: `
    Editorial, model energy.
    Strong poses.
    Dramatic lighting.
    Minimal emotion.
    Luxury styling.
  `,
  goth: `
    Dark goth/alt girl influencer aesthetic.
    Each day features a DIFFERENT goth outfit and vibe.
    Photos taken by a friend, some mirror selfies. Urban nighttime locations.
    NOT studio. NOT editorial. NOT professional photography.

    BODY RULE — CRITICAL:
    - The subject's body proportions MUST match the reference image(s) EXACTLY.
    - Do NOT exaggerate bust, waist, hips, or any feature. REALISTIC proportions only.
    - The person must look like a REAL human, not an idealized or stylized version.

    CAMERA: iPhone, friend-taken or tripod. Flash at night encouraged. Casual quality.
    AESTHETIC: dark clothing, cross necklace/choker, chains, fishnets, dark makeup, platform boots.
    POSES: varied — pouty, tongue out, smirking, deadpan, rock horns, peace sign, leaning on wall.
    BACKGROUNDS: dark streets, bars, cars at night, dark bedrooms, graffiti walls.
    Energy: edgy, confident, unapologetic. NOT cute or wholesome.
    Solo subject only.
  `,
  cosplay: `
    Anime/manga cosplay influencer — FEMALE characters only.
    Each day features a DIFFERENT popular female anime character cosplay outfit.
    Mostly photos taken by a friend or on tripod/timer. Occasional mirror selfie is OK (max 1 per 3 days).
    Simple real-world backgrounds: bedroom, hallway, hotel room, living room, plain wall.
    NOT studio shots. NOT professional photography. NOT editorial.

    CAMERA RULES:
    - MOST shots (80%+): camera held by someone else or on tripod — subject's hands are FREE for posing
    - RARE mirror selfie (max 1 per 3 days): bedroom full-length mirror ONLY, phone visible, simple single mirror. NO bathrooms.
    - NO bathrooms, NO showers, NO bathtubs — even for mirror selfies
    - Shot on iPhone — casual amateur quality, natural/warm lighting, slightly grainy

    AESTHETIC REFERENCE (match this vibe exactly):
    - Character-accurate cosplay WIGS are MANDATORY — match the character's actual hair color and style exactly. Override the model's natural hair completely.
    - Outfit style is determined by the lewdness slider — follow the OUTFIT STYLE instruction below exactly.
    - ALWAYS include thigh-high stockings, fishnets, or knee-high socks as accessories — this is a signature element.
    - Garter belts, chokers, and character-themed hair clips as accessories.
    - Poses: sitting on bed/floor, leaning against wall, lying down, hip-cocked standing, peace sign, hands on hips, hair flip, looking over shoulder. Occasional bedroom mirror selfie OK.
    - Mix of close-up (face + wig + upper body) and full body shots each day.
    - Expressions: VARY each shot — playful smirk, tongue out, pouty lips, looking up at camera, peace sign, laughing, looking away candidly, soft smile. Avoid repeating the same expression.
    - Warm bedroom lighting or window light. Slightly grainy/casual quality.
    - Messy bedroom, plain wall, bed — keep backgrounds boring so the cosplay pops.

    Energy: flirty, confident, teasing, main-character. Cute AND sexy, never wholesome or editorial.
    Solo subject only.
  `,
};

const BASE_SYSTEM_PROMPT = `You are a professional social media content planner.

Generate a structured Instagram posting plan.

Return JSON only.

Each day must include:
- day (number)
- theme
- location_description
- vibe
- time_of_day
- lighting_style
- reel_motion_hint
- lifestyle_insert
- costume_description (DETAILED description of the exact outfit/costume — colors, materials, pieces, fit. This must be specific enough to reproduce identically across multiple shots)
- wig_description (exact wig color and style matching the character — e.g. "long pink hair with bangs" or "short black bob with red highlights")

Do NOT generate image prompts.
Do NOT mention aspect ratios.
Keep descriptions short and cinematic.`;

/**
 * For cosplay mode: use Gemini with Google Search grounding to find trending cosplay outfits.
 * Detects whether the theme is gaming or anime and adjusts the search accordingly.
 */
async function _researchCosplayOutfits(apiKey, duration, theme) {
  const gamingKeywords = /\b(valorant|league of legends|lol|overwatch|nier|final fantasy|street fighter|resident evil|genshin|honkai|blue archive|wuthering waves|zenless|gaming|game|video game)\b/i;
  const isGaming = gamingKeywords.test(theme || '');
  const themeHint = theme ? `Focus specifically on: ${theme}.` : '';

  const searchPrompt = isGaming
    ? `Search for trending female video game cosplays currently viral on TikTok and Instagram.
Find ${duration + 3} unique characters. ${themeHint}
Focus on iconic, visually striking costumes with high cosplay impact.

Return ONLY a JSON array, no markdown:
[{ "character": "Name", "anime": "Game title", "outfit_description": "Specific fabrics, exact colors, armor/prop details, wig styling (color, length, texture)" }]

Mix: trending game cosplays + characters with recognizable silhouettes that translate well to real costumes.`
    : `Search for trending female anime cosplays currently viral on TikTok and Instagram.
Find ${duration + 3} unique characters. ${themeHint}
Focus on iconic, visually striking costumes popular among cosplay influencers.

Return ONLY a JSON array, no markdown:
[{ "character": "Name", "anime": "Anime/manga title", "outfit_description": "Specific fabrics, exact colors, prop details, wig styling (color, length, texture)" }]

Mix: classic popular characters + currently trending from recent seasons + visually striking designs.`;

  try {
    const rawText = await geminiService.generateTextWithSearch(apiKey, searchPrompt, {
      temperature: 0.5,
    });
    const cleaned = String(rawText).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const outfits = JSON.parse(cleaned);
    log.info('cosplay_research', { outfitCount: outfits.length, isGaming, theme });
    return outfits;
  } catch (err) {
    log.warn('cosplay_research_fallback', { error: err.message });
    // Fallback: mix of anime + gaming picks
    return isGaming ? [
      { character: 'Jett', anime: 'Valorant', outfit_description: 'White cropped jacket, blue bodysuit, white sneakers, silver-white hair in messy bun, throwing knives, wind effects' },
      { character: 'Reyna', anime: 'Valorant', outfit_description: 'Purple and black bodysuit, glowing purple eyes, long dark purple hair, soul orb accessories' },
      { character: 'Sage', anime: 'Valorant', outfit_description: 'Teal and white Chinese-inspired outfit, jade orb, long black hair with teal streaks, healing crystal accessories' },
      { character: 'Jinx', anime: 'League of Legends / Arcane', outfit_description: 'Blue crop top with clouds, belted shorts, long blue braids with pink accents, arm tattoos, minigun Pow-Pow prop' },
      { character: 'Ahri', anime: 'League of Legends', outfit_description: 'White and gold Korean-inspired outfit, nine fox tails, fox ears, long black hair, golden orb' },
      { character: '2B', anime: 'NieR: Automata', outfit_description: 'Black gothic lolita dress, white-silver bob wig with blindfold, black boots, katana prop, YoRHa insignia' },
      { character: 'Tifa Lockhart', anime: 'Final Fantasy VII', outfit_description: 'White tank top, black mini skirt, suspenders, red gloves, long black hair, brown eyes' },
      { character: 'D.Va', anime: 'Overwatch', outfit_description: 'White and blue bodysuit with pink accents, headset, brown hair in whisker face paint, bunny logo' },
      { character: 'Juri Han', anime: 'Street Fighter 6', outfit_description: 'Purple spider-themed outfit, black bodysuit, purple feng shui engine eye, black twin buns hair' },
      { character: 'Ada Wong', anime: 'Resident Evil', outfit_description: 'Red cheongsam dress with high slit, black bob hair, red lipstick, grappling gun, sunglasses' },
    ] : [
      { character: 'Asuka Langley', anime: 'Neon Genesis Evangelion', outfit_description: 'Red plugsuit with neural connectors, red hair clips, blue eyes' },
      { character: 'Makima', anime: 'Chainsaw Man', outfit_description: 'Black business suit, white shirt, black tie, ringed yellow eyes, long red braided hair' },
      { character: 'Marin Kitagawa', anime: 'My Dress-Up Darling', outfit_description: 'Shizuku-tan black bikini cosplay with cat ears, blonde hair, blue eyes, playful expression' },
      { character: 'Yor Forger', anime: 'Spy x Family', outfit_description: 'Black dress with gold trim, red thorn earrings, black hair with headband, red eyes' },
      { character: 'Zero Two', anime: 'Darling in the Franxx', outfit_description: 'Red military uniform, white boots, long pink hair, red horns headband, green eyes' },
      { character: 'Raiden Shogun', anime: 'Genshin Impact', outfit_description: 'Purple kimono-style outfit, braided purple hair, electro vision, purple eyes' },
      { character: 'Nico Robin', anime: 'One Piece', outfit_description: 'Purple cowgirl outfit, sunglasses, long black hair, cowboy hat' },
      { character: 'Power', anime: 'Chainsaw Man', outfit_description: 'White shirt, black tie loosened, messy long blonde hair with red horns, sharp teeth, wild eyes' },
      { character: 'Nezuko Kamado', anime: 'Demon Slayer', outfit_description: 'Pink kimono with hemp leaf pattern, bamboo mouthpiece, black hair with orange tips' },
      { character: 'Rem', anime: 'Re:Zero', outfit_description: 'Maid outfit with blue accents, short blue hair, blue eyes, hair clip over right eye' },
    ];
  }
}

/**
 * For goth mode: research trending goth/alt outfits via Gemini + Google Search.
 */
async function _researchGothOutfits(apiKey, duration, gothTheme) {
  const themeHint = gothTheme ? `Focus on this specific goth subgenre: ${gothTheme}.` : 'Mix different goth subgenres (classic goth, punk, romantic, e-girl, streetwear).';
  const searchPrompt = `Search for trending goth and alt-girl aesthetics on Instagram and TikTok (e.g. cyber-sigilism, whimsigoth, corp-goth, opium style).
Find ${duration + 3} distinct outfit combinations popular with alt fashion influencers.
${themeHint}

Return ONLY a JSON array, no markdown:
[{ "style": "Sub-style name", "outfit_description": "Specific garments, layering, textures (leather, lace, mesh), hardware (chains, buckles), shoes, colors", "vibe": "Mood/setting" }]

Real outfits influencers actually wear — not costume-y.`;

  try {
    const rawText = await geminiService.generateTextWithSearch(apiKey, searchPrompt, {
      temperature: 0.6,
    });
    const cleaned = String(rawText).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const outfits = JSON.parse(cleaned);
    log.info('goth_research', { outfitCount: outfits.length, theme: gothTheme });
    return outfits;
  } catch (err) {
    log.warn('goth_research_fallback', { error: err.message });
    return [
      { style: 'Classic Goth', outfit_description: 'Black lace corset top, black mini skirt, fishnet stockings, platform boots, cross necklace choker, dark eyeliner', vibe: 'dark and mysterious' },
      { style: 'Punk Goth', outfit_description: 'Ripped band tee (cropped), plaid mini skirt with chain belt, combat boots, studded bracelet, spiked choker', vibe: 'rebellious and raw' },
      { style: 'Romantic Goth', outfit_description: 'Black velvet off-shoulder top, long black lace skirt with slit, Victorian choker, silver rings, pointed boots', vibe: 'dark elegance' },
      { style: 'E-Girl Dark', outfit_description: 'Black mesh long-sleeve under black crop top, pleated skirt, thigh-high socks, platform sneakers, chain necklace with cross', vibe: 'internet dark aesthetic' },
      { style: 'Streetwear Goth', outfit_description: 'Oversized black hoodie (cropped), black cargo pants with chains, chunky platform boots, beanie, layered silver chains', vibe: 'urban dark minimalist' },
      { style: 'Club Goth', outfit_description: 'Black PVC/vinyl mini dress, fishnet stockings, knee-high boots, statement choker, dark smoky makeup', vibe: 'dark nightlife energy' },
      { style: 'Soft Goth', outfit_description: 'Black camisole with lace trim, black jeans, ankle boots, delicate cross pendant, minimal dark jewelry', vibe: 'effortless dark cute' },
      { style: 'Grunge Goth', outfit_description: 'Torn fishnet top over black bralette, ripped black jeans, chunky boots, messy dark hair, smudged eyeliner', vibe: 'messy and unhinged' },
      { style: 'Goth x Anime', outfit_description: 'Black cat ear headband, black halter top with cutouts, black pleated skirt, thigh-high stockings, platform Mary Janes, cross choker', vibe: 'dark anime girl' },
      { style: 'Witch Goth', outfit_description: 'Black flowing maxi dress with bell sleeves, pentagram necklace, black wide-brim hat, rings on every finger, black boots', vibe: 'mystical and dark' },
    ];
  }
}

async function generateWeeklyPlan({ theme, duration, personaMode, customPersona, spicinessLevel, cosplayOptions }) {
  const selectedPersona = personaInstructions[personaMode] ? personaMode : 'luxury';
  if (personaMode && !personaInstructions[personaMode]) {
    log.warn('invalid_persona_fallback', { requested: personaMode, using: 'luxury' });
  }
  const hasCustomPersona = typeof customPersona === 'string' && customPersona.trim().length > 0;
  const personaBlock = hasCustomPersona
    ? `
     Custom Persona Instructions:
     ${customPersona}
   `
    : personaInstructions[selectedPersona];
  let spicinessBlock = '';

  if (selectedPersona === 'of') {
    const level = Number(spicinessLevel || 30);

    if (level <= 20) {
      spicinessBlock = 'Tone: soft flirt energy. Playful, subtle, natural beauty emphasis.';
    } else if (level > 20 && level <= 40) {
      spicinessBlock = 'Tone: playful confidence. Light teasing eye contact. Relaxed sensual posture.';
    } else if (level > 40 && level <= 60) {
      spicinessBlock = 'Tone: confident sensual energy. Strong eye contact. Emphasis on curves through pose, not exposure.';
    } else if (level > 60 && level <= 80) {
      spicinessBlock = 'Tone: bold seductive presence. Controlled body language. Dominant gaze. Suggestive but not explicit.';
    } else if (level > 80) {
      spicinessBlock = 'Tone: high-intensity tease energy. Powerful, provocative body language. Still no explicit nudity or sexual acts.';
    }
  }
  const personaSection = selectedPersona === 'of'
    ? `${personaBlock}

Spiciness Intensity:
${spicinessBlock}`
    : personaBlock;

  const apiKey = apiKeyManager.getActiveKey();

  /**
   * Shared logic for cosplay/goth: parse options, research outfits, group & assign.
   */
  function _parseOutfitOptions(cosplayOpts) {
    const opts = cosplayOpts || {};
    return {
      opts,
      lewdness: Number(opts.lewdness || 30),
      style: opts.style || 'accurate',
      location: opts.location || '',
      outfitCount: opts.conventionMode ? duration * 2 : duration,
    };
  }

  function _groupOutfits(outfits, groupKey, groupEnabled, count) {
    if (groupEnabled && outfits.length > 0) {
      const groups = {};
      for (const o of outfits) {
        const key = (o[groupKey] || '').toLowerCase();
        if (!groups[key]) groups[key] = [];
        groups[key].push(o);
      }
      const sorted = Object.values(groups).sort((a, b) => b.length - a.length);
      return sorted.flat().slice(0, count);
    }
    return outfits.slice(0, count);
  }

  function _buildOutfitLines(assigned, dur, conventionMode, formatFn, conventionFormatFn) {
    if (conventionMode) {
      const lines = [];
      for (let d = 0; d < dur; d++) {
        const chunk = assigned.slice(d * 2, d * 2 + 2);
        lines.push(`Day ${d + 1}: ${chunk.map(conventionFormatFn).join(' AND ')}`);
      }
      return lines.join('\n');
    }
    return assigned.slice(0, dur).map((o, i) => `Day ${i + 1}: ${formatFn(o)}`).join('\n');
  }

  // For cosplay mode: research trending outfits first, then inject into the plan prompt
  let cosplayOutfitBlock = '';
  if (selectedPersona === 'cosplay') {
    const { opts, lewdness, style, location, outfitCount } = _parseOutfitOptions(cosplayOptions);
    const outfits = await _researchCosplayOutfits(apiKey, outfitCount + 3, theme);
    const assignedOutfits = _groupOutfits(outfits, 'anime', opts.groupTheme, outfitCount);
    const outfitLines = _buildOutfitLines(
      assignedOutfits, duration, opts.conventionMode,
      (o) => `${o.character} from "${o.anime}" — ${o.outfit_description}`,
      (c) => `${c.character} from "${c.anime}" — ${c.outfit_description}`,
    );

    // Lewdness instructions
    let lewdnessBlock;
    if (lewdness <= 20) {
      lewdnessBlock = 'Outfit style: screen-accurate cosplay costume. Faithful to the original character design.';
    } else if (lewdness <= 40) {
      lewdnessBlock = 'Outfit style: slightly sexier version of the costume. Tighter fit, shorter hemline, more skin showing than the original.';
    } else if (lewdness <= 60) {
      lewdnessBlock = 'Outfit style: sexy reinterpretation. Crop top version, mini skirt, exposed midriff, cleavage-forward styling.';
    } else if (lewdness <= 80) {
      lewdnessBlock = 'Outfit style: bikini/lingerie version of the cosplay. Keep character-accurate colors and accessories but the outfit itself is a bikini or lingerie set.';
    } else {
      lewdnessBlock = 'Outfit style: bunny suit version of the cosplay. Classic bunny girl outfit (leotard, bunny ears, fishnet stockings, bow tie) in the character\'s signature colors.';
    }

    // Style instructions
    let styleBlock;
    if (style === 'sexy') {
      styleBlock = 'Cosplay interpretation: sexy reinterpretation. Modify the costume to be more revealing and form-fitting while keeping it recognizable.';
    } else if (style === 'casual') {
      styleBlock = 'Cosplay interpretation: casual closet cosplay. Everyday clothing (hoodie, t-shirt, skirt) that references the character\'s color scheme + the character\'s wig. Low-effort cozy vibe.';
    } else {
      styleBlock = 'Cosplay interpretation: accurate cosplay. Faithful recreation of the character\'s outfit as a real costume.';
    }

    // Location override
    const locationMap = {
      bedroom: 'bedroom with warm lighting, messy bed or desk visible. NO mirrors, NO bathrooms',
      hotel_room: 'hotel room, neutral decor, bed or curtains in background. NO mirrors, NO bathrooms',
      convention_hallway: 'anime convention hallway, crowd blurred in background, banners visible',
      outdoor_park: 'outdoor park or sidewalk, trees and natural light',
      living_room: 'living room, couch or bookshelf in background, cozy indoor setting',
      studio_backdrop: 'simple solid-color backdrop, clean amateur studio setup',
    };
    const locationInstruction = location && locationMap[location]
      ? `ALL locations must be: ${locationMap[location]}. Do NOT vary the location.`
      : 'Vary locations across days: bedroom, hotel room, hallway, living room, plain wall, park, sidewalk. Keep them simple and amateur. NEVER use bathrooms or bathroom mirrors.';

    // Feature toggles
    const featureLines = [];
    if (opts.signaturePoses) {
      featureLines.push('SIGNATURE POSES: Each day\'s pose MUST match the character\'s iconic pose (e.g. Makima\'s "looking down" pose, Zero Two\'s heart hands, JoJo poses). Research and use the character\'s most recognizable pose.');
    }
    if (opts.propShots) {
      featureLines.push('PROP SHOTS: Include one bonus close-up/detail shot per day focusing on the character\'s signature prop or weapon (sword, staff, book, etc.).');
    }
    if (opts.beforeAfter) {
      featureLines.push('BEFORE/AFTER: For each day, include a "getting ready" shot — half-done makeup, wig being put on, costume pieces laid out on bed, alongside the finished cosplay shot.');
    }
    if (opts.tiktokReveal) {
      featureLines.push('TIKTOK REVEAL: Each day must have TWO shots — first a "civilian" outfit (casual clothes, no wig), then the full cosplay reveal. Frame as a transition/transformation.');
    }
    if (opts.conventionMode) {
      featureLines.push('CONVENTION MODE: Each day features MULTIPLE characters (outfit changes). Show convention hallway shots, food court breaks, and candid crowd moments between outfit changes.');
    }

    cosplayOutfitBlock = `

COSPLAY OUTFIT ASSIGNMENTS (use exactly these for each day):
${outfitLines}

${lewdnessBlock}
${styleBlock}

MANDATORY ACCESSORIES FOR EVERY DAY:
- Character-accurate cosplay WIG (match the character's ACTUAL hair color and style — NOT always vibrant) — this is NON-NEGOTIABLE
- Thigh-high stockings, fishnets, or knee-high socks — ALWAYS include leg accessories
- Choker or necklace
- Character-themed hair clips or headband

COSTUME LOCK RULE:
- The "costume_description" field MUST contain the EXACT outfit description with specific colors, materials, and pieces
- The "wig_description" field MUST describe the exact cosplay wig (color, length, style) matching the character — this is a wig placed OVER the model's natural hair, the model's face and body remain the SAME
- ALL images for a given day MUST use the IDENTICAL costume and wig — no variations between shots
- Be extremely specific: instead of "Makima outfit" write "black business blazer over white button-up shirt, black pencil skirt, black tie, black thigh-high stockings"

SHOT COMPOSITION (plan these into each day):
- Mix close-up shots (face + wig + upper body, showing expression and wig detail) AND full body shots
- MOST shots: camera held by someone else or on tripod — subject's hands are FREE for posing
- Occasional bedroom mirror selfie OK (max 1 per 3 days, bedroom mirror ONLY, no bathrooms)
- Poses: sitting on bed/floor, leaning against wall, hip-cocked standing, lying down, peace sign, hands in hair, looking over shoulder
- Expressions: VARY each shot — playful smirk, tongue out, pouty lips, looking up at camera, peace sign, laughing, looking away candidly, soft smile. Do NOT repeat the same expression across shots

LOCATION RULE: ${locationInstruction}
BANNED: bathrooms, showers, bathtubs. Bedroom mirrors OK sparingly.
Keep backgrounds SIMPLE and BORING — messy bedroom, plain wall, bed, hallway — so the cosplay pops.

The "lighting_style" must be: phone flash, warm bedroom lamp, window light, or overhead room light. Slightly warm tone. NOT professional studio lighting.
For each day, the "theme" field MUST include the character name and anime title.
Each day's vibe should match the character's personality — flirty, teasing, playful, confident.
${featureLines.length > 0 ? '\nFEATURE INSTRUCTIONS:\n' + featureLines.join('\n') : ''}`;
  }

  // For goth mode: research goth outfits and inject styling instructions
  if (selectedPersona === 'goth') {
    const { opts, lewdness, style, location, outfitCount } = _parseOutfitOptions(cosplayOptions);
    const outfits = await _researchGothOutfits(apiKey, outfitCount + 3, theme);
    const assignedOutfits = _groupOutfits(outfits, 'style', opts.groupTheme, outfitCount);
    const outfitLines = _buildOutfitLines(
      assignedOutfits, duration, opts.conventionMode,
      (o) => `${o.style} — ${o.outfit_description} (vibe: ${o.vibe || 'dark aesthetic'})`,
      (f) => `${f.style} — ${f.outfit_description}`,
    );

    // Lewdness tiers for goth
    let lewdnessBlock;
    if (lewdness <= 20) {
      lewdnessBlock = 'Outfit coverage: fully covered dark aesthetic. Long sleeves, pants or long skirt, modest neckline. Dark and stylish but not revealing.';
    } else if (lewdness <= 40) {
      lewdnessBlock = 'Outfit coverage: standard goth. Crop tops, mini skirts, bare shoulders OK. Showing some skin but not overtly sexual.';
    } else if (lewdness <= 60) {
      lewdnessBlock = 'Outfit coverage: sexy goth. Corsets, low-cut tops, short skirts, mesh/see-through elements, exposed midriff. Confident and provocative.';
    } else if (lewdness <= 80) {
      lewdnessBlock = 'Outfit coverage: very revealing dark aesthetic. Bralettes as tops, micro skirts, lingerie-adjacent outfits in black lace/leather. Strongly provocative.';
    } else {
      lewdnessBlock = 'Outfit coverage: lingerie goth. Dark lace lingerie, harness outfits, sheer bodysuits, garter sets — all in black/dark colors with goth accessories.';
    }

    // Style mapping for goth
    let styleBlock;
    if (style === 'sexy') {
      styleBlock = 'Goth interpretation: sexy/provocative. Push outfits toward more revealing, form-fitting, seductive versions.';
    } else if (style === 'casual') {
      styleBlock = 'Goth interpretation: casual dark streetwear. Hoodies, oversized tees, dark jeans — still goth-coded but relaxed and effortless.';
    } else {
      styleBlock = 'Goth interpretation: classic goth. Traditional dark fashion — corsets, lace, velvet, leather, platform boots. Statement pieces.';
    }

    // Goth location mapping
    const gothLocationMap = {
      urban_night: 'city street at night, neon signs or streetlights, urban backdrop. Flash photography encouraged',
      bar_club: 'dark bar or club interior, dim lighting, drinks visible, nightlife atmosphere',
      bedroom_dark: 'dark bedroom, fairy lights or candles, messy bed, moody ambient light',
      car_night: 'inside or leaning on car at night, dashboard lights or streetlight through windows',
      rooftop_city: 'rooftop with city skyline at night, urban landscape, wind in hair',
      alley_graffiti: 'dark alley or graffiti wall, urban gritty backdrop, direct flash',
      park_night: 'park or outdoor area at dusk/night, trees silhouetted, moody natural setting',
      mirror_selfie: 'bedroom full-length mirror, phone visible, dark room with warm accent light',
    };
    const locationInstruction = location && gothLocationMap[location]
      ? `ALL locations must be: ${gothLocationMap[location]}. Do NOT vary.`
      : 'Vary locations across days: city streets at night, dark bars, car interiors, dark bedrooms, rooftops, alleys, parks at dusk. Focus on NIGHTTIME and DARK settings.';

    // Goth feature toggles
    const featureLines = [];
    if (opts.signaturePoses) {
      featureLines.push('FLASH PHOTOGRAPHY: At least half the shots MUST use direct flash — overexposed flash-in-the-dark party style, like friends taking photos at night out.');
    }
    if (opts.propShots) {
      featureLines.push('ACCESSORY CLOSE-UPS: Include one bonus close-up per day of accessories — cross necklace detail, rings, chain belt, choker, boots, dark nail art.');
    }
    if (opts.beforeAfter) {
      featureLines.push('GETTING READY: For each day, include a "getting ready" shot — applying dark makeup, lacing up corset, putting on choker, outfit laid out on bed.');
    }
    if (opts.tiktokReveal) {
      featureLines.push('DAY → NIGHT TRANSITION: Each day shows TWO looks — a daytime casual dark outfit, then the full goth night-out look. Frame as a transformation.');
    }
    if (opts.conventionMode) {
      featureLines.push('MULTI OUTFIT: Each day features MULTIPLE outfit changes. Show different goth subgenres within the same day.');
    }

    cosplayOutfitBlock = `

BODY PROPORTIONS — CRITICAL:
- The subject's body proportions MUST match the reference image(s) EXACTLY.
- Do NOT exaggerate bust, waist, hips, or any body feature. Keep proportions REALISTIC and faithful to the reference person.
- The outfit should fit the person's REAL body, not an idealized version.

GOTH OUTFIT ASSIGNMENTS (use exactly these for each day):
${outfitLines}

${lewdnessBlock}
${styleBlock}

ACCESSORIES: cross necklace or choker, chains, dark nails, platform/combat boots, fishnets. Include in costume_description.

OUTFIT LOCK RULE:
- "costume_description": EXACT outfit with pieces, colors, materials. Be specific.
- "wig_description": hair styling (dark hair, bangs style, etc.)
- ALL shots in a day use IDENTICAL outfit.

SHOT COMPOSITION:
- Mix close-up and full body. Friend-taken photos, flash at night.
- Expressions: VARY — pouty, tongue out, smirking, deadpan, rock horns, peace sign. Do NOT repeat.

LOCATION RULE: ${locationInstruction}
Lighting: flash at night, neon, bar/club, fairy lights, streetlight. Moody. NOT daylight unless specified.
Theme field MUST include the goth substyle. Vibe: edgy, confident, dark energy.
${featureLines.length > 0 ? '\nFEATURE INSTRUCTIONS:\n' + featureLines.join('\n') : ''}`;
  }

  const prompt = `${BASE_SYSTEM_PROMPT}

[PERSONA]
${personaSection}

[RULES]
Solo female subject only. No couples, no male interaction, no explicit content.
${cosplayOutfitBlock}

Theme: ${theme}
Duration: ${duration} days
Balance: vary poses, settings, and energy across days — no repetitive compositions.

Return JSON: { location_core: string, aesthetic_keywords: string[], days: DayPlan[] }`;

  const rawText = await geminiService.generateText(apiKey, prompt, {
    temperature: 0.3,
    responseMimeType: 'application/json',
  });

  const cleaned = String(rawText).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

  try {
    return JSON.parse(cleaned);
  } catch {
    throw new AppError('Failed to parse weekly plan JSON from Gemini response', 502, 'PARSE_ERROR');
  }
}

module.exports = {
  generateWeeklyPlan,
};
