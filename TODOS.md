# TODOS

## P2: Image Editor — Crop & Rotate
**What:** Add crop (with aspect ratio presets: 1:1, 4:5, 16:9, free) and rotate (90° increments + free rotation slider) to the image editor.
**Why:** The two most-used photo operations after color correction. Without them, users still need external tools for basic image preparation.
**Effort:** M (human: ~1 week / CC: ~30min)
**Depends on:** Image editor base (must ship first)
**Context:** Crop UI needs a draggable rectangle overlay with resize handles + aspect ratio lock. Rotate needs Sharp `rotate()` in the worker. The accepted worker pool architecture supports this cleanly — just add params.

## P2: Budget Configuration UI
**What:** Add a budget amount input field to the API Keys page so users can set their own spend limit per key.
**Why:** Users with different usage patterns need different budgets. A heavy user might want $500, a cautious user might want $50. Currently hardcoded at $300 with no way to change it.
**Effort:** S (human: ~2hr / CC: ~5min)
**Depends on:** Spend tracking (shipped)
**Context:** `apiKeyManager` already stores `spendBudgetUsd` per key. Just needs a setter method + route + UI input on the ApiKeysPage spend card.

## P3: Image Editor — Worker & Route Tests
**What:** Add vitest tests for `imageEditWorker.js` (each processing stage with a small test fixture) and `POST /gallery/:id/edit` route (clamping, save mode, worker lifecycle).
**Why:** The worker does pixel-level manipulation with 8 processing stages. The route has input validation, worker lifecycle (spawn, timeout, cancel), and two output modes. Zero test coverage currently.
**Effort:** M (human: ~1 week / CC: ~20min)
**Depends on:** Image editor base (shipped)
**Context:** Test harness (vitest) already exists. Worker can be tested by importing and passing workerData with a small test fixture PNG. Route tests need gallery manager mock. Tests should verify "output is a valid PNG with correct dimensions" rather than visual quality.

## P2: AI Upscaling (4K→ 8K+)
**What:** Add one-click 'Enhance' button on any gallery image. 2x and 4x AI upscale via WaveSpeed or Gemini upscale API. Saves as new gallery entry linked to original.
**Why:** Gemini generates at max ~2K resolution. For print, merch, or high-res platform uploads, creators need bigger. AI upscaling adds detail and sharpness beyond simple interpolation.
**Effort:** M (human: ~3 days / CC: ~20min)
**Depends on:** WaveSpeed integration (already exists), Gallery save infrastructure (exists)
**Context:** WaveSpeed has upscale endpoints. Alternative: Real-ESRGAN via local Sharp pipeline. Gallery already supports parent-child image relationships (imageStore.js). New gallery entry should link back to original via `parentId`. Add 'Enhance' button to gallery lightbox + grid context menu.

## P2: AI Inpainting via Mask-Composite
**What:** Draw or upload a mask on any gallery image, extract the masked region, send to Gemini for regeneration with a user prompt, composite the result back onto the original using Sharp.
**Why:** Fix bad hands, swap outfits, change backgrounds — without regenerating the entire image. The #1 most-requested feature in AI image generation.
**Effort:** M (human: ~4 days / CC: ~25min)
**Depends on:** Nothing (standalone). Builds on existing image editor + Gemini + Sharp.
**Context:** Gemini lacks native mask-based inpainting API. The viable approach is: (1) use mask to crop the region + surrounding context, (2) send cropped region to Gemini with regeneration prompt, (3) composite result back onto original with Sharp. Needs a brush/lasso canvas overlay in ImageEditor.jsx. The existing worker pool pattern can handle the Sharp compositing step. Save result as new gallery entry with `parentId` link to original.

## P3: Spend Export/Import
**What:** Add export (JSON download) and import (JSON upload) buttons to the spend section of API Keys page.
**Why:** Useful for users who track expenses or switch between machines. Data is already JSON on disk.
**Effort:** S (human: ~1hr / CC: ~5min)
**Depends on:** Spend tracking (shipped)
**Context:** `getSpendInfo()` already returns all needed data. Export is trivial (JSON.stringify + download). Import needs validation to prevent corrupted data.
