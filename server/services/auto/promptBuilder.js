function asText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return '';

  if (typeof value.description === 'string') return value.description.trim();
  if (typeof value.text === 'string') return value.text.trim();
  if (typeof value.value === 'string') return value.value.trim();

  return JSON.stringify(value);
}

function buildFinalPrompt({ dayPlan, pose, location, personaMode, backgroundLocked = false }) {
  const safeDayPlan = dayPlan || {};
  const sections = [];

  // Scene — skip when background ref image defines it
  if (!backgroundLocked) {
    const locationDesc = asText(safeDayPlan.location_description);
    const locationText = asText(location);
    const scene = locationDesc || locationText;
    if (scene) sections.push(`Scene: ${scene}`);

    const lighting = asText(safeDayPlan.lighting_style);
    if (lighting) sections.push(`Lighting: ${lighting}`);
  }

  const poseText = asText(pose);
  if (poseText) sections.push(`Pose: ${poseText}`);

  const vibe = asText(safeDayPlan.vibe);
  if (vibe) sections.push(`Vibe: ${vibe}`);

  // Cosplay mode — outfit details handled by OUTFIT LOCK section, keep this minimal
  if (personaMode === 'cosplay') {
    const costumeDesc = asText(safeDayPlan.costume_description);
    const wigDesc = asText(safeDayPlan.wig_description);
    // Describe outfit without repeating character name (prevents identity drift)
    if (costumeDesc) sections.push(`Cosplay outfit: ${costumeDesc}`);
    if (wigDesc) sections.push(`Wig: ${wigDesc}`);
    sections.push('Candid iPhone photo, friend-taken or tripod. Thigh-highs or fishnets, choker.');

    if (backgroundLocked) {
      const colorSource = costumeDesc || asText(safeDayPlan.theme) || 'the outfit';
      sections.push(`LED room — shift LED hue to complement ${colorSource}. Light reflects naturally on skin and outfit.`);
    }
  }

  // Goth mode — same minimal approach
  if (personaMode === 'goth') {
    const costumeDesc = asText(safeDayPlan.costume_description);
    const wigDesc = asText(safeDayPlan.wig_description);
    if (costumeDesc) sections.push(`Outfit: ${costumeDesc}`);
    if (wigDesc) sections.push(`Hair: ${wigDesc}`);
    sections.push('Candid iPhone photo, friend-taken. Fishnets, choker, dark nails.');

    if (backgroundLocked) {
      const colorSource = costumeDesc || asText(safeDayPlan.theme) || 'the outfit';
      sections.push(`LED room — shift LED hue to complement ${colorSource}. Light reflects naturally on skin and outfit.`);
    }
  }

  if (sections.length === 0) return 'Natural candid scene, authentic energy';
  return sections.join('\n');
}

module.exports = {
  buildFinalPrompt,
};
