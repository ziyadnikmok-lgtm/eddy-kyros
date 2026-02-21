import { useEffect, useMemo, useState } from 'react';
import { images as imagesApi } from '../../services/api';

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function ImagePicker({ selectedId, onSelect, allowUpload = true }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [items, setItems] = useState([]);
  const [tempItems, setTempItems] = useState([]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const list = await imagesApi.list();
        const ids = (list || [])
          .filter((img) => img?.hasImage)
          .map((img) => img.imageId || img.id)
          .filter(Boolean);

        const details = await Promise.all(
          ids.map(async (id) => {
            try {
              const full = await imagesApi.get(id);
              if (!full?.image?.base64Data) return null;
              return {
                id,
                src: `data:${full.image.mimeType || 'image/png'};base64,${full.image.base64Data}`,
                source: full.source || 'generate',
              };
            } catch {
              return null;
            }
          })
        );

        if (!cancelled) {
          setItems(details.filter(Boolean));
        }
      } catch {
        if (!cancelled) {
          setError('Failed to load images');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  const mergedItems = useMemo(() => [...tempItems, ...items], [tempItems, items]);

  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const temp = { id: tempId, src: dataUrl, source: 'upload' };
      setTempItems((prev) => [temp, ...prev]);
      onSelect?.(tempId);
    } catch {
      setError('Failed to read file');
    } finally {
      event.target.value = '';
    }
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-[#111] p-3">
      {loading ? (
        <div className="flex items-center justify-center py-10 text-zinc-400 text-sm">
          Loading images...
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      ) : mergedItems.length === 0 && !allowUpload ? (
        <div className="py-8 text-center text-sm text-zinc-500">
          No images available.
        </div>
      ) : (
        <div className="grid [grid-template-columns:repeat(auto-fill,minmax(120px,1fr))] gap-3 max-h-[300px] overflow-y-auto pr-1">
          {allowUpload && (
            <label className="group relative flex aspect-square cursor-pointer items-center justify-center rounded-xl border border-dashed border-zinc-700/80 bg-zinc-900/70 text-zinc-400 transition hover:border-blue-500/70 hover:bg-zinc-800/80 hover:text-zinc-200">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={handleUpload}
              />
              <div className="text-center">
                <div className="text-2xl leading-none">+</div>
                <div className="mt-1 text-xs">Upload Image</div>
              </div>
            </label>
          )}

          {mergedItems.map((image) => {
            const isSelected = selectedId === image.id;
            return (
              <button
                key={image.id}
                type="button"
                onClick={() => onSelect?.(image.id)}
                className={`group relative aspect-square overflow-hidden rounded-xl border bg-zinc-900 transition duration-200 hover:scale-[1.02] hover:shadow-[0_0_24px_rgba(59,130,246,0.2)] ${isSelected ? 'border-2 border-blue-500 shadow-[0_0_18px_rgba(59,130,246,0.35)]' : 'border-zinc-800'}`}
              >
                <img src={image.src} alt="" className="h-full w-full object-cover" />
                {isSelected && (
                  <div className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-blue-500 text-xs font-bold text-white">
                    ✓
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
