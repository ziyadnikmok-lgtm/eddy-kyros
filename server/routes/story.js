const express = require('express');
const carouselStoryteller = require('../services/carouselStoryteller');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();

router.post('/generate', async (req, res, next) => {
  try {
    const validRatios = ['1:1', '16:9', '9:16', '4:3', '3:4', '4:5'];
    const validSizes = ['1K', '2K', '4K'];

    const finalAspectRatio =
      validRatios.includes(req.body.aspectRatio)
        ? req.body.aspectRatio
        : '1:1';

    const finalImageSize =
      validSizes.includes(req.body.resolutionTier)
        ? req.body.resolutionTier
        : '1K';

    if (req.body.aspectRatio !== undefined && typeof req.body.aspectRatio !== 'string') {
      throw new AppError('"aspectRatio" must be a string', 400, 'VALIDATION_ERROR');
    }
    if (req.body.resolutionTier !== undefined && typeof req.body.resolutionTier !== 'string') {
      throw new AppError('"resolutionTier" must be a string', 400, 'VALIDATION_ERROR');
    }

    const result = await carouselStoryteller.generateCarouselStory({
      ...req.body,
      aspectRatio: finalAspectRatio,
      resolutionTier: finalImageSize,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
