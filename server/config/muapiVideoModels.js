// Shared so routes/video.js and services/videoReconciler.js can't drift apart on pricing.
// (videoReconciler can't require the route — that would be circular.)
const MUAPI_VIDEO_MODELS = new Set(['seedance-2-fast', 'seedance-2-vip']);

// Omni Reference jobs are submitted by routes/seedanceOmni.js but polled through the video
// pipeline (they're stored with provider 'muapi'), so their rates must live here or spend
// tracks as $0. Rates from Muapi's public pricing page.
const MUAPI_PRICE_PER_SECOND = {
  'seedance-2-fast': 0.15,
  'seedance-2-vip': 0.21,
  'omni-fast': 0.21,
  'omni-best': 0.30,
  'omni-fast-1080p': 0.4725,
  'omni-1080p': 0.675,
  'omni-4k': 1.35,
};

module.exports = { MUAPI_VIDEO_MODELS, MUAPI_PRICE_PER_SECOND };
