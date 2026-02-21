import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../../context/AppContext';

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function blobToPng(blob) {
  const imageBitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = imageBitmap.width;
  canvas.height = imageBitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(imageBitmap, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((pngBlob) => {
      if (pngBlob) resolve(pngBlob);
      else reject(new Error('Failed to encode PNG'));
    }, 'image/png');
  });
}

export default function ImageLightbox({
  isOpen,
  imageUrls = [],
  currentIndex: externalIndex = 0,
  onClose,
  onIndexChange,
}) {
  const { notify } = useApp();
  const [currentIndex, setCurrentIndex] = useState(externalIndex);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragOriginRef = useRef({ x: 0, y: 0 });

  const resolveImageUrl = useCallback((value) => {
    if (!value || typeof value !== 'string') return '';
    const isAbsoluteOrPath =
      value.startsWith('http://') ||
      value.startsWith('https://') ||
      value.startsWith('data:') ||
      value.startsWith('blob:') ||
      value.startsWith('/');
    if (isAbsoluteOrPath) return value;
    return `/api/gallery/${value}/image`;
  }, []);

  const imageUrl = resolveImageUrl(imageUrls[currentIndex] || '');

  useEffect(() => {
    setCurrentIndex(externalIndex);
  }, [externalIndex]);

  useEffect(() => {
    setZoomLevel(1);
    setPosition({ x: 0, y: 0 });
    setIsDragging(false);
  }, [currentIndex]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  const goToIndex = useCallback((nextIndex) => {
    if (imageUrls.length === 0) return;
    const wrappedIndex = (nextIndex + imageUrls.length) % imageUrls.length;
    setCurrentIndex(wrappedIndex);
    if (onIndexChange) onIndexChange(wrappedIndex);
  }, [imageUrls.length, onIndexChange]);

  const goNext = useCallback(() => {
    goToIndex(currentIndex + 1);
  }, [currentIndex, goToIndex]);

  const goPrev = useCallback(() => {
    goToIndex(currentIndex - 1);
  }, [currentIndex, goToIndex]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
      if (event.key === 'ArrowRight') goNext();
      if (event.key === 'ArrowLeft') goPrev();
    };

    if (isOpen) {
      window.addEventListener('keydown', onKeyDown);
    }

    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [goNext, goPrev, isOpen, onClose]);

  useEffect(() => {
    if (!isDragging) return undefined;

    const onMouseMove = (event) => {
      setPosition({
        x: event.clientX - dragOriginRef.current.x,
        y: event.clientY - dragOriginRef.current.y,
      });
    };

    const onMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isDragging]);

  const onWheelZoom = useCallback((event) => {
    event.preventDefault();
    const delta = event.deltaY < 0 ? 0.2 : -0.2;
    setZoomLevel((prev) => {
      const next = clamp(Number((prev + delta).toFixed(2)), MIN_ZOOM, MAX_ZOOM);
      if (next === MIN_ZOOM) setPosition({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const onMouseDown = useCallback((event) => {
    if (zoomLevel <= 1) return;
    event.preventDefault();
    dragOriginRef.current = {
      x: event.clientX - position.x,
      y: event.clientY - position.y,
    };
    setIsDragging(true);
  }, [position.x, position.y, zoomLevel]);

  const copyImageToClipboard = useCallback(async () => {
    if (!imageUrl) return;
    try {
      if (!window.isSecureContext) {
        throw new Error('Clipboard image copy requires HTTPS or localhost.');
      }

      if (!navigator.clipboard || typeof navigator.clipboard.write !== 'function' || !window.ClipboardItem) {
        throw new Error('Clipboard image copy is not supported in this browser.');
      }

      const response = await fetch(imageUrl, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Failed to fetch image (${response.status})`);
      }

      const blob = await response.blob();
      const mimeType = blob.type || 'image/png';

      const directItem = new window.ClipboardItem({
        [mimeType]: blob,
      });

      try {
        await navigator.clipboard.write([directItem]);
        notify('Image copied', 'success');
        return;
      } catch {
        // Direct write failed, try PNG fallback
      }

      const pngBlob = mimeType === 'image/png' ? blob : await blobToPng(blob);
      const pngItem = new window.ClipboardItem({
        'image/png': pngBlob,
      });
      await navigator.clipboard.write([pngItem]);
      notify('Image copied', 'success');
    } catch {
      try {
        await navigator.clipboard.writeText(imageUrl);
        notify('Copied image URL', 'info');
      } catch {
        notify('Failed to copy image', 'error');
      }
    }
  }, [imageUrl, notify]);

  if (imageUrls.length === 0) return null;

  const content = (
    <div
      className={`fixed inset-0 z-[120] flex items-center justify-center p-4 transition-opacity duration-200 ${isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      aria-hidden={!isOpen}
    >
      <div className="absolute inset-0 bg-black/85 backdrop-blur-md" onClick={onClose} role="button" aria-label="Close lightbox" tabIndex={-1} />

      <div className="absolute top-4 right-4 z-[2] flex items-center gap-2">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close lightbox"
          className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-zinc-100 shadow-lg shadow-black/40 backdrop-blur-lg transition hover:border-blue-300/50 hover:bg-white/20 hover:shadow-blue-500/20 cursor-pointer"
        >
          X
        </button>
        <a
          href={imageUrl}
          download={`image-${currentIndex + 1}.png`}
          className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-zinc-100 shadow-lg shadow-black/40 backdrop-blur-lg transition hover:border-blue-300/50 hover:bg-white/20 hover:shadow-blue-500/20"
        >
          Download
        </a>
        <button
          type="button"
          onClick={() => window.open(imageUrl, '_blank', 'noopener,noreferrer')}
          className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-zinc-100 shadow-lg shadow-black/40 backdrop-blur-lg transition hover:border-blue-300/50 hover:bg-white/20 hover:shadow-blue-500/20 cursor-pointer"
        >
          Open
        </button>
        <button
          type="button"
          onClick={copyImageToClipboard}
          className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-zinc-100 shadow-lg shadow-black/40 backdrop-blur-lg transition hover:border-blue-300/50 hover:bg-white/20 hover:shadow-blue-500/20 cursor-pointer"
        >
          Copy
        </button>
      </div>

      {imageUrls.length > 1 && (
        <>
          <button
            type="button"
            onClick={goPrev}
            aria-label="Previous image"
            className="absolute left-4 z-[2] rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-lg text-zinc-100 shadow-lg shadow-black/40 backdrop-blur-lg transition hover:border-blue-300/50 hover:bg-white/20 hover:shadow-blue-500/20 cursor-pointer"
          >
            {'<'}
          </button>
          <button
            type="button"
            onClick={goNext}
            aria-label="Next image"
            className="absolute right-4 z-[2] rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-lg text-zinc-100 shadow-lg shadow-black/40 backdrop-blur-lg transition hover:border-blue-300/50 hover:bg-white/20 hover:shadow-blue-500/20 cursor-pointer"
          >
            {'>'}
          </button>
        </>
      )}

      <div
        className="relative z-[1] flex max-h-[90vh] max-w-[90vw] items-center justify-center overflow-hidden rounded-2xl"
        onWheel={onWheelZoom}
        onMouseDown={onMouseDown}
      >
        <img
          src={imageUrl}
          alt={`Lightbox image ${currentIndex + 1}`}
          draggable={false}
          onError={() => notify('Failed to load image', 'error')}
          className="max-h-[90vh] max-w-[90vw] select-none object-contain will-change-transform"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${zoomLevel})`,
            transition: isDragging ? 'none' : 'transform 150ms ease',
            cursor: zoomLevel > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
          }}
        />
      </div>

      <div className="absolute bottom-4 left-1/2 z-[2] -translate-x-1/2 rounded-full border border-white/15 bg-black/45 px-4 py-1.5 text-xs text-zinc-200 shadow-lg shadow-black/40 backdrop-blur-lg">
        {currentIndex + 1} / {imageUrls.length} | Zoom {zoomLevel.toFixed(1)}x
      </div>
    </div>
  );

  if (typeof document === 'undefined') return content;
  return createPortal(content, document.body);
}
