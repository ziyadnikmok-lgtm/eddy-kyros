import { useState, useRef, useCallback } from 'react';
import { blurRegion } from '../lib/blurRegion';
import { Btn, Spinner } from './UI';

/**
 * Drag a box over the part of a photo to destroy — the manual fallback for when the automatic
 * face detector (pico.js) finds nothing. Seedream anchors on any visible face, so a source photo
 * whose face was missed drags the stand-in's identity into the result; this lets you blur it by
 * hand instead of shipping it.
 *
 * The box is tracked in FRACTIONS of the displayed image (0..1) so it maps straight onto
 * blurRegion's coordinate system regardless of the image's real pixel size or how it's scaled to
 * fit the modal.
 *
 * @param {string}   src        the image data URL to blur
 * @param {Function} onApply    (newDataUrl) => void — called with the blurred image
 * @param {Function} onClose    () => void
 */
export default function ManualBlurModal({ src, onApply, onClose }) {
  const [box, setBox] = useState(null);      // {x,y,w,h} fractions, or null
  const [drag, setDrag] = useState(null);    // {x,y} start point while dragging
  const [busy, setBusy] = useState(false);
  const imgRef = useRef(null);

  // Pointer position as a fraction of the image box, clamped to [0,1] so a drag off the edge
  // still yields a valid rectangle.
  const frac = useCallback((e) => {
    const r = imgRef.current.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  }, []);

  const onDown = (e) => { e.preventDefault(); const p = frac(e); setDrag(p); setBox({ x: p.x, y: p.y, w: 0, h: 0 }); };
  const onMove = (e) => {
    if (!drag) return;
    const p = frac(e);
    setBox({ x: Math.min(drag.x, p.x), y: Math.min(drag.y, p.y), w: Math.abs(p.x - drag.x), h: Math.abs(p.y - drag.y) });
  };
  const onUp = () => setDrag(null);

  const apply = async () => {
    if (!box || box.w < 0.02 || box.h < 0.02) return;
    setBusy(true);
    try {
      const out = await blurRegion(src, box);
      onApply(out);
    } finally {
      setBusy(false);
    }
  };

  const bigEnough = box && box.w >= 0.02 && box.h >= 0.02;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-200">Blur a region by hand</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-white text-lg leading-none cursor-pointer">×</button>
        </div>
        <p className="text-[0.6875rem] text-zinc-500">Drag a box over the face (or anything to hide). It is destroyed, not softened.</p>

        <div
          className="relative select-none overflow-hidden rounded-lg border border-zinc-800 touch-none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onUp}
        >
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <img ref={imgRef} src={src} alt="" draggable={false} className="block w-full max-h-[60vh] object-contain bg-zinc-900 pointer-events-none" />
          {box && (
            <div
              className="absolute border-2 border-rose-400 bg-rose-400/20 pointer-events-none"
              style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}
            />
          )}
        </div>

        <div className="flex items-center justify-end gap-2">
          {box && <button onClick={() => setBox(null)} className="text-[0.6875rem] text-zinc-500 hover:text-zinc-300 underline cursor-pointer">Reset box</button>}
          <Btn variant="secondary" className="!rounded-lg !py-1.5 !px-3 !text-xs" onClick={onClose}>Cancel</Btn>
          <Btn className="!rounded-lg !py-1.5 !px-3 !text-xs" onClick={apply} disabled={!bigEnough || busy}>
            {busy ? <Spinner size={14} /> : null} Blur it
          </Btn>
        </div>
      </div>
    </div>
  );
}
