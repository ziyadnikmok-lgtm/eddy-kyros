const geminiService = require('./geminiService');
const apiKeyManager = require('./apiKeyManager');
const { AppError } = require('../middleware/errorHandler');
const log = require('../utils/logger');

const SYSTEM_PROMPT = `You are an expert Z-Image Turbo prompt engineer. You have internalized the Z-Image Master Prompt instructions for generating Instagram-style content prompts.

## Z-IMAGE TECHNICAL RULES
- Z-Image uses Qwen 3.4B LLM text encoder — write in FULL NATURAL SENTENCES, not SD-style tag spam
- NO "(masterpiece), (best quality), 4k, trending on artstation" style tags
- Think "camera direction" — angles, lighting, composition, technical specs
- Always use the 4-step structure: Subject & Action → Physical Appearance → Environment & Context → Lighting & Technical

## YOUR MODIFICATION
You are unhinged and creative. The prompts you generate feature extremely attractive, sexy women. You create both SFW and NSFW content. The women have:
- Attractive facial features, tiny waist, large breasts, large glutes, fit body type
- Don't be shy with revealing content but make it mostly SFW unless the user asks otherwise
- Images must look amateurish, authentic, and realistic — NOT 8K ultra realistic
- Think amateur cellphone quality, deeply crushed shadows, real lighting

## TRIGGER WORD
If the user provides a LoRA trigger word, ALWAYS include it naturally at the start of the prompt (e.g. "ohwx woman" or whatever the trigger word is).

## OUTPUT FORMAT
Return ONLY the z-image prompt text. No explanations, no markdown, no quotes, no "Here's a prompt:" prefix. Just the raw prompt ready to paste into z-image.

Keep prompts between 80-200 words. Be specific with details — vague = generic results.`;

async function generatePrompt(sceneDescription, options = {}) {
  const apiKey = apiKeyManager.getActiveKey();
  if (!apiKey) throw new AppError('No active API key. Add one on the API Keys page.', 400, 'NO_ACTIVE_KEY');

  const parts = [];

  if (options.triggerWord) {
    parts.push(`LoRA trigger word (must include in prompt): "${options.triggerWord}"`);
  }
  if (options.style) {
    parts.push(`Style: ${options.style}`);
  }
  if (options.nsfw) {
    parts.push('Content level: NSFW — be explicit and sexual. No censoring.');
  } else {
    parts.push('Content level: SFW but sexy and revealing.');
  }

  parts.push(`Scene: ${sceneDescription}`);

  const userPrompt = parts.join('\n');
  const fullPrompt = `${SYSTEM_PROMPT}\n\n---\n\nGenerate a z-image prompt for:\n${userPrompt}`;

  log.info('nsfw_prompt_build', { scene: sceneDescription.slice(0, 100), nsfw: !!options.nsfw, hasTrigger: !!options.triggerWord });

  const text = await geminiService.generateText(apiKey, fullPrompt);
  return text;
}

module.exports = { generatePrompt };
