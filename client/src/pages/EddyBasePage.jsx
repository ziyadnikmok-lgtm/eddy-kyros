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

const RATIOS = ['3:4', '4:5', '1:1', '9:16', '16:9'];

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
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState([]);   // [{ dataUrl }] this session

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
    // Sent as identity references, capped at 4: past that the payload gets large for no gain, and
    // the route rejects the whole request over its 60MB total.
    const payload = [];
    for (const r of refs.slice(0, 4)) {
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
          resolution: '2K',
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
        await baseStore.addItems([{ dataUrl, prompt: instruction.trim(), name: `base-${Date.now()}` }], folder.id);
        setResults((prev) => [{ dataUrl }, ...prev]);
        made += 1;
      }
      notify(made ? `${made} base image${made === 1 ? '' : 's'} saved to Base Library` : 'Nothing came back', made ? 'success' : 'error');
    } catch (err) {
      notify(err?.message || 'Generation failed', 'error');
    } finally {
      setBusy(false);
    }
  }, [charId, instruction, refs, thumbs, charStore, baseStore, chars, ratio, count, notify]);

  if (loading) return <div className="flex justify-center py-16"><Spinner size={28} /></div>;

  return (
    <div className="w-full space-y-4">
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
            {refs.slice(0, 4).map((r) => (
              <span key={r.id} className="relative">
                <img src={thumbs[r.id]} alt="" loading="lazy"
                  className="h-16 w-16 rounded-md object-cover bg-zinc-950" />
                {/* Which photo is leading — set in the Character tab, honoured here. */}
                {r.role === 'base' && (
                  <span className="absolute left-0.5 top-0.5 rounded bg-rose-500 px-1 text-[0.5rem] font-bold text-white">BASE</span>
                )}
              </span>
            ))}
            {refs.length > 4 && (
              <span className="flex h-16 items-center px-2 text-[0.625rem] text-zinc-500">
                +{refs.length - 4} not sent
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
          <span className="flex items-center gap-1.5">
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
          Saved straight into Base Library, filed under her name.
        </p>
      </Card>

      {results.length > 0 && (
        <Card className="space-y-2 p-4">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">This session</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {results.map((r, i) => (
              // eslint-disable-next-line react/no-array-index-key -- these are append-only and never reordered
              <img key={i} src={r.dataUrl} alt="" className="w-full rounded-lg bg-zinc-950 object-cover" />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
