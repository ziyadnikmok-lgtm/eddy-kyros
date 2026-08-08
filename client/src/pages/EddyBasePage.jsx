import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Card, Btn, Spinner } from '../components/UI';
import { useApp } from '../context/AppContext';
import { seedream as seedreamApi } from '../services/api';
import { createEddyCollection } from '../lib/eddyCollectionStore';
import { createPageStore } from '../lib/pageStateStore';
import { cn } from '../lib/utils';

/**
 * Base — make a NEW base photo of a character you already have.
 *
 * The other Eddy pages all start from a base image you supply. This is where that image comes
 * from: pick a saved character, describe the shot, and her own reference photos are sent as the
 * identity to hold. The result lands in Base Library, which is the only collection the
 * Generate page's "Main photo" slot ever needs to be pointed at.
 *
 * ENGINE: Nano Banana 2 edit on WaveSpeed (owner's choice, 2026-08-07 — endpoint and payload
 * from WaveSpeed's own published example, not guessed). It goes through the shared
 * /api/seedream/edit route with model:'nano2', so a base image gets the same imageStore write,
 * the same gallery row and the same tagging as every other generation — nothing about it is a
 * side channel.
 */
/**
 * The Generated panel survives leaving the page.
 *
 * It was component state alone, so switching tabs unmounted the page and every tile vanished —
 * the pictures were safe in Base Library, but the panel you were working in emptied itself and
 * read as data loss (owner, 2026-08-08). Only the Base Library row id is persisted, never the
 * bytes: a 2K png is megabytes of base64 and a session's worth would blow the store, while the
 * image itself already lives in that collection and can be read back from it.
 */
const RESULTS_KEY = 'base-results';
const RESULTS_CAP = 60;
const resultsStore = createPageStore('eddy-base-results-v1');

const CHAR_DB = 'eddy-character';
const BASE_DB = 'eddy-base';

// 3:4 leads because it is the frame every downstream Eddy flow expects, but the rest are offered:
// a base shot is still a normal image and there is no reason to force a crop (owner, 2026-08-07).
const RATIOS = ['3:4', '4:5', '1:1', '9:16', '16:9', '2:3', '3:2'];
const RESOLUTIONS = ['1K', '2K'];

/**
 * WaveSpeed's published per-image rate for nano-banana-2, by resolution.
 *
 * Read off WaveSpeed's own model page for this endpoint, not estimated: 0.5k $0.045, 1k $0.07,
 * 2k $0.105, 4k $0.14 — 2K is the standard rate x1.5, 4K x2. Only the two tiers this page offers
 * are listed. Web-search and image-search each add $0.014 there, and both are sent false by the
 * service, so neither applies here.
 */
const NANO2_COST = { '1K': 0.07, '2K': 0.105 };

// Just above the server's own 10-minute poll ceiling, so a slow job ends with the server's
// specific message (which names the prediction id) rather than a bare client abort.
const NANO2_CLIENT_TIMEOUT_MS = 11 * 60_000;
/**
 * Retry a rate-limited call, backing off between attempts — the same contract EddyGeneratePage
 * uses, and here for the same reason: nothing else in this stack retries a 429, so a quota bump
 * does not slow a run down, it DELETES an image from it.
 *
 * Only 429 / RATE_LIMITED is retried. Everything else is returned untouched, because a bad prompt
 * or a missing key fails identically on attempt four.
 */
async function withRateLimitRetry(fn, { attempts = 4, baseDelayMs = 4000 } = {}) {
  for (let i = 0; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      const limited = err?.status === 429 || err?.code === 'RATE_LIMITED';
      if (!limited || i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
}

const nano2Cost = (res, n) => {
  const each = NANO2_COST[res];
  return typeof each === 'number' ? each * Math.max(1, n) : null;
};
// The model's own limit, enforced server-side too.
const MAX_REFS = 10;

/**
 * The identity rule, prepended to whatever the user writes.
 *
 * Written here rather than left to the user because "make her on a balcony" with no identity
 * clause returns a stranger — the references are just pictures unless the prompt says what they
 * are for. Kept short: the whole prompt is sent verbatim.
 */
function buildBasePrompt(instruction, refCount) {
  const refs = refCount === 1 ? 'The reference image shows' : `The ${refCount} reference images show`;
  return [
    `${refs} ONE woman. She is the subject of the new photo.`,
    'Her face, bone structure, eyes, nose, lips, hairline, hair, skin tone and her body — her build, her bust, her waist and her hips — must match the references EXACTLY. Do not slim her, do not change her chest, do not average her toward a different face or figure.',
    'Take NOTHING else from the references: not their background, not their framing, not their lighting, not their clothing unless the instruction below asks for it.',
    'Make a NEW photograph of her as described:',
    instruction.trim(),
    'Photorealistic: real skin texture with pores, natural hair, slight asymmetry, natural camera lighting. No plastic or CGI look, no illustration, no text or watermark.',
  ].join(' ');
}

export default function EddyBasePage() {
  const { notify } = useApp();
  const charStore = useMemo(() => createEddyCollection(CHAR_DB), []);
  const baseStore = useMemo(() => createEddyCollection(BASE_DB), []);

  const [chars, setChars] = useState([]);       // folders in eddy-character
  const [items, setItems] = useState([]);       // every character image
  const [thumbs, setThumbs] = useState({});
  const [charId, setCharId] = useState('');
  const [instruction, setInstruction] = useState('');
  const [ratio, setRatio] = useState('3:4');
  const [resolution, setResolution] = useState('2K');
  const [count, setCount] = useState(1);
  // How many generations are in the air. A COUNT, not a boolean: the button stays live so another
  // run can be started while one is still going, which a boolean 'busy' made impossible — the page
  // locked up behind a single request and there was no sign of it anywhere but the button label
  // (owner, 2026-08-08).
  const [inFlight, setInFlight] = useState(0);
  // Monotonic, so placeholder keys from overlapping runs never collide.
  const runSeq = useRef(0);
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState([]);   // [{ key, dataUrl, itemId } | { key, error }]
  // False until the saved panel has been read back, so the persist effect below cannot write an
  // empty array over the stored one during the first render.
  const hydrated = useRef(false);

  // Restore the panel: read the saved rows, then pull each picture out of Base Library by id.
  // A row whose image is gone (deleted from the Library) is dropped rather than shown blank.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const saved = await resultsStore.get(RESULTS_KEY, []);
        const rows = await Promise.all((Array.isArray(saved) ? saved : []).map(async (r) => {
          if (r.error) return r;
          if (!r.itemId) return null;
          try {
            const dataUrl = await baseStore.getImage(r.itemId);
            return dataUrl ? { ...r, dataUrl } : null;
          } catch { return null; }
        }));
        if (alive) setResults(rows.filter(Boolean));
      } catch { /* nothing saved yet */ }
      if (alive) hydrated.current = true;
    })();
    return () => { alive = false; };
  }, [baseStore]);

  // Persist on every change, minus the bytes and minus anything still in flight — a pending tile
  // restored after a reload would spin forever, because the request that owned it is long gone.
  useEffect(() => {
    if (!hydrated.current) return;
    const light = results
      .filter((r) => !r.pending)
      .slice(0, RESULTS_CAP)
      .map((r) => (r.error ? { key: r.key, error: r.error } : { key: r.key, itemId: r.itemId || null }))
      .filter((r) => r.error || r.itemId);
    resultsStore.set(RESULTS_KEY, light);
  }, [results]);

  const retryOne = useCallback(async (key) => {
    const run = lastRun.current;
    if (!run) { notify('Nothing to retry from — generate again', 'error'); return; }
    setResults((prev) => prev.map((r) => (r.key === key ? { key, pending: true } : r)));
    setInFlight((k) => k + 1);
    try {
      const d = await withRateLimitRetry(() => seedreamApi.edit({
        images: run.payload, prompt: run.prompt, model: 'nano2',
        aspectRatio: run.ratio, resolution: run.resolution, tags: ['eddy', 'base'],
      }, { timeoutMs: NANO2_CLIENT_TIMEOUT_MS }));
      const first = (d?.images || [])[0];
      if (!first?.base64Data) throw new Error('No image came back');
      const dataUrl = `data:${first.mimeType || 'image/png'};base64,${first.base64Data}`;
      const folder = await baseStore.ensureFolder(run.charName);
      const stored = await baseStore.addItems([{ dataUrl, prompt: run.prompt, name: `base-${Date.now()}` }], folder.id);
      setResults((prev) => prev.map((r) => (r.key === key ? { key, dataUrl, itemId: stored?.[0]?.id || null } : r)));
    } catch (err) {
      setResults((prev) => prev.map((r) => (r.key === key ? { key, error: err?.message || 'Generation failed' } : r)));
      notify(err?.message || 'Retry failed', 'error');
    } finally {
      setInFlight((k) => Math.max(0, k - 1));
    }
  }, [baseStore, notify]);

  /**
   * Where new images are filed. '' means "a folder named after the character", which is the old
   * behaviour and still the default — but picking a destination before generating removes the
   * move-afterwards step entirely (owner, 2026-08-08, "from base to base folder").
   */
  const [saveToId, setSaveToId] = useState('');

  /**
   * Picking a character resets the destination to her own folder.
   *
   * Without this, choosing a folder once made it sticky: switch from Grace to Mia and Mia's
   * images kept landing in Grace's folder, silently, because the selector still held the old id.
   * "Each character's images go to her own folder" only holds if selecting her says so
   * (owner, 2026-08-08). An explicit folder choice still wins until the character changes again.
   */
  useEffect(() => { setSaveToId(''); }, [charId]);
  const [saveFolders, setSaveFolders] = useState([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try { const f = await baseStore.listFolders(); if (alive) setSaveFolders(f); } catch { /* none yet */ }
    })();
    return () => { alive = false; };
    // results is a dep so a folder created by the picker shows up here without a reload.
  }, [baseStore, results]);

  const [picked, setPicked] = useState([]);        // result indexes ticked
  const [folderPick, setFolderPick] = useState(false);
  const [baseFolders, setBaseFolders] = useState([]);

  /**
   * Load the Base Library folders WITH a cover image and a count.
   *
   * A bare list of names is only usable if you remember what you called things. The cover is the
   * folder's newest image, which is the one you most likely just put there (owner, 2026-08-08).
   */
  const openFolderPick = useCallback(async () => {
    try {
      const [fs_, its] = await Promise.all([baseStore.listFolders(), baseStore.listItems()]);
      const rows = await Promise.all(fs_.map(async (f) => {
        const mine = its.filter((i) => i.folderId === f.id);
        const newest = [...mine].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
        let cover = null;
        try { cover = newest ? (newest.url || await baseStore.getImage(newest.id)) : null; } catch { cover = null; }
        return { ...f, count: mine.length, cover };
      }));
      // Busiest first — the folder you are filing into is rarely the empty one.
      setBaseFolders(rows.sort((a, b) => b.count - a.count));
    } catch { setBaseFolders([]); }
    setFolderPick(true);
  }, [baseStore]);

  /**
   * Move the ticked results into a Base Library folder.
   *
   * A MOVE: every result was already filed under the character's name when it was generated, so
   * this re-points the existing row's folderId rather than adding a second copy — the same rule
   * the Generate page's Send-to-Library follows, and for the same reason.
   *
   * Results with no itemId (their Library write failed) are skipped and reported, not silently
   * counted as moved.
   */
  const fileTo = useCallback(async (folderId) => {
    const rows = (picked.length ? picked : results.map((_, i) => i)).map((i) => results[i]).filter((r) => r && !r.pending && !r.error);
    const movable = rows.filter((r) => r.itemId);
    if (!movable.length) { notify('Those are not in the Library yet', 'error'); return; }
    try {
      for (const r of movable) {
        // eslint-disable-next-line no-await-in-loop -- serialized store, small writes
        await baseStore.updateItem(r.itemId, { folderId });
      }
    } catch (err) { notify(err?.message || 'Could not move those', 'error'); return; }
    setFolderPick(false);
    setPicked([]);
    const skipped = rows.length - movable.length;
    notify(`${movable.length} moved${skipped ? ` · ${skipped} not in the Library` : ''}`, skipped ? 'error' : 'success');
  }, [picked, results, baseStore, notify]);

  /**
   * The settings a run was started with, kept so a failed tile can be retried exactly as it was.
   * Reading the live controls instead would silently retry at whatever ratio/character is selected
   * NOW, which is not the image you asked to retry.
   */
  const lastRun = useRef(null);

  const refresh = useCallback(async () => {
    const [f, i] = await Promise.all([charStore.listFolders(), charStore.listItems()]);
    setChars(f);
    setItems(i);
    const map = {};
    await Promise.all(i.map(async (it) => { map[it.id] = it.url || await charStore.getImage(it.id); }));
    setThumbs(map);
    setLoading(false);
  }, [charStore]);

  useEffect(() => { refresh(); }, [refresh]);

  /**
   * Her references, with the one marked BASE in the Character tab FIRST.
   *
   * Order is not cosmetic: the model treats the leading image as the primary subject, and the
   * Character tab already lets you mark which photo is the base face. Honouring that mark here is
   * what makes "select the character and it uses the right face" true — sorting purely by date
   * would hand it whichever photo happened to be uploaded first (owner, 2026-08-07).
   */
  // The selected character's name — used by the Save-to label and as the default folder.
  const charName = useMemo(() => chars.find((c) => c.id === charId)?.name || '', [chars, charId]);

  const refs = useMemo(() => {
    const mine = items.filter((i) => i.folderId === charId);
    const rank = (i) => (i.role === 'base' ? 0 : i.role === 'body' ? 1 : 2);
    return mine.sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
  }, [items, charId]);

  const generate = useCallback(async () => {
    if (!charId) { notify('Pick a character first', 'error'); return; }
    if (!instruction.trim()) { notify('Describe the shot you want', 'error'); return; }
    // EVERY photo she has is sent, not a sample: more references hold identity better, and the
    // owner adds them precisely so they get used (2026-08-07). Capped at 10 only because that is
    // the model's own ceiling — the route rejects an 11th outright.
    const payload = [];
    for (const r of refs.slice(0, MAX_REFS)) {
      const dataUrl = thumbs[r.id] || await charStore.getImage(r.id);
      const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
      if (m) payload.push({ base64: m[2], mimeType: m[1] });
    }
    if (!payload.length) { notify('That character has no reference photos', 'error'); return; }

    const prompt = buildBasePrompt(instruction, payload.length);
    lastRun.current = { payload, prompt, charName: charName || 'Base', ratio, resolution };
    // A placeholder per image, added BEFORE the first request so the panel fills the moment you
    // click. Keyed so a slow one can be replaced in place while later clicks add their own.
    const keys = Array.from({ length: count }, (_, n) => `p-${runSeq.current++}-${n}`);
    setResults((prev) => [...keys.map((key) => ({ key, pending: true })), ...prev]);
    setInFlight((n) => n + count);
    let made = 0;
    try {
      for (let n = 0; n < count; n += 1) {
        // eslint-disable-next-line no-await-in-loop -- serial on purpose: each call re-uploads and
        // polls, and this page is never asked for more than a handful at a time.
        const d = await withRateLimitRetry(() => seedreamApi.edit({
          images: payload,
          prompt,
          model: 'nano2',
          aspectRatio: ratio,
          resolution,
          tags: ['eddy', 'base'],
        }, { timeoutMs: NANO2_CLIENT_TIMEOUT_MS }));
        const first = (d?.images || [])[0];
        if (!first?.base64Data) {
          setResults((prev) => prev.map((r) => (r.key === keys[n] ? { key: keys[n], error: 'No image came back' } : r)));
          setInFlight((k) => k - 1);
          continue;
        }
        const dataUrl = `data:${first.mimeType || 'image/png'};base64,${first.base64Data}`;
        // Straight into Base Library, filed under the character's own name, so a generated base
        // is usable from the Generate page's Main photo slot without a save step.
        // eslint-disable-next-line no-await-in-loop
        // The chosen destination wins; falling back to her name keeps the old behaviour intact.
        const folder = saveToId
          ? { id: saveToId }
          : await baseStore.ensureFolder(charName || 'Base');
        // eslint-disable-next-line no-await-in-loop
        const stored = await baseStore.addItems([{ dataUrl, prompt: instruction.trim(), name: `base-${Date.now()}` }], folder.id);
        // The Base Library row id is kept on the result. Filing it into a different folder later is
        // then a folderId update on THAT row — a move, not a second copy of the same picture.
        // Replace THIS run's placeholder rather than prepending, so results stay in the order the
        // panel already showed them and a second run started meanwhile is not pushed around.
        setResults((prev) => prev.map((r) => (r.key === keys[n] ? { key: keys[n], dataUrl, itemId: stored?.[0]?.id || null } : r)));
        setInFlight((k) => k - 1);
        made += 1;
      }
      notify(made ? `${made} base image${made === 1 ? '' : 's'} saved to Base Library` : 'Nothing came back', made ? 'success' : 'error');
    } catch (err) {
      // A failure KEEPS its tile and states why, instead of vanishing. Silent loss is the exact
      // bug that made a 60-image Seedream run come back as 29 with nothing to point at, and the
      // reason is what tells you whether to retry or fix the prompt (owner, 2026-08-08).
      const why = err?.message || 'Generation failed';
      setResults((prev) => prev.map((r) => (r.pending && keys.includes(r.key) ? { key: r.key, error: why } : r)));
      setInFlight((k) => Math.max(0, k - (count - made)));
      notify(why, 'error');
    }
  }, [charId, instruction, refs, thumbs, charStore, baseStore, charName, ratio, resolution, count, saveToId, notify]);

  if (loading) return <div className="flex justify-center py-16"><Spinner size={28} /></div>;

  const doneCount = results.filter((r) => !r.pending && !r.error).length;
  const allPicked = doneCount > 0 && picked.length === doneCount;

  return (
    <div className="flex w-full flex-col gap-4 lg:flex-row lg:items-start">
      {/* LEFT — set it up. Same split as the Generate page so the two read as one app. */}
      <div className="w-full space-y-4 lg:w-[46rem] lg:shrink-0">
      <Card className="space-y-4 p-6">
        <div>
          <h3 className="text-base font-semibold uppercase tracking-wider text-zinc-200">Character</h3>
          <p className="text-sm text-zinc-500">Her saved reference photos are sent as the identity to hold.</p>
        </div>
          {/* Each character shows her own face BEFORE you pick her. Name-only chips meant choosing
              between six people by reading labels, when the whole point is that you recognise her
              on sight (owner, 2026-08-08). The tile is her BASE photo when one is marked, else her
              earliest — the same image that will lead the reference payload. */}
        {chars.length === 0 ? (
          <p className="text-xs text-zinc-500">No characters yet — add one in the Character tab first.</p>
        ) : (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {chars.map((c) => {
              const mine = items.filter((i) => i.folderId === c.id);
              const lead = mine.find((i) => i.role === 'base') || [...mine].sort((a, b) => a.createdAt - b.createdAt)[0];
              return (
                <button key={c.id} type="button" onClick={() => setCharId(c.id)}
                  className={cn('overflow-hidden rounded-xl border-2 text-left transition cursor-pointer',
                    charId === c.id ? 'border-rose-500' : 'border-white/[0.07] hover:border-zinc-600')}>
                  {lead && thumbs[lead.id]
                    ? <img src={thumbs[lead.id]} alt="" loading="lazy" className="aspect-[3/4] w-full object-cover bg-zinc-950" />
                    : <span className="flex aspect-[3/4] w-full items-center justify-center bg-white/[0.03] text-xs text-zinc-600">No photo</span>}
                  <span className={cn('block px-2 py-1.5 text-xs font-semibold',
                    charId === c.id ? 'bg-rose-500/15 text-rose-300' : 'bg-white/[0.02] text-zinc-400')}>
                    {c.name} <span className="text-zinc-600">{mine.length}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {refs.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {refs.slice(0, MAX_REFS).map((r) => (
              <span key={r.id} className="relative">
                <img src={thumbs[r.id]} alt="" loading="lazy"
                  className="h-28 w-28 rounded-lg object-cover bg-zinc-950" />
                {/* Which photo is leading — set in the Character tab, honoured here. */}
                {r.role === 'base' && (
                  <span className="absolute left-1 top-1 rounded bg-rose-500 px-1.5 py-0.5 text-[0.625rem] font-bold text-white">BASE</span>
                )}
              </span>
            ))}
            {refs.length > MAX_REFS && (
              <span className="flex h-28 items-center px-2 text-xs text-zinc-500">
                +{refs.length - MAX_REFS} over the {MAX_REFS}-image limit
              </span>
            )}
          </div>
        )}
      </Card>

      <Card className="space-y-4 p-6">
        <h3 className="text-base font-semibold uppercase tracking-wider text-zinc-200">The shot</h3>
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={6}
          placeholder="Where she is, what she is wearing, how it is shot. e.g. sitting on a hotel bed in a white tank top, soft window light, phone selfie from slightly above."
          className="w-full rounded-xl border border-white/[0.07] bg-black/30 p-4 text-base leading-relaxed text-zinc-200 placeholder:text-zinc-600 focus:border-rose-500/60 focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs uppercase tracking-wider text-zinc-500">Ratio</span>
            {RATIOS.map((r) => (
              <button key={r} type="button" onClick={() => setRatio(r)}
                className={cn('rounded-lg border px-3 py-1.5 text-sm font-semibold cursor-pointer',
                  ratio === r ? 'border-rose-500 bg-rose-500/15 text-rose-300'
                              : 'border-white/[0.07] bg-white/[0.02] text-zinc-500 hover:border-zinc-600')}>
                {r}
              </button>
            ))}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-xs uppercase tracking-wider text-zinc-500">Res</span>
            {RESOLUTIONS.map((r) => (
              <button key={r} type="button" onClick={() => setResolution(r)}
                className={cn('rounded-lg border px-3 py-1.5 text-sm font-semibold cursor-pointer',
                  resolution === r ? 'border-rose-500 bg-rose-500/15 text-rose-300'
                                   : 'border-white/[0.07] bg-white/[0.02] text-zinc-500 hover:border-zinc-600')}>
                {r}
              </button>
            ))}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-xs uppercase tracking-wider text-zinc-500">Save to</span>
            <select value={saveToId} onChange={(e) => setSaveToId(e.target.value)}
              title="Which Base Library folder new images are filed into"
              className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5 text-sm text-zinc-300 cursor-pointer">
              <option value="">Her name{charName ? ` (${charName})` : ''}</option>
              {saveFolders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-xs uppercase tracking-wider text-zinc-500">How many</span>
            {[1, 2, 4].map((n) => (
              <button key={n} type="button" onClick={() => setCount(n)}
                className={cn('rounded-lg border px-3 py-1.5 text-sm font-semibold cursor-pointer',
                  count === n ? 'border-rose-500 bg-rose-500/15 text-rose-300'
                              : 'border-white/[0.07] bg-white/[0.02] text-zinc-500 hover:border-zinc-600')}>
                {n}
              </button>
            ))}
          </span>
        </div>
        {/* Never disabled by an in-flight run — starting another while one is going is the point. */}
        <Btn className="w-full !py-3.5 !text-base" disabled={!charId || !instruction.trim()} onClick={generate}>
          {`Generate ${count} base image${count === 1 ? '' : 's'}${
            nano2Cost(resolution, count) !== null ? ` · $${nano2Cost(resolution, count).toFixed(3)}` : ''}`}
        </Btn>
        <p className="text-center text-xs text-zinc-600">
          {inFlight > 0 && <span className="text-rose-300">{inFlight} generating — start another whenever · </span>}
          Nano Banana 2 (WaveSpeed) · {resolution}{refs.length ? ` · sends all ${Math.min(refs.length, MAX_REFS)} of her reference photos` : ''} · saved into Base Library under her name.
        </p>
      </Card>

      </div>

      {/* RIGHT — what came back, and where to file it. */}
      <Card className="w-full flex-1 space-y-4 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold uppercase tracking-wider text-zinc-200">
            Generated {results.length > 0 && <span className="text-rose-400">· {results.length}</span>}
          </h3>
          {results.length > 0 && (
            <>
              <button type="button"
                onClick={() => setPicked(allPicked ? [] : results.map((_, i) => i).filter((i) => !results[i].pending && !results[i].error))}
                className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-1.5 text-sm font-semibold text-zinc-400 hover:border-zinc-600 cursor-pointer">
                {allPicked ? 'Clear' : `Select all ${results.length}`}
              </button>
              <Btn variant="secondary" className="!rounded-lg !py-2 !px-4 !text-sm ml-auto" onClick={openFolderPick}>
                Send {picked.length || results.length} to a folder
              </Btn>
            </>
          )}
        </div>

        {results.length === 0 ? (
          <p className="py-24 text-center text-sm text-zinc-600">
            Nothing yet — generated base photos land here, and are already saved to Base Library.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {results.map((r, i) => (r.error ? (
              <span key={r.key}
                className="flex aspect-[3/4] flex-col items-center justify-center gap-2 rounded-lg border-2 border-amber-500/40 bg-amber-500/[0.06] p-3 text-center">
                <span className="text-xs text-amber-200/90">{r.error}</span>
                <button type="button" onClick={() => retryOne(r.key)}
                  className="rounded-lg border border-amber-500/50 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/15 cursor-pointer">
                  Retry
                </button>
                <button type="button" onClick={() => setResults((prev) => prev.filter((x) => x.key !== r.key))}
                  className="text-[0.625rem] text-zinc-500 hover:text-zinc-300 cursor-pointer">Dismiss</button>
              </span>
            ) : r.pending ? (
              // A reserved slot, so a click has visible effect immediately instead of the panel
              // sitting empty for the length of the request.
              <span key={r.key}
                className="flex aspect-[3/4] animate-pulse items-center justify-center rounded-lg border-2 border-dashed border-white/[0.07] bg-white/[0.02] text-xs text-zinc-600">
                Generating…
              </span>
            ) : (
              <button key={r.key || i} type="button"
                onClick={() => setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]))}
                className={cn('relative overflow-hidden rounded-lg border-2 bg-zinc-950 cursor-pointer',
                  picked.includes(i) ? 'border-rose-500' : 'border-transparent hover:border-zinc-600')}>
                <img src={r.dataUrl} alt="" className="w-full object-cover" />
                {picked.includes(i) && (
                  <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-md bg-rose-500 text-[0.625rem] font-bold text-white">✓</span>
                )}
              </button>
            )))}
          </div>
        )}
      </Card>

      {/* FOLDER PICKER — the same Base Library folders the Base Library tab and the Main photo
          slot read, so a folder made here shows up in both. */}
      {folderPick && (
        <div className="fixed inset-0 z-[160] flex items-center justify-center bg-black/70 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setFolderPick(false); }}>
          <div className="w-full max-w-sm space-y-2 rounded-2xl border border-white/[0.07] bg-[#101017] p-4">
            <h3 className="text-sm font-semibold text-zinc-200">
              Move {picked.length || results.length} image{(picked.length || results.length) === 1 ? '' : 's'} to…
            </h3>
            <p className="text-xs text-zinc-500">They are already in Base Library — this just changes the folder.</p>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {baseFolders.map((f) => (
                <button key={f.id} type="button" onClick={() => fileTo(f.id)}
                  className="flex w-full items-center gap-3 rounded-lg border border-white/[0.07] bg-white/[0.02] p-2 text-left hover:border-rose-500/60 cursor-pointer">
                  {f.cover
                    ? <img src={f.cover} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-md object-cover bg-zinc-950" />
                    : <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-white/[0.04] text-[0.5rem] uppercase text-zinc-600">Empty</span>}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-zinc-200">{f.name}</span>
                    <span className="block text-xs text-zinc-500">{f.count} image{f.count === 1 ? '' : 's'}</span>
                  </span>
                </button>
              ))}
              {!baseFolders.length && <p className="px-1 py-2 text-xs text-zinc-500">No folders yet — make one below.</p>}
            </div>
            <div className="flex gap-2 pt-1">
              <Btn variant="secondary" className="flex-1 !py-1.5 !text-xs"
                onClick={async () => {
                  const name = (window.prompt('New Base Library folder name:') || '').trim();
                  if (!name) return;
                  try { const f = await baseStore.ensureFolder(name); await fileTo(f.id); }
                  catch (err) { notify(err?.message || 'Could not make that folder', 'error'); }
                }}>
                + New folder
              </Btn>
              <Btn variant="ghost" className="!py-1.5 !px-3 !text-xs" onClick={() => setFolderPick(false)}>Cancel</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
