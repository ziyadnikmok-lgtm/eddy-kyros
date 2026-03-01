function asText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return '';

  if (typeof value.description === 'string') return value.description.trim();
  if (typeof value.text === 'string') return value.text.trim();
  if (typeof value.value === 'string') return value.value.trim();

  return JSON.stringify(value);
}

function buildFinalPrompt({ dayPlan, pose, location }) {
  const safeDayPlan = dayPlan || {};
  const sections = [];

  const locationText = asText(location);
  const locationDesc = asText(safeDayPlan.location_description);
  const scene = locationText || locationDesc;
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

  if (sections.length === 0) return 'Natural candid scene, authentic energy';
  return sections.join('\n');
}

module.exports = {
  buildFinalPrompt,
};
