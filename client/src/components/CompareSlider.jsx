import { useState, useRef, useCallback, useEffect } from 'react';
import { cn } from '../lib/utils';

/**
 * Before/after image comparison slider.
 *
 * Props:
 *  - originalSrc   — URL or data-URI for the "before" image
 *  - processedSrc  — URL or data-URI for the "after" image
 *  - originalLabel  — label shown top-left  (default "ORIGINAL")
 *  - processedLabel — label shown top-right (default "PROCESSED")
 *  - className      — extra classes on the outer wrapper
 */
export default function CompareSlider({
  originalSrc,
  processedSrc,
  originalLabel = 'ORIGINAL',
  processedLabel = 'PROCESSED',
  className = '',
}) {
  const containerRef = useRef(null);
  const [pos, setPos] = useState(50);
  const [dragging, setDragging] = useState(false);

  const updatePos = useCallback((clientX) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos(Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100)));
  }, []);

  const onPointerDown = useCallback((e) => {
    setDragging(true);
    updatePos(e.clientX);
  }, [updatePos]);

  const onPointerMove = useCallback((e) => {
    if (!dragging) return;
    updatePos(e.clientX);
  }, [dragging, updatePos]);

  useEffect(() => {
    if (!dragging) return;
    const up = () => setDragging(false);
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, [dragging]);

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative select-none overflow-hidden rounded-xl border border-zinc-700/60',
        dragging ? 'cursor-ew-resize' : 'cursor-ew-resize',
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
    >
      {/* Processed (full background) */}
      <img
        src={processedSrc}
        alt={processedLabel}
        draggable={false}
        className="block w-full h-auto"
      />

      {/* Original (clipped from left) */}
      <div
        className="absolute inset-0"
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
      >
        <img
          src={originalSrc}
          alt={originalLabel}
          draggable={false}
          className="block w-full h-full object-cover"
        />
      </div>

      {/* Divider line */}
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-white -translate-x-1/2"
        style={{ left: `${pos}%`, boxShadow: '0 0 8px rgba(0,0,0,0.5)' }}
      >
        {/* Handle */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white border-2 border-zinc-400 flex items-center justify-center shadow-lg">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="8 4 4 8 8 12" />
            <polyline points="16 4 20 8 16 12" />
          </svg>
        </div>
      </div>

      {/* Labels */}
      <div className="absolute top-2.5 left-2.5 px-2.5 py-1 rounded-md text-[0.7rem] font-bold tracking-wide bg-black/60 text-red-400 backdrop-blur-sm">
        {originalLabel}
      </div>
      <div className="absolute top-2.5 right-2.5 px-2.5 py-1 rounded-md text-[0.7rem] font-bold tracking-wide bg-black/60 text-emerald-400 backdrop-blur-sm">
        {processedLabel}
      </div>
    </div>
  );
}
