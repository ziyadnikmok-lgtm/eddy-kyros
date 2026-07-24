import { useState, useMemo, useCallback, useEffect } from 'react';
import { seedream as seedreamApi, gallery as galleryApi, characters as charApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Textarea, Spinner } from '../components/UI';
import { pushPending, resolvePending, failPending } from '../lib/generationFeed';
import { downloadBlob } from '../lib/stripMetadata';
import { SEEDREAM_ASPECT_RATIOS, SEEDREAM_RESOLUTIONS, SEEDREAM_MAX_IMAGES, seedreamCost } from '../config/photoModes';

// The simplest Seedream flow: pick a Character (the "model"), type a prompt, generate. No source
// upload and no edit chips — this is the "just select and prompt" tab. Seedream is an image-to-image
// model (its route rejects an empty images array), so the Character's own reference photos ARE the
// input: they carry her identity, and the prompt describes the new picture to build around it.

function parseDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  return m ? { mimeType: m[1], base64: m[2] } : null;
}
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
/** Fetch an in-app image URL and hand it back in the {base64, mimeType} shape the route wants. */
async function urlToImagePayload(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error('Failed to load character image');
  const blob = await resp.blob();
  const dataUrl = await fileToDataUrl(new File([blob], 'char', { type: blob.type || 'image/png' }));
  return parseDataUrl(dataUrl);
}

// Every identity image the character carries: its primary photo(s) first (index order, so the base
// she was built from stays image 1), then each ACTIVE reference. Mirrors NanoBypass's descriptor
// builder so the same character resolves to the same refs in both tabs.
function characterRefUrls(characterId, character) {
  if (!characterId || !character) return [];
  const urls = [];
  const primaryCount = Math.max(0, Number(character.primaryImageCount || 0));
  if (primaryCount > 0) {
    for (let i = 0; i < primaryCount; i += 1) urls.push(charApi.primaryImageUrl(characterId, i));
  } else {
    urls.push(charApi.imageUrl(characterId)); // older character with a single un-indexed primary
  }
  for (const ref of character.references || []) {
    if (ref?.isActive) urls.push(charApi.refImageUrl(characterId, ref.id));
  }
  return urls;
}

// Survives tab switches within a session (a reload clears it — images are never cached here, only text).
const _cache = { prompt: '', characterId: '', aspectRatio: '3:4', resolution: '1K' };

export default function SeedreamGeneratePage() {
  const { notify, characters = [] } = useApp();
  const [characterId, setCharacterId] = useState(_cache.characterId);
  const [prompt, setPrompt] = useState(_cache.prompt);
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [resolution, setResolution] = useState(SEEDREAM_RESOLUTIONS.includes(_cache.resolution) ? _cache.resolution : '1K');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState([]); // { uid, dataUrl, prompt }

  useEffect(() => { _cache.prompt = prompt; }, [prompt]);
  useEffect(() => { _cache.characterId = characterId; }, [characterId]);
  useEffect(() => { _cache.aspectRatio = aspectRatio; }, [aspectRatio]);
  useEffect(() => { _cache.resolution = resolution; }, [resolution]);

  const character = useMemo(() => characters.find((c) => c.id === characterId) || null, [characters, characterId]);
  const refUrls = useMemo(() => characterRefUrls(characterId, character), [characterId, character]);
  // The bill is per output image at this resolution + however many identity refs are sent (first is
  // free, extras add a little). Shown on the button BEFORE the click so the price is never a surprise.
  const refCount = Math.min(refUrls.length, SEEDREAM_MAX_IMAGES);
  const cost = seedreamCost(resolution, Math.max(1, refCount));

  const generate = useCallback(async () => {
    if (busy) return;
    if (!characterId) { notify('Pick a character first', 'error'); return; }
    if (!prompt.trim()) { notify('Type a prompt', 'error'); return; }
    if (!refUrls.length) { notify('This character has no reference images to generate from', 'error'); return; }

    setBusy(true);
    const feedId = `seedream-gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Identity anchor: without it the edit model tends to lightly RETOUCH the reference rather than
    // build the new scene the prompt describes. This keeps her face while letting the prompt drive.
    const fullPrompt = `The woman in the reference images is the subject — keep her exact face, identity, hair and skin. Create a NEW photorealistic photo of her: ${prompt.trim()}. Real skin texture with pores, natural lighting, no CGI or plastic look.`;
    pushPending({ id: feedId, prompt: prompt.trim(), imageModel: 'Seedream 5.0 Pro', aspectRatio, resolutionTier: resolution });
    try {
      const images = [];
      for (const url of refUrls.slice(0, SEEDREAM_MAX_IMAGES)) {
        const payload = await urlToImagePayload(url);
        if (payload) images.push(payload);
      }
      if (!images.length) throw new Error('Could not load the character images');

      const data = await seedreamApi.edit({ images, prompt: fullPrompt, aspectRatio, resolution });
      const first = (data.images || [])[0];
      if (!first) throw new Error('Seedream returned no image');

      resolvePending(feedId, {
        galleryId: first.galleryId,
        imageId: first.imageId,
        prompt: prompt.trim(),
        imageModel: 'Seedream 5.0 Pro',
        aspectRatio,
        resolutionTier: resolution,
        mimeType: first.mimeType,
        generatedAt: Date.now(),
      });
      const dataUrl = first.base64Data
        ? `data:${first.mimeType};base64,${first.base64Data}`
        : galleryApi.imageUrl(first.galleryId);
      setResults((prev) => [{ uid: feedId, dataUrl, prompt: prompt.trim() }, ...prev]);
    } catch (err) {
      // failPending (not reject): keep the feed card and show the error so a paid failure is visible.
      failPending(feedId, err.message || 'Generation failed');
      notify(err.message || 'Generation failed', 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, characterId, prompt, refUrls, aspectRatio, resolution, notify]);

  const download = useCallback(async (r) => {
    try {
      const resp = await fetch(r.dataUrl, { credentials: 'include' });
      const blob = await resp.blob();
      await downloadBlob(blob, `seedream-${r.uid}.png`);
    } catch {
      notify('Download failed', 'error');
    }
  }, [notify]);

  const CHIP = 'rounded-full border px-3 py-1 text-xs font-semibold transition cursor-pointer';
  const chipCls = (on) => `${CHIP} ${on ? 'border-rose-500 bg-rose-500/15 text-rose-300' : 'border-white/10 bg-white/[0.02] text-zinc-400 hover:border-zinc-600'}`;

  return (
    <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
      {/* CONTROLS */}
      <Card className="space-y-4 p-4 self-start">
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-zinc-400">Character (your model)</label>
          <select
            value={characterId}
            onChange={(e) => setCharacterId(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-rose-500 focus:outline-none"
          >
            <option value="">Select a character…</option>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>{c.name || c.id}</option>
            ))}
          </select>
          {characterId && !refUrls.length && (
            <p className="mt-1 text-xs text-amber-400">This character has no reference images — add some in the Characters tab.</p>
          )}
        </div>

        {refUrls.length > 0 && (
          <div>
            <p className="mb-1 text-[0.625rem] uppercase tracking-wider text-zinc-500">Identity used ({refCount})</p>
            <div className="flex flex-wrap gap-1.5">
              {refUrls.slice(0, SEEDREAM_MAX_IMAGES).map((url) => (
                <img key={url} src={url} alt="" className="h-12 w-12 rounded-md border border-zinc-800 object-cover bg-zinc-950" />
              ))}
            </div>
          </div>
        )}

        <Textarea
          label="Prompt"
          rows={5}
          placeholder="e.g. standing on a sunny balcony at golden hour, wearing a white summer dress, smiling at the camera"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />

        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-400">Aspect ratio</p>
          <div className="flex flex-wrap gap-1.5">
            {SEEDREAM_ASPECT_RATIOS.map((r) => (
              <button key={r} type="button" onClick={() => setAspectRatio(r)} className={chipCls(aspectRatio === r)}>{r}</button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-400">Output size</p>
          <div className="flex gap-1.5">
            {SEEDREAM_RESOLUTIONS.map((r) => (
              <button key={r} type="button" onClick={() => setResolution(r)} className={chipCls(resolution === r)}>{r}</button>
            ))}
          </div>
        </div>

        <Btn onClick={generate} disabled={busy || !characterId || !prompt.trim()} className="w-full">
          {busy ? <span className="flex items-center justify-center gap-2"><Spinner size={16} /> Generating…</span> : `Generate · $${cost.toFixed(3)}`}
        </Btn>
      </Card>

      {/* RESULTS */}
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-300">Results {results.length > 0 && <span className="text-rose-400">· {results.length}</span>}</h3>
        {results.length === 0 ? (
          <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-zinc-800 text-sm text-zinc-600">
            {busy ? 'Generating your first image…' : 'Pick a character, type a prompt, and hit Generate.'}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {results.map((r) => (
              <div key={r.uid} className="group relative overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
                <img src={r.dataUrl} alt={r.prompt} className="w-full object-cover" />
                <button
                  type="button"
                  onClick={() => download(r)}
                  className="absolute bottom-2 right-2 rounded-md border border-zinc-600 bg-black/70 px-2.5 py-1 text-xs font-semibold text-zinc-100 opacity-0 transition group-hover:opacity-100 hover:border-rose-400 hover:text-rose-300 cursor-pointer"
                >
                  Download
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
