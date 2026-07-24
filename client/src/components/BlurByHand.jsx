import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Btn } from './UI';
import { blurRegion } from '../lib/blurRegion';

/**
 * Drag a box over a face and blur it.
 *
 * The automatic detector is frontal-only, so a head turned away, tipped back or half behind
 * hair is simply not found. Those images still leak a face into a generation, so there has to
 * be a way to do it by hand.
 *
 * Rendered through a portal: this sits inside a scrolling card grid, and an ancestor with
 * overflow clipping would otherwise cut the overlay off — the same thing that made an earlier
 * popup in this app render as a black box.
 */
export default function BlurByHand({ src, onApply, onClose }) {
  const [box, setBox] = useState(null);        // in displayed pixels
  const [drag, setDrag] = useState(null);
  const [busy, setBusy] = useState(false);
  const imgRef = useRef(null);

  const pointAt = (e) => {
    const r = imgRef.current.getBoundingClientRect();
    return {
      x: Math.min(Math.max(e.clientX - r.left, 0), r.width),
      y: Math.min(Math.max(e.clientY - r.top, 0), r.height),
    };
  };

  const start = (e) => { e.preventDefault(); setDrag(pointAt(e)); setBox(null); };
  const move = (e) => {
    if (!drag) return;
    const p = pointAt(e);
    setBox({
      x: Math.min(drag.x, p.x), y: Math.min(drag.y, p.y),
      w: Math.abs(p.x - drag.x), h: Math.abs(p.y - drag.y),
    });
  };
  const end = () => setDrag(null);

  const apply = async () => {
    if (!box || box.w < 4 || box.h < 4) return;
    const r = imgRef.current.getBoundingClientRect();
    setBusy(true);
    try {
      // blurRegion works in fractions of the image, so the on-screen box has to be divided by
      // the displayed size — not the natural size, which differs whenever the image is scaled.
      const out = await blurRegion(src, {
        x: box.x / r.width, y: box.y / r.height,
        w: box.w / r.width, h: box.h / r.height,
      });
      await onApply(out);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6" onClick={onClose}>
      <div className="max-h-full w-full max-w-lg space-y-3 overflow-y-auto rounded-2xl border border-white/[0.08] bg-[#0b0b0f] p-4"
        onClick={(e) => e.stopPropagation()}>
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">Blur by hand</h3>
          <p className="text-xs text-zinc-500">Drag a box over the face, then apply. This cannot be undone.</p>
        </div>

        <div className="relative select-none" onMouseMove={move} onMouseUp={end} onMouseLeave={end}>
          <img
            ref={imgRef}
            src={src}
            alt=""
            draggable={false}
            onMouseDown={start}
            className="w-full cursor-crosshair rounded-lg bg-zinc-950"
          />
          {box && (
            <div
              className="pointer-events-none absolute border-2 border-rose-500 bg-rose-500/20"
              style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
            />
          )}
        </div>

        <div className="flex items-center gap-2">
          <Btn className="!rounded-lg !py-2 !px-4 !text-sm" onClick={apply} disabled={!box || busy}>
            {busy ? 'Blurring…' : 'Blur this area'}
          </Btn>
          {box && <Btn variant="ghost" className="!rounded-lg !py-2 !px-3 !text-sm" onClick={() => setBox(null)}>Reset box</Btn>}
          <Btn variant="ghost" className="!rounded-lg !py-2 !px-3 !text-sm ml-auto" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </div>,
    document.body,
  );
}
