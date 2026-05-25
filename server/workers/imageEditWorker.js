const { parentPort, workerData } = require('node:worker_threads');
const sharp = require('sharp');

async function processImage() {
  const {
    filePath, brightness, contrast, saturation, warmth, sharpness, grain,
    vignette, fade, hueShift, rgbSplitDistance, rgbSplitDirection, rgbSplitColor,
  } = workerData;

  const normalizedInput = await sharp(filePath).rotate().toBuffer();
  let pipeline = sharp(normalizedInput);
  const meta = await sharp(normalizedInput).metadata();
  const w = meta.width || 1024;
  const h = meta.height || 1024;

  if (brightness !== 0 || contrast !== 0) {
    const a = 1 + contrast / 100;
    const b = (brightness / 100) * 128;
    pipeline = pipeline.linear(a, b);
  }

  if (saturation !== 0 || hueShift !== 0) {
    pipeline = pipeline.modulate({
      ...(saturation !== 0 && { saturation: 1 + saturation / 100 }),
      ...(hueShift !== 0 && { hue: hueShift }),
    });
  }

  if (sharpness > 0) {
    const sigma = 0.5 + (sharpness / 100) * 1.5;
    pipeline = pipeline.sharpen({ sigma });
  }

  if (fade > 0) {
    const gamma = 1 + (fade / 100) * 0.8;
    pipeline = pipeline.gamma(gamma);
  }

  let outputBuf = await pipeline.png({ compressionLevel: 4 }).toBuffer();

  // Warmth overlay
  if (warmth !== 0) {
    const absW = Math.abs(warmth);
    const opacity = Math.min(0.25, (absW / 100) * 0.25);
    const r = warmth > 0 ? 255 : 100;
    const g = warmth > 0 ? 160 : 140;
    const b2 = warmth > 0 ? 60 : 255;
    const warmSvg = `<svg width="${w}" height="${h}"><rect width="100%" height="100%" fill="rgba(${r},${g},${b2},${opacity})"/></svg>`;
    outputBuf = await sharp(outputBuf)
      .composite([{ input: Buffer.from(warmSvg), blend: 'over' }])
      .png({ compressionLevel: 4 })
      .toBuffer();
  }

  // Grain
  if (grain > 0) {
    // Film grain: RGB noise centered at 128 (neutral gray) with Gaussian-like distribution
    // Overlay blend at 128 = no change, >128 = lighten, <128 = darken — natural grain look
    const intensity = (grain / 100) * 120 + 15;
    const noiseBuf = Buffer.alloc(w * h * 3);
    for (let i = 0; i < noiseBuf.length; i += 3) {
      // Box-Muller approximation: average of multiple randoms → bell curve
      const r1 = (Math.random() + Math.random() + Math.random()) / 3;
      const r2 = (Math.random() + Math.random() + Math.random()) / 3;
      const r3 = (Math.random() + Math.random() + Math.random()) / 3;
      noiseBuf[i]     = Math.max(0, Math.min(255, 128 + (r1 - 0.5) * intensity * 2));
      noiseBuf[i + 1] = Math.max(0, Math.min(255, 128 + (r2 - 0.5) * intensity * 2));
      noiseBuf[i + 2] = Math.max(0, Math.min(255, 128 + (r3 - 0.5) * intensity * 2));
    }
    const noiseImg = await sharp(noiseBuf, { raw: { width: w, height: h, channels: 3 } })
      .png()
      .toBuffer();
    outputBuf = await sharp(outputBuf)
      .composite([{ input: noiseImg, blend: 'overlay' }])
      .png({ compressionLevel: 4 })
      .toBuffer();
  }

  // Vignette
  if (vignette > 0) {
    const strength = (vignette / 100) * 0.7;
    const svg = `<svg width="${w}" height="${h}">
      <defs>
        <radialGradient id="v" cx="50%" cy="50%" r="70%">
          <stop offset="50%" stop-color="black" stop-opacity="0"/>
          <stop offset="100%" stop-color="black" stop-opacity="${strength}"/>
        </radialGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#v)"/>
    </svg>`;
    outputBuf = await sharp(outputBuf)
      .composite([{ input: Buffer.from(svg), blend: 'multiply' }])
      .png({ compressionLevel: 4 })
      .toBuffer();
  }

  // RGB Split
  if (rgbSplitDistance > 0) {
    const colorSchemes = {
      rc: { ch1: [1, 0, 0], ch2: [0, 1, 1] },
      rb: { ch1: [1, 0, 0], ch2: [0, 0, 1] },
      gm: { ch1: [0, 1, 0], ch2: [1, 0, 1] },
      gb: { ch1: [0, 1, 0], ch2: [0, 0, 1] },
      yo: { ch1: [1, 0, 0], ch2: [0, 1, 0] },
      cb: { ch1: [0, 0, 1], ch2: [0, 1, 0] },
    };
    const scheme = colorSchemes[rgbSplitColor] || colorSchemes.rc;
    const rad = (rgbSplitDirection * Math.PI) / 180;
    const dx = Math.round(Math.cos(rad) * rgbSplitDistance);
    const dy = Math.round(Math.sin(rad) * rgbSplitDistance);

    const { data: rawData, info } = await sharp(outputBuf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = new Uint8Array(rawData);
    const result = new Uint8Array(pixels.length);
    const pw = info.width;
    const ph = info.height;

    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const idx = (y * pw + x) * 4;
        const fx = Math.min(pw - 1, Math.max(0, x + dx));
        const fy = Math.min(ph - 1, Math.max(0, y + dy));
        const fi = (fy * pw + fx) * 4;
        const bx = Math.min(pw - 1, Math.max(0, x - dx));
        const by = Math.min(ph - 1, Math.max(0, y - dy));
        const bi = (by * pw + bx) * 4;

        result[idx]     = scheme.ch1[0] ? pixels[fi]     : scheme.ch2[0] ? pixels[bi]     : pixels[idx];
        result[idx + 1] = scheme.ch1[1] ? pixels[fi + 1] : scheme.ch2[1] ? pixels[bi + 1] : pixels[idx + 1];
        result[idx + 2] = scheme.ch1[2] ? pixels[fi + 2] : scheme.ch2[2] ? pixels[bi + 2] : pixels[idx + 2];
        result[idx + 3] = pixels[idx + 3];
      }
    }

    outputBuf = await sharp(Buffer.from(result), { raw: { width: pw, height: ph, channels: 4 } })
      .png({ compressionLevel: 4 })
      .toBuffer();
  }

  parentPort.postMessage(outputBuf);
}

processImage().catch((err) => {
  parentPort.postMessage({ error: err.message });
});
