const { AppError } = require('../middleware/errorHandler');

const DEFAULT_ASPECT_RATIO = '1:1';
const DEFAULT_RESOLUTION_TIER = '2K';

const DIMENSION_TABLE = {
  '1K': {
    '1:1': { width: 1024, height: 1024 },
    '16:9': { width: 1344, height: 768 },
    '9:16': { width: 768, height: 1344 },
    '4:3': { width: 1152, height: 864 },
    '3:4': { width: 864, height: 1152 },
    '4:5': { width: 832, height: 1024 },
  },
  '2K': {
    '1:1': { width: 2048, height: 2048 },
    '16:9': { width: 2560, height: 1440 },
    '9:16': { width: 1440, height: 2560 },
    '4:3': { width: 2048, height: 1536 },
    '3:4': { width: 1536, height: 2048 },
    '4:5': { width: 1600, height: 2000 },
  },
  '4K': {
    '1:1': { width: 3840, height: 3840 },
    '16:9': { width: 3840, height: 2160 },
    '9:16': { width: 2160, height: 3840 },
    '4:3': { width: 3200, height: 2400 },
    '3:4': { width: 2400, height: 3200 },
    '4:5': { width: 2880, height: 3600 },
  },
};

function resolveDimensions({ aspectRatio, resolutionTier } = {}) {
  const resolvedAspectRatio = aspectRatio === undefined || aspectRatio === null
    ? DEFAULT_ASPECT_RATIO
    : aspectRatio;
  const resolvedResolutionTier = resolutionTier === undefined || resolutionTier === null
    ? DEFAULT_RESOLUTION_TIER
    : resolutionTier;

  if (typeof resolvedAspectRatio !== 'string') {
    throw new AppError('"aspectRatio" must be a string', 400, 'VALIDATION_ERROR');
  }
  if (typeof resolvedResolutionTier !== 'string') {
    throw new AppError('"resolutionTier" must be a string', 400, 'VALIDATION_ERROR');
  }

  const tier = resolvedResolutionTier.trim().toUpperCase();
  const ratio = resolvedAspectRatio.trim();

  const tierTable = DIMENSION_TABLE[tier];
  if (!tierTable) {
    throw new AppError(
      '"resolutionTier" must be one of: 1K, 2K, 4K',
      400,
      'VALIDATION_ERROR'
    );
  }

  const dims = tierTable[ratio];
  if (!dims) {
    throw new AppError(
      '"aspectRatio" must be one of: 1:1, 16:9, 9:16, 4:3, 3:4, 4:5',
      400,
      'VALIDATION_ERROR'
    );
  }

  return {
    aspectRatio: ratio,
    resolutionTier: tier,
    width: dims.width,
    height: dims.height,
  };
}

module.exports = { resolveDimensions };
