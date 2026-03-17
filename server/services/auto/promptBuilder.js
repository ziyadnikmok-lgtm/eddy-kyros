function asText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return '';

  if (typeof value.description === 'string') return value.description.trim();
  if (typeof value.text === 'string') return value.text.trim();
  if (typeof value.value === 'string') return value.value.trim();

  return JSON.stringify(value);
}

function buildFinalPrompt({ dayPlan, pose, location, personaMode }) {
  const safeDayPlan = dayPlan || {};
  const sections = [];

  // Use the planner's location_description as the authoritative scene (consistent per day).
  // Only fall back to sampled character location if planner didn't provide one.
  const locationDesc = asText(safeDayPlan.location_description);
  const locationText = asText(location);
  const scene = locationDesc || locationText;
  if (scene) sections.push(`Scene: ${scene}`);

  const lighting = asText(safeDayPlan.lighting_style);
  if (lighting) sections.push(`Lighting: ${lighting}`);

  const poseText = asText(pose);
  if (poseText) sections.push(`Pose direction: ${poseText}`);

  const vibe = asText(safeDayPlan.vibe);
  if (vibe) sections.push(`Vibe: ${vibe}`);

  const theme = asText(safeDayPlan.theme);
  if (theme) sections.push(`Theme context: ${theme}`);

  const timeOfDay = asText(safeDayPlan.time_of_day);
  if (timeOfDay) sections.push(`Time of day: ${timeOfDay}`);

  // Cosplay mode: inject locked costume + wig + aesthetic reminders into every prompt
  if (personaMode === 'cosplay') {
    const costumeDesc = asText(safeDayPlan.costume_description);
    const wigDesc = asText(safeDayPlan.wig_description);
    if (costumeDesc) sections.push(`COSTUME LOCK (wear this EXACT outfit): ${costumeDesc}`);
    if (wigDesc) sections.push(`WIG LOCK (MANDATORY cosplay wig placed over natural hair — SAME person, different hair only): ${wigDesc}`);
    sections.push('Style: casual cosplay influencer, mostly photos taken by friend/tripod, occasional mirror selfie OK');
    sections.push('MANDATORY: thigh-high stockings or fishnets, choker');
    sections.push('Expression: varied — pick ONE per shot: flirty smirk, playful grin, teasing look, tongue out, peace sign, looking over shoulder, pouty lips, laughing, looking away candidly');
    sections.push('Quality: iPhone camera, slightly warm, natural/warm lighting, NOT studio');
    sections.push('BANNED: NO bathrooms, NO bathroom mirrors, NO showers. Bedroom mirrors OK sparingly');
  }

  // Goth mode: inject outfit lock + dark aesthetic reminders into every prompt
  if (personaMode === 'goth') {
    const costumeDesc = asText(safeDayPlan.costume_description);
    const wigDesc = asText(safeDayPlan.wig_description);
    sections.push('BODY PROPORTIONS: Keep the EXACT body proportions from the reference image(s). Do NOT alter bust size, waist, hips, or limb proportions. The person must look like a REAL human with the SAME body as the reference.');
    if (costumeDesc) sections.push(`OUTFIT: ${costumeDesc}`);
    if (wigDesc) sections.push(`HAIR: ${wigDesc}`);
    sections.push('Style: goth/alt girl, friend-taken photos, flash at night, candid energy');
    sections.push('Accessories: cross necklace or choker, chains, fishnets, dark nails');
    sections.push('Expression: varied — pick ONE: pouty, tongue out, smirking, deadpan, rock horns, peace sign, looking away');
    sections.push('Quality: iPhone, flash at night or moody ambient. NOT studio');
  }

  if (sections.length === 0) return 'Natural candid scene, authentic energy';
  return sections.join('\n');
}

module.exports = {
  buildFinalPrompt,
};
