// server/config.js
// Centralized configuration constants. Tune values here instead of
// hunting through individual service files.

module.exports = {
  // ── Server ──────────────────────────────────────────────────────────
  PORT: parseInt(process.env.PORT, 10) || 3001,
  HOST: process.env.HOST || 'localhost',
  JSON_BODY_LIMIT: '20mb',
  SHUTDOWN_TIMEOUT_MS: 10_000,

  // ── Timeouts ────────────────────────────────────────────────────────
  GEMINI_GENERATE_TIMEOUT_MS: 120_000,  // 2 min — image generation
  GEMINI_TEXT_TIMEOUT_MS: 60_000,       // 1 min — text-only calls
  ROUTE_TIMEOUT_MS: 5 * 60_000,        // 5 min — clone/reel hard ceiling
  HEALTH_CHECK_TIMEOUT_MS: 12_000,
  IMAGE_DOWNLOAD_TIMEOUT_MS: 60_000,
  HTML_FETCH_TIMEOUT_MS: 45_000,
  VIDEO_DOWNLOAD_TIMEOUT_MS: 120_000,
  FFMPEG_TIMEOUT_MS: 30_000,
  SLOW_REQUEST_THRESHOLD_MS: 10_000,

  // ── Retries ─────────────────────────────────────────────────────────
  GEMINI_TRANSIENT_RETRIES: 2,
  GEMINI_TRANSIENT_BASE_MS: 1000,
  GEMINI_EMPTY_RESPONSE_MAX_ATTEMPTS: 3,
  GEMINI_EMPTY_RESPONSE_BASE_MS: 250,
  IMAGE_DOWNLOAD_MAX_ATTEMPTS: 3,
  IMAGE_DOWNLOAD_BACKOFF_BASE_MS: 500,

  // ── File-size limits ────────────────────────────────────────────────
  MAX_REFERENCE_BYTES: 10 * 1024 * 1024,  // 10 MB
  MAX_UPLOAD_BYTES: 10 * 1024 * 1024,     // 10 MB (multer)
  MAX_MULTIPART_BYTES: 50 * 1024 * 1024,  // 50 MB
  MAX_VIDEO_UPLOAD_BYTES: 200 * 1024 * 1024, // 200 MB
  MAX_STORE_BYTES: 500 * 1024 * 1024,     // 500 MB in-memory cap

  // ── Batch / concurrency ─────────────────────────────────────────────
  BATCH_MAX_CONCURRENCY: 5,
  BATCH_MAX_SIZE: 20,
  BATCH_MAX_RUNNING_JOBS: 3,
  MAX_BATCH_PROMPTS: 20,
  MAX_AUTO_DURATION_DAYS: 30,

  // ── TTL / cache ─────────────────────────────────────────────────────
  IMAGE_TTL_MS: 60 * 60 * 1000,            // 1 hour
  IMAGE_CLEANUP_INTERVAL_MS: 10 * 60 * 1000, // 10 min
  BATCH_JOB_TTL_MS: 7 * 24 * 60 * 60 * 1000, // 7 days (history)
  BATCH_CLEANUP_INTERVAL_MS: 5 * 60 * 1000,  // 5 min
  HEALTH_CACHE_TTL_MS: 30_000,              // 30 s
  AVAILABILITY_CACHE_TTL_MS: 60_000,        // 60 s
  STALE_TEMP_FILE_AGE_MS: 60 * 60 * 1000,  // 1 hour

  // ── Content limits ──────────────────────────────────────────────────
  PROMPT_MAX_LENGTH: 10_000,
  API_KEY_MAX_LENGTH: 200,
  MAX_CAROUSEL_SLIDES: 10,
  MAX_HASHTAGS: 25,
  DEFAULT_HASHTAG_COUNT: 15,

  // ── Gemini cache ────────────────────────────────────────────────────
  GEMINI_CLIENT_CACHE_SIZE: 5,
  AVAILABILITY_CACHE_MAX_SIZE: 100,
};
