function asText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return '';

  if (typeof value.description === 'string') return value.description.trim();
  if (typeof value.text === 'string') return value.text.trim();
  if (typeof value.value === 'string') return value.value.trim();

  return JSON.stringify(value);
}

/**
 * Build a Nano-Banana structured scene prompt for auto generation.
 *
 * Outputs ONLY scene/environment context — identity, outfit, camera, and
 * expression are handled by the batch generator's dedicated sections.
 *
 * @param {object} params
 * @param {object} params.dayPlan - Day plan from the weekly planner
 * @param {string|object} params.pose - Pose directive for this image
 * @param {string|object} params.location - Location/scene description
 * @returns {string} Nano-Banana structured scene prompt
 */
function buildFinalPrompt({ dayPlan, pose, location }) {
  const safeDayPlan = dayPlan || {};
  const sections = [];

  // SCENE/ENVIRONMENT — setting the stage
  const locationText = asText(location);
  const locationDesc = asText(safeDayPlan.location_description);
  const scene = locationText || locationDesc;
  if (scene) sections.push(`Scene: ${scene}`);

  // LIGHTING — from day plan
  const lighting = asText(safeDayPlan.lighting_style);
  if (lighting) sections.push(`Lighting: ${lighting}`);

  // POSE — directive positioning
  const poseText = asText(pose);
  if (poseText) sections.push(`Pose direction: ${poseText}`);

  // VIBE — mood and energy
  const vibe = asText(safeDayPlan.vibe);
  if (vibe) sections.push(`Vibe: ${vibe}`);

  // THEME — narrative context
  const theme = asText(safeDayPlan.theme);
  if (theme) sections.push(`Theme context: ${theme}`);

  // TIME OF DAY
  const timeOfDay = asText(safeDayPlan.time_of_day);
  if (timeOfDay) sections.push(`Time of day: ${timeOfDay}`);

  if (sections.length === 0) return 'Natural candid scene, authentic energy';
  return sections.join('\n');
}

module.exports = {
  buildFinalPrompt,
};
