/**
 * Pull the clip length out of a pose's video prompt.
 *
 * Ported from server/services/runVideo.js's parseDurationSeconds — same regex, same default —
 * so the Eddy Generate page can show the real duration (and the real per-video cost) on the
 * Generate button BEFORE anything is sent to the server, instead of guessing and then having the
 * server compute a different number. Keep the two in sync if the prompt template changes.
 */

const DEFAULT_DURATION_SECONDS = 6;

/**
 * The prompt template writes duration as an explicit line, e.g. "Duration: exactly 6 seconds",
 * separate from any "N seconds" phrasing inside the story beats themselves (a beat like "she
 * turns for 2 seconds" describes timing WITHIN the clip, not the clip's total length). Matching
 * only text that follows the literal "Duration:" label — and never crossing a newline while
 * looking for the number — is what keeps a beat's incidental "N seconds" from being picked up
 * instead of the real duration.
 */
export function parseDurationSeconds(videoPrompt) {
  const m = String(videoPrompt || '').match(/Duration:\s*[^\n]*?(\d+)\s*seconds?/i);
  return m ? Number(m[1]) : DEFAULT_DURATION_SECONDS;
}
