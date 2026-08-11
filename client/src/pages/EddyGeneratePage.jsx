import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { seedream as seedreamApi, gallery as galleryApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Select, Textarea, Spinner, ImageCard } from '../components/UI';
import {
  SEEDREAM_ASPECT_RATIOS,
  SEEDREAM_RESOLUTIONS,
  SEEDREAM_MAX_IMAGES,
  seedreamCost,
} from '../config/photoModes';
import { pushPending, resolvePending, failPending } from '../lib/generationFeed';
import { detectAspectRatio } from '../lib/detectAspectRatio';
import { createEddyCollection } from '../lib/eddyCollectionStore';
import { createPageStore } from '../lib/pageStateStore';
import { cn } from '../lib/utils';

// How many generations are in flight at once. Each one re-encodes every source image server
// side, so this trades raw speed for not crashing the backend.
const PARALLEL_REQUESTS = 6;

const ASPECT_OPTIONS = [{ value: 'auto', label: 'Auto (match photo 1)' }, ...SEEDREAM_ASPECT_RATIOS.map((r) => ({ value: r, label: r }))];
const RES_OPTIONS = SEEDREAM_RESOLUTIONS.map((r) => ({ value: r, label: r }));

function parseDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  return m ? { mimeType: m[1], base64: m[2] } : null;
}

/**
 * The prompt is built here, not typed. Seedream anchors on image 1, so the subject goes first
 * and the outfit/pose images follow as things to TAKE FROM — the order is what stops her
 * identity being replaced by whoever is wearing the outfit.
 */

/**
 * A pose is stored as the full JSON prompt block, but only its pose_action.description belongs
 * in a generation.
 *
 * The rest of that block carries its OWN identity rules ("use @image1 as the strict base…"),
 * and this page already states its own — sending both means two competing instruction sets
 * about which image owns the face, which is exactly the cancelling conflict that has bitten
 * every other part of this prompt.
 *
 * Anything that is not parseable JSON is already a plain sentence and passes through untouched.
 */
function poseSentence(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('{')) return raw;
  try {
    const desc = JSON.parse(raw)?.pose_action?.description;
    if (typeof desc === 'string' && desc.trim()) return desc.trim();
  } catch {
    // Malformed JSON — the sheet's own template has a missing comma and a trailing comma, so
    // this happens for real. Fall back to pulling the field out with a pattern.
    const m = raw.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) return m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
  }
  return raw;
}

function buildPrompt({ instruction, outfitText, poseText, envText, outfitIndex, poseIndex, envIndex, faceIndex, nsfw, wantsNude, wantsBody, undressChip }) {
  const lines = [];
  // Image 1 carries who she is AND where she is; image 2 is a close-up used only to lock the
  // face. Naming each one's job stops the two references competing over the same features.
  lines.push(`The woman in image 1 is the subject. Her identity, body and skin come from image 1.${envIndex ? '' : ' The location, background and lighting of image 1 are kept as the setting.'}${wantsNude ? ' Her CLOTHING is NOT kept — see the clothing instruction below.' : ''}`);
  if (faceIndex) {
    lines.push(`Image ${faceIndex} is a close-up of the SAME woman. Use it as the exact reference for her face — bone structure, eyes, nose, lips and hairline must match it precisely. Take nothing else from it: not its background, framing, clothing or pose.`);
  }
  if (wantsBody) {
    lines.push('Her FIGURE changes as directed below, while her face and identity stay exactly as above.');
  }

  // Outfit and pose are prompts that MIX into one image. Any attached picture is only an
  // example of what the words mean, so the text leads and the image is pointed at afterwards.
  // Undressing her and dressing her cannot both be requested. If the instruction says nude,
  // the outfit stands down entirely — otherwise the prompt asks for a lace bodysuit AND for no
  // clothing at all, and the model resolves that by doing neither properly.
  if (outfitText && !wantsNude) lines.push(`OUTFIT: ${outfitText}`);

  if ((outfitText || outfitIndex) && !wantsNude) lines.push('Ignore whatever she is wearing in her reference photos — her clothing comes only from the outfit described above.');
  if (poseText) lines.push(`POSE: ${poseText}`);
  if (poseIndex) {
    lines.push(`Image ${poseIndex} is a POSE DIAGRAM, not a person. A DIFFERENT woman appears in it and she is NOT the subject — she is a stand-in showing the shape to copy.`);
    lines.push(`Recreate her pose EXACTLY: same body position, same limb placement, same arch and twist, same head angle and gaze direction, and the same camera angle, distance and framing.`);
    // Stated after the pose clause on purpose. The face lock was being set out early and then
    // buried under later instructions, and the model kept taking the stand-in's face.
    lines.push(`The face and body of the woman in image ${poseIndex} must NOT appear in the result. Her face is not the subject's face. Copy her POSITION and the CAMERA, nothing about who she is.`);
  }

  // Nothing pins her clothing when no outfit is chosen — deliberately. The model is left free
  // to follow the pose and the references, which sometimes undresses her. That was reported as
  // a bug once and then asked for on purpose: pick an outfit to be sure, or leave it open.

  if (envIndex) {
    lines.push(`Image ${envIndex} is the LOCATION. Place the woman inside that location: its room, walls, furniture, surfaces, props and lighting all come from image ${envIndex}, not from image 1. Match its light direction, colour temperature and time of day so she looks genuinely photographed there.`);
    lines.push(`NOBODY in image ${envIndex} is the subject. If a person appears in it, ignore them completely — take only the place. The woman in the result is the woman from image 1.`);
  } else if (envText) {
    lines.push(`SETTING: ${envText}`);
  }

  if (instruction.trim()) lines.push(instruction.trim());
  // NSFW off adds nothing: the outfit rules already keep her dressed, and a "no nudity" line on
  // top of them only spends prompt on a restriction nobody asked for.
  if (nsfw && !undressChip) {
    // NSFW with no undress chip picked still means naked — the toggle IS the instruction.
    // Passed in rather than read from a module const so this function stays self-contained.
    lines.push('REMOVE ALL CLOTHING: she is completely naked. Take off every garment she is wearing in image 1 — top, bottom, underwear, straps, everything. Bare skin where those clothes were, with her natural body underneath. No fabric anywhere on her.');
  }

  // Seedream defaults to a shallow portrait look and blurs whatever is behind her. Stated as a
  // positive instruction AND a ban, because naming the effect alone tends to invite it.
  lines.push(envIndex
    ? `THE SETTING COMES FROM IMAGE ${envIndex} AND NOTHING ELSE: the room, background, surfaces, props and lighting all come from image ${envIndex}. Image 1 contributes the woman only — none of its background appears.`
    : 'THE SETTING COMES FROM IMAGE 1 AND NOTHING ELSE: the room, background, surfaces, props and lighting all come from image 1. No other reference image contributes any part of the scene.');
  lines.push('Keep the ENTIRE background sharp and in focus, fully detailed edge to edge — no bokeh, no depth-of-field blur, no soft or out-of-focus background.');
  lines.push(faceIndex
    ? 'FINAL CHECK: the woman in the result is the woman from image 1 and image 2. Her face must match image 2. No other face from any reference may appear.'
    : 'FINAL CHECK: the woman in the result is the woman from image 1. Her face must match image 1. No other face from any reference may appear.');
  lines.push('Photorealistic: real skin texture with pores, natural hair, slight asymmetry. No plastic or CGI look.');
  return lines.join(' ');
}


// Built-in outfits and poses, always offered in the pickers alongside anything you save in the
// Eddy tabs. They exist so Generate is usable with zero setup — an empty picker reads as
// "broken" even when it is only empty. They carry no image: a preset is words, and attaching a
// stock photo would send a stranger's body into the edit.

// One-tap additions to the instruction. Each states the change in ABSOLUTE terms — "a LARGE
// bust" rather than "bigger" — because Seedream reads comparatives against nothing and ignores
// them.
const INSTRUCTION_PRESETS = [
  { group: 'Body', chips: [
    ['Bigger bust', 'She has a LARGE full bust with deep natural cleavage.'],
    ['Much bigger bust', 'She has a VERY LARGE heavy bust, noticeably fuller than in the photo, with deep cleavage.'],
    ['Curvier', 'She has a curvier hourglass figure — fuller bust and hips with a narrow waist.'],
    ['Slimmer', 'She has a slimmer, more slender figure.'],
  ] },
  { group: 'Sexual', nsfwOnly: true, chips: [
    ['Topless', 'Remove her top and bra completely — she is topless, bare breasts fully exposed, no fabric above the waist.'],
    ['Fully nude', 'Remove every garment she is wearing — she is completely naked, no clothing anywhere on her body.'],
    ['Legs spread', 'She is lying back with her legs spread wide open.'],
    ['Arched back', 'Her back is deeply arched, chest pushed forward and hips raised.'],
    ['On all fours', 'She is on all fours, looking back over her shoulder at the camera.'],
  ] },
  { group: 'Expression', chips: [
    ['Seductive', 'A sultry heavy-lidded seductive look straight down the lens, lips slightly parted.'],
    ['Biting lip', 'She is biting her lower lip, heavy-lidded eyes locked on the camera.'],
    ['Moaning', 'Her mouth is open in a soft moan, eyes half-closed, head tilted back in pleasure.'],
    ['Ahegao', 'An ahegao expression — eyes rolled upward, tongue out, cheeks deeply flushed.'],
    ['Flushed', 'Flushed cheeks, breathless parted lips, aroused heavy-lidded eyes.'],
    ['Innocent', 'Wide innocent doe eyes and softly parted lips, looking up at the camera.'],
    ['Tongue out', 'Her tongue is out, extended past her lower lip, eyes on the camera.'],
    ['Mouth open', 'Her mouth is open wide, jaw relaxed, looking straight at the camera.'],
  ] },
  { group: 'Skin', chips: [
    ['Oiled', 'Her skin is glistening with body oil, catching the light.'],
    ['Wet look', 'She is soaking wet, water running over her skin and hair.'],
    ['Sweaty glow', 'A light sheen of sweat across her skin, glowing under the light.'],
    ['Deeper tan', 'She has a deep sun-kissed tan.'],
  ] },
];

// The chips that REMOVE clothing. If one of these is in the instruction, the "keep her outfit"
// rule must stand down instead of fighting it.
const BODY_CHANGE_TEXTS = [
  'She has a LARGE full bust with deep natural cleavage.',
  'She has a VERY LARGE heavy bust, noticeably fuller than in the photo, with deep cleavage.',
  'She has a curvier hourglass figure — fuller bust and hips with a narrow waist.',
  'She has a slimmer, more slender figure.',
];

const UNDRESS_TEXTS = [
  'Remove her top and bra completely — she is topless, bare breasts fully exposed, no fabric above the waist.',
  'Remove every garment she is wearing — she is completely naked, no clothing anywhere on her body.',
];

/**
 * One source photo, with the ones you have used before kept underneath it.
 *
 * Image 1 sets identity AND the setting; image 2 is a close-up that pins the face. Both keep
 * their own history in IndexedDB, so a face you shot once is one click away forever instead of
 * being re-dropped every session. Anything in Eddy's Library can be pulled in too.
 */
function ImageSlot({ title, hint, value, onChange, dbName, libraryStore }) {
  const { notify } = useApp();
  const store = useMemo(() => createEddyCollection(dbName), [dbName]);
  const [saved, setSaved] = useState([]);          // [{ id, dataUrl }]
  const [over, setOver] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [library, setLibrary] = useState([]);

  const refresh = useCallback(async () => {
    const items = await store.listItems();
    const rows = await Promise.all(items.map(async (it) => ({ id: it.id, dataUrl: it.url || await store.getImage(it.id) })));
    setSaved(rows.filter((r) => r.dataUrl));
  }, [store]);

  useEffect(() => { refresh(); }, [refresh]);

  // Remember every photo that gets used here, but never twice.
  const use = useCallback(async (dataUrl) => {
    if (!dataUrl) return;
    onChange(dataUrl);
    try {
      const items = await store.listItems();
      const existing = await Promise.all(items.map((it) => store.getImage(it.id)));
      if (existing.includes(dataUrl)) return;
      await store.addItems([{ dataUrl, name: dbName }]);
      await refresh();
    } catch (err) {
      // Failing to remember it must not stop you using it.
      notify(err.message || 'Could not save that to the strip', 'error');
    }
  }, [onChange, store, dbName, refresh, notify]);

  const take = (file) => {
    if (!file || !/^image\/(png|jpe?g|webp)$/i.test(file.type)) return;
    const r = new FileReader();
    r.onload = () => use(r.result);
    r.readAsDataURL(file);
  };

  const openLibrary = async () => {
    if (showLibrary) { setShowLibrary(false); return; }
    const items = await libraryStore.listItems();
    const rows = await Promise.all(items.map(async (it) => ({ id: it.id, src: it.url || await libraryStore.getImage(it.id) })));
    setLibrary(rows.filter((r) => r.src));
    setShowLibrary(true);
  };

  // A Library entry is a URL to the server copy, so it has to be fetched before it can be sent.
  const pickFromLibrary = async (src) => {
    try {
      if (src.startsWith('data:')) { await use(src); setShowLibrary(false); return; }
      const blob = await (await fetch(src, { credentials: 'include' })).blob();
      const reader = new FileReader();
      reader.onload = () => { use(reader.result); setShowLibrary(false); };
      reader.readAsDataURL(blob);
    } catch {
      notify('Could not load that image', 'error');
    }
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); take(e.dataTransfer?.files?.[0]); }}
      onPaste={(e) => {
        const f = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'))?.getAsFile();
        if (f) { e.preventDefault(); take(f); }
      }}
      tabIndex={0}
      className={cn('rounded-xl border p-2 transition outline-none',
        over ? 'border-rose-500 ring-2 ring-rose-500/40' : 'border-white/[0.07] focus:border-rose-500/60')}
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-zinc-300">{title}</span>
        <span className="flex items-center gap-2">
          <button onClick={openLibrary} className="text-[0.6875rem] text-zinc-500 hover:text-white cursor-pointer">
            {showLibrary ? 'Close' : 'Library'}
          </button>
          {value && (
            <button onClick={() => onChange('')} className="text-[0.6875rem] text-zinc-500 hover:text-red-400 cursor-pointer">Clear</button>
          )}
        </span>
      </div>

      {value ? (
        <img src={value} alt="" className="aspect-[3/4] w-full rounded-lg object-cover bg-zinc-950" />
      ) : (
        <label className="flex aspect-[3/4] cursor-pointer flex-col items-center justify-center rounded-lg bg-white/[0.02] px-3 text-center transition hover:bg-white/[0.05]">
          <span className="text-xs text-zinc-500">Drop, paste or click</span>
          <span className="mt-1 text-[0.625rem] text-zinc-600">{hint}</span>
          <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
            onChange={(e) => { take(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      )}

      {showLibrary && (
        <div className="mt-2 grid [grid-template-columns:repeat(auto-fill,minmax(56px,1fr))] gap-1.5 max-h-[180px] overflow-y-auto pr-1">
          {!library.length
            ? <p className="col-span-full py-3 text-center text-[0.6875rem] text-zinc-600">Eddy Library is empty.</p>
            : library.map((l) => (
              <button key={l.id} onClick={() => pickFromLibrary(l.src)}
                className="aspect-square overflow-hidden rounded-md border border-zinc-800/60 transition hover:border-rose-500/60 cursor-pointer">
                <img src={l.src} alt="" className="h-full w-full object-cover bg-zinc-950" loading="lazy" />
              </button>
            ))}
        </div>
      )}

      {saved.length > 0 && (
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
          {saved.map((sv) => (
            <span key={sv.id} className="group relative shrink-0">
              <button onClick={() => onChange(sv.dataUrl)}
                className={cn('block h-12 w-12 overflow-hidden rounded-md border transition cursor-pointer',
                  value === sv.dataUrl ? 'border-rose-500 ring-2 ring-rose-500/40' : 'border-zinc-800/60 hover:border-zinc-600')}>
                <img src={sv.dataUrl} alt="" className="h-full w-full object-cover bg-zinc-950" />
              </button>
              <button
                onClick={async () => { await store.removeItem(sv.id); await refresh(); }}
                title="Forget this one"
                className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border border-zinc-600 bg-zinc-900 text-[0.5625rem] text-zinc-400 hover:text-red-400 group-hover:flex cursor-pointer"
              >×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** A tile you click to pick things out of one of Eddy's collections. */
function PickerGrid({ items, thumbs, selected, onToggle, empty }) {
  if (!items.length) return <p className="py-6 text-center text-xs text-zinc-600">{empty}</p>;
  return (
    <div className="grid [grid-template-columns:repeat(auto-fill,minmax(112px,1fr))] gap-2 max-h-[460px] overflow-y-auto pr-1">
      {items.map((it) => {
        const on = selected.includes(it.id);
        return (
          <button key={it.id} onClick={() => onToggle(it.id)}
            className={cn('relative aspect-square overflow-hidden rounded-lg border transition cursor-pointer',
              on ? 'border-rose-500 ring-2 ring-rose-500/40' : 'border-zinc-800/60 hover:border-zinc-600')}>
            {thumbs[it.id] ? (
              <img src={thumbs[it.id]} alt="" className="h-full w-full object-cover bg-zinc-950" loading="lazy" />
            ) : (
              // Prompt-only entry: show the words, since there is no picture to show.
              <span className="flex h-full w-full items-center bg-white/[0.03] p-1.5 text-left text-[0.5625rem] leading-tight text-zinc-400 line-clamp-5">
                {it.prompt || 'Empty prompt'}
              </span>
            )}
            {on && <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-[0.625rem] font-bold text-white">✓</span>}
            {thumbs[it.id] && it.prompt && (
              <span className="absolute inset-0 flex items-center bg-black/80 p-1.5 text-left text-[0.5625rem] leading-tight text-zinc-200 opacity-0 transition-opacity hover:opacity-100 line-clamp-6">
                {it.prompt}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

const stateStore = createPageStore('eddy-generate-state');
const _cache = {
  baseImage: '', faceImage: '', pickedOutfits: [], pickedPoses: [], pickedEnvs: [], instruction: '',
  nsfw: false, aspectRatio: 'auto', resolution: '1K',
};

export default function EddyGeneratePage() {
  const { notify } = useApp();
  const outfitStore = useMemo(() => createEddyCollection('eddy-outfit'), []);
  const poseStore = useMemo(() => createEddyCollection('eddy-pose'), []);
  const envStore = useMemo(() => createEddyCollection('eddy-environment'), []);
  const libraryStore = useMemo(() => createEddyCollection('eddy-library'), []);

  const [outfits, setOutfits] = useState([]);
  const [outfitThumbs, setOutfitThumbs] = useState({});
  const [poses, setPoses] = useState([]);
  const [environments, setEnvironments] = useState([]);
  const [envThumbs, setEnvThumbs] = useState({});
  // Folder chips above each picker. null = All, so an unfiltered picker behaves as before.
  const [outfitFolders, setOutfitFolders] = useState([]);
  const [poseFolders, setPoseFolders] = useState([]);
  const [envFolders, setEnvFolders] = useState([]);
  const [folderFilter, setFolderFilter] = useState({ outfit: null, pose: null, environment: null });
  const [poseThumbs, setPoseThumbs] = useState({});
  const [loading, setLoading] = useState(true);

  const [baseImage, setBaseImage] = useState(_cache.baseImage);   // identity + setting
  const [faceImage, setFaceImage] = useState(_cache.faceImage);   // close-up, face only
  const [pickedOutfits, setPickedOutfits] = useState(_cache.pickedOutfits);
  const [pickedPoses, setPickedPoses] = useState(_cache.pickedPoses);
  const [pickedEnvs, setPickedEnvs] = useState(_cache.pickedEnvs || []);
  // Both pickers start open — the work is choosing, so hiding it behind a click was friction.
  const [openPickers, setOpenPickers] = useState({ outfit: true, pose: true });
  const [instruction, setInstruction] = useState(_cache.instruction);
  const [nsfw, setNsfw] = useState(_cache.nsfw);
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [resolution, setResolution] = useState(_cache.resolution);
  const [inFlight, setInFlight] = useState(0);
  const [queued, setQueued] = useState(0);
  const [done, setDone] = useState(0);
  const [results, setResults] = useState([]);
  // Once per batch, not once per combo: 25 identical toasts would bury the message.
  const warnedProvider = useRef(false);

  // Re-read on every open, not just on mount. The page keeps a snapshot of the collections,
  // so an outfit added AFTER this page first loaded was invisible until a full reload.
  const loadAll = useCallback(async () => {
    // A character IS a folder in Eddy's Character tab; her images are its contents, oldest
    // first so the base image she was built from stays image 1.
    const [oItems, pItems, eItems, oFolders, pFolders, eFolders] = await Promise.all([
      outfitStore.listItems(), poseStore.listItems(), envStore.listItems(),
      outfitStore.listFolders(), poseStore.listFolders(), envStore.listFolders(),
    ]);
    setEnvironments(eItems);
    setEnvFolders(eFolders);
    setOutfitFolders(oFolders);
    setPoseFolders(pFolders);
    // An outfit is only usable if it has an image; a pose is usable with an image OR a prompt.
    setOutfits(oItems);
    setPoses(pItems);
    const oT = {}; const pT = {}; const eT = {};
    await Promise.all([
      ...oItems.map(async (i) => { oT[i.id] = await outfitStore.getImage(i.id); }),
      ...pItems.map(async (i) => { pT[i.id] = await poseStore.getImage(i.id); }),
      ...eItems.map(async (i) => { eT[i.id] = await envStore.getImage(i.id); }),
    ]);
    setOutfitThumbs(oT);
    setPoseThumbs(pT);
    setEnvThumbs(eT);
    setLoading(false);
  }, [outfitStore, poseStore]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Reset the tally once everything has drained, from an effect rather than from inside a
  // state updater — updaters must be pure, and React replays them.
  useEffect(() => {
    if (inFlight === 0) { setDone(0); setQueued(0); }
  }, [inFlight]);

  // A reload aborts the in-flight request, and it is the browser that files the result into
  // the Library. The picture is still saved server side, but the tab has to be told.
  useEffect(() => {
    if (!inFlight) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [inFlight]);

  // Restore the last selection once on mount. Only fills fields still at their defaults, so a
  // slow read can't overwrite something typed while it was in flight.
  useEffect(() => {
    let alive = true;
    (async () => {
      const saved = await stateStore.get('state', null);
      if (!alive || !saved) return;
      setBaseImage((v) => v || saved.baseImage || '');
      setFaceImage((v) => v || saved.faceImage || '');
      setPickedOutfits((v) => (v.length ? v : saved.pickedOutfits || []));
      setPickedPoses((v) => (v.length ? v : saved.pickedPoses || []));
      setPickedEnvs((v) => (v.length ? v : saved.pickedEnvs || []));
      setInstruction((v) => (v ? v : saved.instruction || ''));
      setNsfw((v) => v || !!saved.nsfw);
      setAspectRatio((v) => (v !== 'auto' ? v : saved.aspectRatio || 'auto'));
      setResolution((v) => (v !== '1K' ? v : saved.resolution || '1K'));
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const snap = { baseImage, faceImage, pickedOutfits, pickedPoses, pickedEnvs, instruction, nsfw, aspectRatio, resolution };
    Object.assign(_cache, snap);
    stateStore.set('state', snap);
  }, [baseImage, faceImage, pickedOutfits, pickedPoses, pickedEnvs, instruction, nsfw, aspectRatio, resolution]);

  // Re-reading when the window regains focus covers adding an outfit in another tab/window.
  useEffect(() => {
    const onFocus = () => { loadAll(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadAll]);


  // No outfit or no pose still counts as one run — the cross product just collapses to 1.
  const combos = useMemo(() => {
    const os = pickedOutfits.length ? pickedOutfits : [null];
    const ps = pickedPoses.length ? pickedPoses : [null];
    const es = pickedEnvs.length ? pickedEnvs : [null];
    return os.flatMap((o) => ps.flatMap((p) => es.map((e) => ({ outfitId: o, poseId: p, envId: e }))));
  }, [pickedOutfits, pickedPoses, pickedEnvs]);

  const sourceImages = [baseImage, faceImage].filter(Boolean);
  const perRunImages = sourceImages.length + (pickedPoses.length ? 1 : 0) + (pickedEnvs.length ? 1 : 0);
  const overCap = perRunImages > SEEDREAM_MAX_IMAGES;
  const totalCost = combos.length * seedreamCost(resolution, Math.max(1, perRunImages));

  // Shows the real assembled prompt for the first combo, so what lands at Seedream is never a
  // mystery. Built with the same buildPrompt the run loop uses -- a separate "preview" version
  // would drift out of sync with what is actually sent.
  // The toggle is the switch: NSFW on means she is undressed. The Topless chip narrows that to
  // topless; with no chip at all it is full nudity.
  const undressChip = UNDRESS_TEXTS.some((t) => instruction.includes(t));
  const wantsNude = nsfw || undressChip;
  const wantsBody = BODY_CHANGE_TEXTS.some((t) => instruction.includes(t));

  const previewPrompt = useMemo(() => {
    const first = combos[0];
    if (!first) return '';
    const o = outfits.find((x) => x.id === first.outfitId);
    const ps = poses.find((x) => x.id === first.poseId);
    const ev = environments.find((x) => x.id === first.envId);
    const charCount = sourceImages.length || 1;
    return buildPrompt({
      instruction,
      outfitText: o?.prompt?.trim() || '',
      poseText: ps?.prompt?.trim() || '',
      // Index numbers only apply when an item has a real stored image; presets have none.
      outfitIndex: 0,   // outfit is prompt-only — its image is never sent
      poseIndex: ps && poseThumbs[ps.id] ? charCount + 1 : 0,
      faceIndex: faceImage ? 2 : 0,
      nsfw,
      wantsNude,
      wantsBody,
      undressChip,
    });
  }, [combos, outfits, poses, environments, instruction, sourceImages.length, faceImage, outfitThumbs, poseThumbs, envThumbs, nsfw, wantsNude, wantsBody, undressChip]);

  const addChip = (text) => setInstruction((prev) => (prev.includes(text) ? prev : `${prev} ${text}`.trim()));

  const toggle = (setter) => (id) => setter((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const run = useCallback(async () => {
    if (!baseImage) { notify('Add the main photo first', 'error'); return; }
    if (overCap) { notify(`That's ${perRunImages} images per run — Seedream takes ${SEEDREAM_MAX_IMAGES}`, 'error'); return; }

    // Outside any try before, so a rejection here made the Generate button look dead.
    let ratio = aspectRatio;
    if (aspectRatio === 'auto') {
      try {
        ratio = await detectAspectRatio(baseImage, SEEDREAM_ASPECT_RATIOS, '1:1');
      } catch {
        ratio = '1:1';
      }
    }

    // Nothing is reset here: another batch may still be running and its results and counters
    // must survive this one starting.
    setInFlight((n) => n + 1);
    setQueued((n) => n + combos.length);
    warnedProvider.current = false;

    const charPayload = sourceImages.map(parseDataUrl).filter(Boolean);
    const out = [];

    // Results file themselves under the character's name — Grace's go to "Grace", Gwen's to
    // "Gwen". Resolved once per run so a 25-image batch doesn't hunt for it 25 times.
    let libFolderId = null;
    try {
      libFolderId = (await libraryStore.ensureFolder(nsfw ? 'Eddy NSFW' : 'Eddy'))?.id || null;
    } catch {
      // Filing is a convenience; a failure here must not cost you the generation.
    }

    const runCombo = async (combo) => {
      const payload = [...charPayload];
      const outfitIndex = 0;   // outfit images are never sent
      let poseIndex = 0;
      let envIndex = 0;

      let outfitText = '';
      if (combo.outfitId) {
        // Outfit is words only. Its photo is a product shot — a garment on a mannequin with a
        // bed behind it — and that background kept arriving with the garment.
        outfitText = outfits.find((o) => o.id === combo.outfitId)?.prompt?.trim() || '';
      }
      let poseText = '';
      if (combo.poseId) {
        // The pose photo IS sent: a body position is far easier to copy than to describe, so
        // the picture does the work the words cannot.
        poseText = poseSentence(poses.find((p) => p.id === combo.poseId)?.prompt);
        const img = parseDataUrl(await poseStore.getImage(combo.poseId));
        if (img) { payload.push(img); poseIndex = payload.length; }
      }

      let envText = '';
      if (combo.envId) {
        // The environment photo IS sent, like the pose. A described room comes back generic;
        // a shown room comes back as that room. Text is the fallback when there is no image.
        envText = environments.find((e) => e.id === combo.envId)?.prompt?.trim() || '';
        const img = parseDataUrl(await envStore.getImage(combo.envId));
        if (img) { payload.push(img); envIndex = payload.length; }
      }

      const prompt = buildPrompt({ instruction, outfitText, poseText, envText, outfitIndex, poseIndex, envIndex, faceIndex: faceImage ? 2 : 0, nsfw, wantsNude, wantsBody, undressChip });

      const feedId = `eddy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      pushPending({ id: feedId, prompt, imageModel: 'Seedream 5.0 Pro Edit', aspectRatio: ratio, resolutionTier: resolution });

      // Only the API call is in the try. Wrapping the success path too meant a throw AFTER the
      // image came back marked a generation you already paid for as failed.
      let data;
      try {
        data = await seedreamApi.edit({ images: payload, prompt, aspectRatio: ratio, resolution, tags: ['eddy'] });
      } catch (err) {
        // One bad combo shouldn't abandon the rest — show why it died and keep going.
        failPending(feedId, err?.message || 'Generation failed');
        setDone((n) => n + 1);
        return;
      }

      if (data.provider === 'muapi' && !warnedProvider.current) {
        warnedProvider.current = true;
        notify('No WaveSpeed key — running on Muapi, which rejects long prompts. Add the key in API Keys.', 'error');
      }

      try {
        const first = (data.images || [])[0];
        if (first) {
          resolvePending(feedId, {
            galleryId: first.galleryId,
            imageId: first.imageId,
            prompt,
            imageModel: 'Seedream 5.0 Pro Edit',
            aspectRatio: ratio,
            resolutionTier: resolution,
            mimeType: first.mimeType,
            generatedAt: Date.now(),
          });
          out.push(first);
          setResults((prev) => [first, ...prev]);
          // Everything Eddy makes shows up in Eddy's Library. Stored as a reference to the
          // server copy, not as bytes, so a 25-image batch costs the browser almost nothing.
          if (first.galleryId) {
            try {
              await libraryStore.addItems([{ url: galleryApi.imageUrl(first.galleryId), prompt, name: `eddy-${Date.now()}` }], libFolderId);
            } catch {
              // The picture is safe in the main gallery either way — never fail a run over this.
            }
          }
        } else {
          failPending(feedId, 'Seedream returned no image');
        }
      } catch (err) {
        // The picture exists and is billed; only the bookkeeping broke.
        notify(`Saved to the gallery but not to Eddy: ${err?.message || 'unknown error'}`, 'error');
      }
      setDone((n) => n + 1);
    };

    // Fire them together rather than one after another. Capped, not unlimited: each request
    // makes the backend re-encode every source image with sharp, so 30 at once meant ~150
    // simultaneous conversions — and this backend has already died twice today. The cap keeps
    // a big batch fast without knocking the server over.
    let cursor = 0;
    try {
      await Promise.all(
        Array.from({ length: Math.min(PARALLEL_REQUESTS, combos.length) }, async () => {
          while (cursor < combos.length) {
            const mine = combos[cursor];
            cursor += 1;
            await runCombo(mine);
          }
        }),
      );
    } finally {
      // finally, always: a rejection anywhere in the pool skipped this, leaving the counter
      // stuck above zero -- permanent "1 batch running" plus a beforeunload warning on every
      // navigation for the rest of the session.
      setInFlight((n) => n - 1);
    }
    if (out.length === combos.length) notify(`${out.length} image${out.length === 1 ? '' : 's'} done ✨`, 'success');
    else if (out.length) notify(`${out.length} of ${combos.length} done — the rest failed`, 'error');
    else notify('Every generation failed', 'error');
  }, [baseImage, sourceImages, combos, instruction, nsfw, wantsNude, wantsBody, undressChip, aspectRatio, resolution, overCap, perRunImages, outfits, poses, environments, outfitStore, poseStore, envStore, libraryStore, notify]);

  if (loading) return <div className="flex justify-center py-16"><Spinner size={28} /></div>;

  return (
    <div className="mx-auto max-w-3xl space-y-4 animate-in">
      {/* The two source photos */}
      <Card className="p-4 space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">Photos</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <ImageSlot
            title="1 · Main photo"
            hint="Her body, and the room this shot happens in"
            value={baseImage}
            onChange={setBaseImage}
            dbName="eddy-slot-base"
            libraryStore={libraryStore}
          />
          <ImageSlot
            title="2 · Face close-up"
            hint="Optional — locks her face"
            value={faceImage}
            onChange={setFaceImage}
            dbName="eddy-slot-face"
            libraryStore={libraryStore}
          />
        </div>
      </Card>

      {/* Outfit + pose slots */}
      <div className="grid gap-3 sm:grid-cols-2">
        {[
          { key: 'outfit', label: 'Outfit', picked: pickedOutfits, items: outfits, thumbs: outfitThumbs, folders: outfitFolders, empty: 'Nothing in Eddy · Outfit yet.' },
          { key: 'pose', label: 'Pose', picked: pickedPoses, items: poses, thumbs: poseThumbs, folders: poseFolders, empty: 'Nothing in Eddy · Pose yet.' },
          { key: 'environment', label: 'Environment', picked: pickedEnvs, items: environments, thumbs: envThumbs, folders: envFolders, empty: 'Nothing in Eddy · Environment yet.' },
        ].map((slot) => (
          <Card key={slot.key} className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">
                {slot.label} {slot.picked.length > 0 && <span className="text-rose-400">· {slot.picked.length}</span>}
              </h3>
              <Btn variant="secondary" className="!rounded-lg !py-1 !px-3 !text-xs"
                onClick={() => { if (!openPickers[slot.key]) loadAll(); setOpenPickers((o) => ({ ...o, [slot.key]: !o[slot.key] })); }}>
                {openPickers[slot.key] ? 'Hide' : 'Choose'}
              </Btn>
            </div>

            {slot.picked.length > 0 && (
              <div className="space-y-1.5">
                {slot.picked.map((id) => {
                  const it = slot.items.find((i) => i.id === id);
                  return (
                    <div key={id} className="flex items-start gap-2 rounded-lg bg-white/[0.02] p-1.5">
                      {slot.thumbs[id]
                        ? <img src={slot.thumbs[id]} alt="" className="h-12 w-12 shrink-0 rounded-md object-cover bg-zinc-950" />
                        : <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-white/[0.04] text-[0.5rem] uppercase text-zinc-600">No pic</span>}
                      <p className="line-clamp-3 text-[0.625rem] leading-tight text-zinc-400">{it?.prompt || 'Empty prompt'}</p>
                      <button onClick={() => toggle(slot.key === 'outfit' ? setPickedOutfits : slot.key === 'pose' ? setPickedPoses : setPickedEnvs)(id)}
                        className="ml-auto shrink-0 px-1 text-xs text-zinc-600 hover:text-red-400 cursor-pointer" title="Remove">×</button>
                    </div>
                  );
                })}
              </div>
            )}

            {openPickers[slot.key] && slot.folders.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {[{ id: null, name: 'All' }, ...slot.folders].map((f) => {
                  const active = folderFilter[slot.key] === f.id;
                  // Counting per folder so an empty one is obvious before you click it.
                  const n = f.id ? slot.items.filter((i) => i.folderId === f.id).length : slot.items.length;
                  return (
                    <button key={f.id || 'all'} type="button"
                      onClick={() => setFolderFilter((prev) => ({ ...prev, [slot.key]: f.id }))}
                      className={cn('rounded-full border px-2.5 py-1 text-[0.625rem] font-semibold transition cursor-pointer',
                        active ? 'border-rose-500/60 bg-rose-500/15 text-rose-300'
                               : 'border-white/[0.07] bg-white/[0.02] text-zinc-400 hover:border-zinc-600')}>
                      {f.name} <span className="text-zinc-600">{n}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {openPickers[slot.key] && (
              <PickerGrid
                items={folderFilter[slot.key]
                  ? slot.items.filter((i) => i.folderId === folderFilter[slot.key])
                  : slot.items}
                thumbs={slot.thumbs}
                selected={slot.picked}
                onToggle={toggle(slot.key === 'outfit' ? setPickedOutfits : slot.key === 'pose' ? setPickedPoses : setPickedEnvs)}
                empty={slot.empty}
              />
            )}
          </Card>
        ))}
      </div>

      {/* Instruction — the only text you write */}
      <Card className="p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">
          Instruction <span className="font-normal normal-case text-zinc-600">optional</span>
        </h3>
        <button
          onClick={() => setNsfw((v) => !v)}
          aria-pressed={nsfw}
          className={cn(
            'group flex items-center gap-3 rounded-xl border px-3 py-2 transition cursor-pointer',
            nsfw
              ? 'border-rose-500/60 bg-rose-500/10 shadow-[0_0_22px_-6px] shadow-rose-500/70'
              : 'border-white/[0.07] bg-white/[0.02] hover:border-zinc-600',
          )}
        >
          <span className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors',
            nsfw ? 'bg-rose-500' : 'bg-zinc-700')}>
            <span className={cn(
              'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
              nsfw ? 'left-[22px]' : 'left-0.5',
            )} />
          </span>
          <span className="text-left leading-tight">
            <span className={cn('block text-sm font-bold tracking-wide',
              nsfw ? 'text-rose-300' : 'text-zinc-400')}>
              NSFW {nsfw ? 'ON' : 'OFF'}
            </span>
            <span className="block text-[0.625rem] text-zinc-500">
              {nsfw ? 'She is NUDE · files under Eddy NSFW' : 'She stays clothed'}
            </span>
          </span>
        </button>
        </div>
        <div className="space-y-2">
          {INSTRUCTION_PRESETS.filter((g) => nsfw || !g.nsfwOnly).map((g) => (
            <div key={g.group} className="flex flex-wrap items-center gap-1.5">
              <span className="w-16 shrink-0 text-[0.625rem] font-semibold uppercase tracking-wider text-zinc-600">{g.group}</span>
              {g.chips.map(([label, text]) => (
                <button key={label} onClick={() => addChip(text)}
                  className="rounded-full border border-zinc-700/60 bg-white/[0.02] px-2.5 py-1 text-[0.6875rem] text-zinc-400 transition hover:border-rose-500/60 hover:text-white cursor-pointer">
                  + {label}
                </button>
              ))}
            </div>
          ))}
        </div>
        <Textarea rows={3} value={instruction} onChange={(e) => setInstruction(e.target.value)}
          placeholder="Tap a preset above, or describe it yourself…" className="!text-sm" />
      </Card>

      {/* The prompt that will actually be sent */}
      <Card className="p-4 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">Final prompt</h3>
          {combos.length > 1 && <span className="text-[0.6875rem] text-zinc-600">first of {combos.length} — each combo differs</span>}
        </div>
        <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white/[0.02] p-3 text-xs leading-relaxed text-zinc-400">
          {previewPrompt || 'Add the main photo to see the prompt.'}
        </p>
      </Card>

      {/* Settings + go */}
      <Card className="p-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Aspect Ratio" options={ASPECT_OPTIONS} value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)} />
          <Select label="Resolution" options={RES_OPTIONS} value={resolution} onChange={(e) => setResolution(e.target.value)} />
        </div>

        {overCap && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            {perRunImages} images per run — Seedream takes {SEEDREAM_MAX_IMAGES}. Use fewer outfits or poses.
          </p>
        )}

        <p className="text-xs text-zinc-500">
          {pickedOutfits.length || 1} outfit{(pickedOutfits.length || 1) === 1 ? '' : 's'} × {pickedPoses.length || 1} pose{(pickedPoses.length || 1) === 1 ? '' : 's'} = <span className="text-zinc-300">{combos.length} image{combos.length === 1 ? '' : 's'}</span>
        </p>

        <Btn className="w-full" disabled={!baseImage || overCap} onClick={run}>
          Generate {combos.length} image{combos.length === 1 ? '' : 's'} · ${totalCost.toFixed(3)}
        </Btn>
        {inFlight > 0 && (
          <p className="text-center text-xs text-zinc-500">
            {done}/{queued} done · {inFlight} batch{inFlight === 1 ? '' : 'es'} running, {PARALLEL_REQUESTS} at a time — start another whenever
          </p>
        )}
      </Card>

      {results.length > 0 && (
        <div className="grid [grid-template-columns:repeat(auto-fill,minmax(160px,1fr))] gap-3">
          {results.map((r) => (
            <ImageCard key={r.galleryId || r.imageId} base64={r.base64Data} mimeType={r.mimeType} meta={{ imageId: r.imageId }} />
          ))}
        </div>
      )}
    </div>
  );
}
