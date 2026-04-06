import { useState, useRef, useCallback, useEffect } from 'react';
import { cn } from '../lib/utils';

export default function CompareSlider({
  originalSrc,
  processedSrc,
  originalLabel = 'ORIGINAL',
  processedLabel = 'PROCESSED',
  processedStyle,
  className = '',
  imgClassName = '',
}) {
  const containerRef = useRef(null);
  const [pos, setPos] = useState(50);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const updatePos = useCallback((clientX) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos(Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100)));
  }, []);

  const onPointerDown = useCallback((e) => {
    draggingRef.current = true;
    setDragging(true);
    updatePos(e.clientX);
  }, [updatePos]);

  const onPointerMove = useCallback((e) => {
    if (!draggingRef.current) return;
    updatePos(e.clientX);
  }, [updatePos]);

  useEffect(() => {
    if (!dragging) return;
    const up = () => { draggingRef.current = false; setDragging(false); };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, [dragging]);

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role="slider"
      aria-valuenow={Math.round(pos)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Compare slider"
      className={cn(
        'relative select-none overflow-hidden rounded-xl border border-zinc-700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
        dragging ? 'cursor-grabbing' : 'cursor-ew-resize',
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') setPos((p) => Math.max(0, p - 2));
        else if (e.key === 'ArrowRight') setPos((p) => Math.min(100, p + 2));
      }}
    >
      <img
        src={processedSrc}
        alt={processedLabel}
        draggable={false}
        className={cn('block', imgClassName || 'w-full h-auto')}
        style={processedStyle}
      />

      <div
        className="absolute inset-0"
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
      >
        <img
          src={originalSrc}
          alt={originalLabel}
          draggable={false}
          className={cn('block', imgClassName || 'w-full h-auto')}
        />
      </div>

      <div
        className="absolute top-0 bottom-0 w-0.5 bg-white -translate-x-1/2"
        style={{ left: `${pos}%`, boxShadow: '0 0 8px rgba(0,0,0,0.5)' }}
      >
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white border-2 border-zinc-400 flex items-center justify-center shadow-lg">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="8 4 4 8 8 12" />
            <polyline points="16 4 20 8 16 12" />
          </svg>
        </div>
      </div>

      <div className="absolute top-2.5 left-2.5 px-2.5 py-1 rounded-md text-[0.7rem] font-bold tracking-wide bg-black/60 text-red-400 backdrop-blur-sm">
        {originalLabel}
      </div>
      <div className="absolute top-2.5 right-2.5 px-2.5 py-1 rounded-md text-[0.7rem] font-bold tracking-wide bg-black/60 text-emerald-400 backdrop-blur-sm">
        {processedLabel}
      </div>
    </div>
  );
}
