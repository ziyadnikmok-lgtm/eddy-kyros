const { AppError } = require('../../middleware/errorHandler');
const apiKeyManager = require('../apiKeyManager');
const geminiService = require('../geminiService');

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

Do NOT generate image prompts.
Do NOT mention aspect ratios.
Keep descriptions short and cinematic.`;

async function generateWeeklyPlan({ theme, duration, personaMode, customPersona, spicinessLevel }) {
  const selectedPersona = personaInstructions[personaMode] ? personaMode : 'luxury';
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

  const prompt = `${BASE_SYSTEM_PROMPT}

Persona Mode Instructions:
${personaSection}

Relational rules:
- Single female subject only
- No couples
- No male interaction
- No holding hands
- Background extras allowed but no interaction
- No explicit sexual acts
- No graphic nudity
- No sexual interaction with others

Theme: ${theme}
Duration: ${duration} days

Return format:

{
  location_core: string,
  aesthetic_keywords: string[],
  days: DayPlan[]
}`;

  const apiKey = apiKeyManager.getActiveKey();
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
