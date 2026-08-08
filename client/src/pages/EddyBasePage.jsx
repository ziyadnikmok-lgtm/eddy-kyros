import { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, Btn, Spinner } from '../components/UI';
import { useApp } from '../context/AppContext';
import { seedream as seedreamApi } from '../services/api';
import { createEddyCollection } from '../lib/eddyCollectionStore';
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
const CHAR_DB = 'eddy-character';
const BASE_DB = 'eddy-base';

// 3:4 leads because it is the frame every downstream Eddy flow expects, but the rest are offered:
// a base shot is still a normal image and there is no reason to force a crop (owner, 2026-08-07).
const RATIOS = ['3:4', '4:5', '1:1', '9:16', '16:9', '2:3', '3:2'];
const RESOLUTIONS = ['1K', '2K'];
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
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState([]);   // [{ dataUrl }] this session

  const [picked, setPicked] = useState([]);        // result indexes ticked
  const [folderPick, setFolderPick] = useState(false);
  const [baseFolders, setBaseFolders] = useState([]);

  const openFolderPick = useCallback(async () => {
    try { setBaseFolders(await baseStore.listFolders()); } catch { setBaseFolders([]); }
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
    const rows = (picked.length ? picked : results.map((_, i) => i)).map((i) => results[i]).filter(Boolean);
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

    setBusy(true);
    const prompt = buildBasePrompt(instruction, payload.length);
    let made = 0;
    try {
      for (let n = 0; n < count; n += 1) {
        // eslint-disable-next-line no-await-in-loop -- serial on purpose: each call re-uploads and
        // polls, and this page is never asked for more than a handful at a time.
        const d = await seedreamApi.edit({
          images: payload,
          prompt,
          model: 'nano2',
          aspectRatio: ratio,
          resolution,
          tags: ['eddy', 'base'],
        });
        const first = (d?.images || [])[0];
        if (!first?.base64Data) continue;
        const dataUrl = `data:${first.mimeType || 'image/png'};base64,${first.base64Data}`;
        // Straight into Base Library, filed under the character's own name, so a generated base
        // is usable from the Generate page's Main photo slot without a save step.
        // eslint-disable-next-line no-await-in-loop
        const folder = await baseStore.ensureFolder(chars.find((c) => c.id === charId)?.name || 'Base');
        // eslint-disable-next-line no-await-in-loop
        const stored = await baseStore.addItems([{ dataUrl, prompt: instruction.trim(), name: `base-${Date.now()}` }], folder.id);
        // The Base Library row id is kept on the result. Filing it into a different folder later is
        // then a folderId update on THAT row — a move, not a second copy of the same picture.
        setResults((prev) => [{ dataUrl, itemId: stored?.[0]?.id || null }, ...prev]);
        made += 1;
      }
      notify(made ? `${made} base image${made === 1 ? '' : 's'} saved to Base Library` : 'Nothing came back', made ? 'success' : 'error');
    } catch (err) {
      notify(err?.message || 'Generation failed', 'error');
    } finally {
      setBusy(false);
    }
  }, [charId, instruction, refs, thumbs, charStore, baseStore, chars, ratio, resolution, count, notify]);

  if (loading) return <div className="flex justify-center py-16"><Spinner size={28} /></div>;

  const allPicked = results.length > 0 && picked.length === results.length;

  return (
    <div className="flex w-full flex-col gap-4 lg:flex-row lg:items-start">
      {/* LEFT — set it up. Same split as the Generate page so the two read as one app. */}
      <div className="w-full space-y-4 lg:max-w-2xl">
      <Card className="space-y-3 p-4">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">Character</h3>
          <p className="text-[0.6875rem] text-zinc-500">Her saved reference photos are sent as the identity to hold.</p>
        </div>
        {chars.length === 0 ? (
          <p className="text-xs text-zinc-500">No characters yet — add one in the Character tab first.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {chars.map((c) => (
              <button key={c.id} type="button" onClick={() => setCharId(c.id)}
                className={cn('rounded-full border px-3 py-1 text-xs font-semibold transition cursor-pointer',
                  charId === c.id ? 'border-rose-500 bg-rose-500/15 text-rose-300'
                                  : 'border-white/[0.07] bg-white/[0.02] text-zinc-400 hover:border-zinc-600')}>
                {c.name} <span className="text-zinc-600">{items.filter((i) => i.folderId === c.id).length}</span>
              </button>
            ))}
          </div>
        )}
        {refs.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {refs.slice(0, MAX_REFS).map((r) => (
              <span key={r.id} className="relative">
                <img src={thumbs[r.id]} alt="" loading="lazy"
                  className="h-16 w-16 rounded-md object-cover bg-zinc-950" />
                {/* Which photo is leading — set in the Character tab, honoured here. */}
                {r.role === 'base' && (
                  <span className="absolute left-0.5 top-0.5 rounded bg-rose-500 px-1 text-[0.5rem] font-bold text-white">BASE</span>
                )}
              </span>
            ))}
            {refs.length > MAX_REFS && (
              <span className="flex h-16 items-center px-2 text-[0.625rem] text-zinc-500">
                +{refs.length - MAX_REFS} over the {MAX_REFS}-image limit
              </span>
            )}
          </div>
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">The shot</h3>
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={4}
          placeholder="Where she is, what she is wearing, how it is shot. e.g. sitting on a hotel bed in a white tank top, soft window light, phone selfie from slightly above."
          className="w-full rounded-xl border border-white/[0.07] bg-black/30 p-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-rose-500/60 focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-[0.6875rem] uppercase tracking-wider text-zinc-500">Ratio</span>
            {RATIOS.map((r) => (
              <button key={r} type="button" onClick={() => setRatio(r)}
                className={cn('rounded-lg border px-2 py-1 text-[0.625rem] font-semibold cursor-pointer',
                  ratio === r ? 'border-rose-500 bg-rose-500/15 text-rose-300'
                              : 'border-white/[0.07] bg-white/[0.02] text-zinc-500 hover:border-zinc-600')}>
                {r}
              </button>
            ))}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-[0.6875rem] uppercase tracking-wider text-zinc-500">Res</span>
            {RESOLUTIONS.map((r) => (
              <button key={r} type="button" onClick={() => setResolution(r)}
                className={cn('rounded-lg border px-2 py-1 text-[0.625rem] font-semibold cursor-pointer',
                  resolution === r ? 'border-rose-500 bg-rose-500/15 text-rose-300'
                                   : 'border-white/[0.07] bg-white/[0.02] text-zinc-500 hover:border-zinc-600')}>
                {r}
              </button>
            ))}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-[0.6875rem] uppercase tracking-wider text-zinc-500">How many</span>
            {[1, 2, 4].map((n) => (
              <button key={n} type="button" onClick={() => setCount(n)}
                className={cn('rounded-lg border px-2 py-1 text-[0.625rem] font-semibold cursor-pointer',
                  count === n ? 'border-rose-500 bg-rose-500/15 text-rose-300'
                              : 'border-white/[0.07] bg-white/[0.02] text-zinc-500 hover:border-zinc-600')}>
                {n}
              </button>
            ))}
          </span>
        </div>
        <Btn className="w-full" disabled={busy || !charId || !instruction.trim()} onClick={generate}>
          {busy ? 'Generating…' : `Generate ${count} base image${count === 1 ? '' : 's'}`}
        </Btn>
        <p className="text-center text-[0.625rem] text-zinc-600">
          Nano Banana 2 (WaveSpeed){refs.length ? ` · sends all ${Math.min(refs.length, MAX_REFS)} of her reference photos` : ''} · saved into Base Library under her name.
        </p>
      </Card>

      </div>

      {/* RIGHT — what came back, and where to file it. */}
      <Card className="w-full flex-1 space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">
            Generated {results.length > 0 && <span className="text-rose-400">· {results.length}</span>}
          </h3>
          {results.length > 0 && (
            <>
              <button type="button"
                onClick={() => setPicked(allPicked ? [] : results.map((_, i) => i))}
                className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1 text-[0.625rem] font-semibold text-zinc-400 hover:border-zinc-600 cursor-pointer">
                {allPicked ? 'Clear' : `Select all ${results.length}`}
              </button>
              <Btn variant="secondary" className="!rounded-lg !py-1 !px-3 !text-xs ml-auto" onClick={openFolderPick}>
                Send {picked.length || results.length} to a folder
              </Btn>
            </>
          )}
        </div>

        {results.length === 0 ? (
          <p className="py-16 text-center text-xs text-zinc-600">
            Nothing yet — generated base photos land here, and are already saved to Base Library.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {results.map((r, i) => (
              // eslint-disable-next-line react/no-array-index-key -- append-only, never reordered
              <button key={i} type="button"
                onClick={() => setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]))}
                className={cn('relative overflow-hidden rounded-lg border-2 bg-zinc-950 cursor-pointer',
                  picked.includes(i) ? 'border-rose-500' : 'border-transparent hover:border-zinc-600')}>
                <img src={r.dataUrl} alt="" className="w-full object-cover" />
                {picked.includes(i) && (
                  <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-md bg-rose-500 text-[0.625rem] font-bold text-white">✓</span>
                )}
              </button>
            ))}
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
                  className="w-full rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-left text-xs text-zinc-300 hover:border-rose-500/60 cursor-pointer">
                  {f.name}
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
