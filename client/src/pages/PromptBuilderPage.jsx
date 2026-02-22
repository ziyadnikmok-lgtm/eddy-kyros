import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { styleLibrary as api } from '../services/api';
import { Card, Btn, Badge, Spinner, Empty, Modal } from '../components/UI';

const COMPOSE_ORDER = ['scene', 'lighting', 'camera', 'pose', 'expression', 'outfit', 'accessories', 'vibe', 'format'];

const SLOT_META = {
  scene: { icon: '\uD83C\uDFDE', color: 'blue', hint: 'Environment, setting, surfaces, spatial depth' },
  lighting: { icon: '\u2600', color: 'yellow', hint: 'Light source, quality, color temperature, shadows' },
  camera: { icon: '\uD83D\uDCF7', color: 'zinc', hint: 'Shot type, focal length, angle, depth of field' },
  pose: { icon: '\uD83E\uDDD1', color: 'blue', hint: 'Body positioning, weight, limb placement' },
  expression: { icon: '\uD83D\uDE0A', color: 'green', hint: 'Facial mood, gaze direction, emotional energy' },
  outfit: { icon: '\uD83D\uDC57', color: 'yellow', hint: 'Garments, fit, fabric, color, texture' },
  accessories: { icon: '\uD83D\uDC8D', color: 'red', hint: 'Jewelry, bags, hats, sunglasses' },
  vibe: { icon: '\u2728', color: 'green', hint: 'Overall mood, aesthetic era, energy level' },
  format: { icon: '\uD83C\uDFA8', color: 'purple', hint: 'Photography type, post-processing, visual treatment' },
};

const CATEGORY_COLORS = {
  pose: 'blue', expression: 'green', outfit: 'yellow', scene: 'blue',
  lighting: 'yellow', camera: 'zinc', vibe: 'green', accessories: 'red', format: 'purple',
};

export default function PromptBuilderPage() {
  const { notify, setPage: navTo } = useApp();

  // Each slot: { atomId, category, text } or null
  const [slots, setSlots] = useState(() =>
    Object.fromEntries(COMPOSE_ORDER.map(c => [c, null]))
  );
  const [composedPrompt, setComposedPrompt] = useState('');
  const [composing, setComposing] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [pickerCat, setPickerCat] = useState(null); // category to filter picker by, or null

  // Presets (saved compositions)
  const [presets, setPresets] = useState(() => {
    try { return JSON.parse(localStorage.getItem('pb_presets') || '[]'); } catch { return []; }
  });
  const [presetName, setPresetName] = useState('');
  const [showPresets, setShowPresets] = useState(false);

  // Compose prompt whenever slots change
  useEffect(() => {
    const filledIds = COMPOSE_ORDER.map(c => slots[c]?.atomId).filter(Boolean);
    if (filledIds.length === 0) { setComposedPrompt(''); return; }
    setComposing(true);
    api.compose(filledIds)
      .then(r => setComposedPrompt(r.prompt || ''))
      .catch(() => setComposedPrompt(''))
      .finally(() => setComposing(false));
  }, [slots]);

  const filledCount = COMPOSE_ORDER.filter(c => slots[c]).length;
  const emptyCategories = COMPOSE_ORDER.filter(c => !slots[c]);

  // Set a slot from the picker
  const setSlot = (category, atom) => {
    setSlots(prev => ({ ...prev, [category]: { atomId: atom.id, category, text: atom.text } }));
  };

  const clearSlot = (category) => {
    setSlots(prev => ({ ...prev, [category]: null }));
  };

  const clearAll = () => {
    setSlots(Object.fromEntries(COMPOSE_ORDER.map(c => [c, null])));
  };

  // AI Fill — use suggest endpoint to fill empty slots
  const handleAIFill = async () => {
    const filledIds = COMPOSE_ORDER.map(c => slots[c]?.atomId).filter(Boolean);
    if (filledIds.length === 0) {
      notify('Add at least one atom first so AI can match the style', 'warning');
      return;
    }
    if (emptyCategories.length === 0) {
      notify('All slots are filled', 'info');
      return;
    }
    setSuggesting(true);
    try {
      const res = await api.suggest(filledIds, emptyCategories);
      const suggestions = res.suggestions || [];
      if (suggestions.length === 0) {
        notify('No suggestions generated — try adding more atoms', 'warning');
        return;
      }
      // Save suggestions as new atoms and fill slots
      const created = await api.bulkCreate(suggestions);
      const newSlots = { ...slots };
      for (const atom of (created || [])) {
        if (!newSlots[atom.category]) {
          newSlots[atom.category] = { atomId: atom.id, category: atom.category, text: atom.text };
        }
      }
      setSlots(newSlots);
      notify(`Filled ${suggestions.length} slots with AI suggestions`, 'success');
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setSuggesting(false);
    }
  };

  // Presets
  const savePreset = () => {
    const name = presetName.trim() || `Preset ${presets.length + 1}`;
    const preset = { name, slots: { ...slots }, createdAt: Date.now() };
    const next = [preset, ...presets].slice(0, 20);
    setPresets(next);
    localStorage.setItem('pb_presets', JSON.stringify(next));
    setPresetName('');
    notify(`Saved "${name}"`, 'success');
  };

  const loadPreset = (preset) => {
    setSlots(preset.slots);
    setShowPresets(false);
    notify(`Loaded "${preset.name}"`, 'success');
  };

  const deletePreset = (idx) => {
    const next = presets.filter((_, i) => i !== idx);
    setPresets(next);
    localStorage.setItem('pb_presets', JSON.stringify(next));
  };

  // Copy composed prompt
  const copyPrompt = () => {
    if (!composedPrompt) return;
    navigator.clipboard.writeText(composedPrompt);
    notify('Prompt copied to clipboard', 'success');
  };

  // Send to generate page
  const sendToGenerate = () => {
    if (!composedPrompt) return;
    // Store in sessionStorage so GeneratePage can pick it up
    const atomIds = COMPOSE_ORDER.map(c => slots[c]?.atomId).filter(Boolean);
    sessionStorage.setItem('pb_atomIds', JSON.stringify(atomIds));
    navTo('generate');
    notify('Style atoms sent to Generate page', 'success');
  };

  return (
    <div className="space-y-6 animate-in">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight text-gradient">Prompt Builder</h1>
        <div className="flex gap-2">
          {presets.length > 0 && (
            <Btn variant="ghost" onClick={() => setShowPresets(true)}>
              Presets ({presets.length})
            </Btn>
          )}
          <Btn
            variant="secondary"
            onClick={handleAIFill}
            disabled={suggesting || filledCount === 0 || emptyCategories.length === 0}
          >
            {suggesting ? <><Spinner size={14} /> Filling...</> : `AI Fill Gaps (${emptyCategories.length})`}
          </Btn>
        </div>
      </div>

      {/* Formula label */}
      <p className="text-[10px] text-zinc-500 tracking-wider uppercase">
        Nano-Banana Formula: Scene &rarr; Lighting &rarr; Camera &rarr; Pose &rarr; Expression &rarr; Outfit &rarr; Accessories &rarr; Vibe &rarr; Format
      </p>

      {/* Slot Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {COMPOSE_ORDER.map((cat, idx) => {
          const slot = slots[cat];
          const meta = SLOT_META[cat];
          return (
            <div
              key={cat}
              className={`group relative rounded-xl border p-3 transition-all ${
                slot
                  ? 'bg-zinc-800/60 border-zinc-600/50'
                  : 'bg-zinc-900/40 border-zinc-700/30 border-dashed'
              }`}
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm">{meta.icon}</span>
                  <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">{cat}</span>
                  <span className="text-[9px] text-zinc-600 font-mono">#{idx + 1}</span>
                </div>
                {slot && (
                  <button
                    onClick={() => clearSlot(cat)}
                    className="text-zinc-600 hover:text-red-400 text-xs cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Clear slot"
                  >
                    &times;
                  </button>
                )}
              </div>

              {/* Content */}
              {slot ? (
                <div>
                  <p className="text-xs text-zinc-300 leading-relaxed line-clamp-3">{slot.text}</p>
                  <button
                    onClick={() => setPickerCat(cat)}
                    className="mt-2 text-[10px] text-blue-400/60 hover:text-blue-400 cursor-pointer"
                  >
                    Swap
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setPickerCat(cat)}
                  className="w-full py-4 text-center cursor-pointer group/add"
                >
                  <span className="text-zinc-600 group-hover/add:text-blue-400 text-xs transition-colors">+ Add {cat}</span>
                  <p className="text-[9px] text-zinc-700 mt-1">{meta.hint}</p>
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Composed Preview */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-zinc-200">Composed Prompt</h3>
            <span className="text-[10px] text-zinc-500">{filledCount}/9 slots</span>
            {composing && <Spinner size={12} />}
          </div>
          <div className="flex gap-2">
            {filledCount > 0 && (
              <>
                <button onClick={clearAll} className="text-[10px] text-zinc-600 hover:text-red-400 cursor-pointer">Clear All</button>
                <input
                  type="text"
                  value={presetName}
                  onChange={e => setPresetName(e.target.value)}
                  placeholder="Preset name..."
                  className="bg-zinc-900/60 border border-zinc-700/60 rounded-md px-2 py-0.5 text-[10px] text-zinc-300 placeholder:text-zinc-600 w-28"
                />
                <Btn size="xs" variant="ghost" onClick={savePreset} disabled={filledCount === 0}>Save</Btn>
              </>
            )}
          </div>
        </div>

        {composedPrompt ? (
          <div className="space-y-3">
            <div className="p-3 rounded-lg bg-zinc-900/60 border border-zinc-700/40">
              {composedPrompt.split('\n').filter(Boolean).map((line, i) => {
                const colonIdx = line.indexOf(':');
                if (colonIdx > 0 && colonIdx < 15) {
                  const label = line.slice(0, colonIdx);
                  const rest = line.slice(colonIdx + 1);
                  return (
                    <p key={i} className="text-xs text-zinc-300 leading-relaxed mb-1">
                      <span className="font-semibold text-zinc-400">{label}:</span>{rest}
                    </p>
                  );
                }
                return <p key={i} className="text-xs text-zinc-300 leading-relaxed mb-1">{line}</p>;
              })}
            </div>
            <div className="flex gap-2">
              <Btn variant="primary" onClick={sendToGenerate}>Send to Generate</Btn>
              <Btn variant="ghost" onClick={copyPrompt}>Copy</Btn>
            </div>
          </div>
        ) : (
          <p className="text-xs text-zinc-600 italic">Click slots above to add style atoms and build your prompt</p>
        )}
      </Card>

      {/* Atom Picker Modal */}
      {pickerCat && (
        <SlotPicker
          category={pickerCat}
          currentAtomId={slots[pickerCat]?.atomId}
          onSelect={(atom) => { setSlot(pickerCat, atom); setPickerCat(null); }}
          onClose={() => setPickerCat(null)}
        />
      )}

      {/* Presets Modal */}
      {showPresets && (
        <Modal open title="Saved Presets" onClose={() => setShowPresets(false)}>
          <div className="space-y-2 max-h-[60vh] overflow-y-auto scroll-fade">
            {presets.length === 0 ? (
              <p className="text-xs text-zinc-500 text-center py-4">No presets saved yet</p>
            ) : presets.map((p, i) => {
              const filled = COMPOSE_ORDER.filter(c => p.slots[c]).length;
              return (
                <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-zinc-800/40 border border-zinc-700/40">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-200 font-medium truncate">{p.name}</p>
                    <div className="flex gap-1 mt-1 flex-wrap">
                      {COMPOSE_ORDER.filter(c => p.slots[c]).map(c => (
                        <Badge key={c} color={CATEGORY_COLORS[c]} size="xs">{c}</Badge>
                      ))}
                    </div>
                    <p className="text-[9px] text-zinc-600 mt-1">{filled}/9 slots &middot; {new Date(p.createdAt).toLocaleDateString()}</p>
                  </div>
                  <div className="flex gap-1.5 ml-3">
                    <Btn size="xs" variant="primary" onClick={() => loadPreset(p)}>Load</Btn>
                    <Btn size="xs" variant="ghost" onClick={() => deletePreset(i)}>Del</Btn>
                  </div>
                </div>
              );
            })}
          </div>
        </Modal>
      )}

      {/* Empty state */}
      {filledCount === 0 && !pickerCat && (
        <Empty
          icon={'\uD83E\uDDE9'}
          title="Build your perfect prompt"
          subtitle="Click any slot to add a style atom from your library. The Nano-Banana formula orders them for optimal AI generation."
        />
      )}
    </div>
  );
}

// ─── Slot Picker (category-filtered atom browser) ─────
function SlotPicker({ category, currentAtomId, onSelect, onClose }) {
  const [atoms, setAtoms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQ, setSearchQ] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);

  const fetchAtoms = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: 20, category };
      if (searchQ.trim()) params.q = searchQ.trim();
      const result = await api.list(params);
      setAtoms(result.atoms || []);
      setPages(result.pages || 1);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [page, category, searchQ]);

  useEffect(() => { fetchAtoms(); }, [fetchAtoms]);

  return (
    <Modal open title={`Pick ${category.charAt(0).toUpperCase() + category.slice(1)} Atom`} onClose={onClose}>
      <div className="space-y-3 max-h-[60vh] overflow-y-auto scroll-fade">
        <input
          type="text"
          placeholder={`Search ${category} atoms...`}
          value={searchQ}
          onChange={e => { setSearchQ(e.target.value); setPage(1); }}
          className="w-full bg-zinc-900/60 border border-zinc-700/80 rounded-lg px-3 py-2 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 outline-none"
        />

        {loading ? (
          <div className="flex justify-center py-8"><Spinner size={24} /></div>
        ) : atoms.length === 0 ? (
          <p className="text-xs text-zinc-500 text-center py-8">No {category} atoms found</p>
        ) : (
          <div className="space-y-1.5">
            {atoms.map(atom => (
              <button
                key={atom.id}
                onClick={() => onSelect(atom)}
                className={`w-full text-left flex items-start gap-2 p-2.5 rounded-lg transition-all cursor-pointer ${
                  atom.id === currentAtomId
                    ? 'bg-blue-500/15 border border-blue-500/30'
                    : 'bg-zinc-800/40 border border-transparent hover:bg-zinc-800/80 hover:border-zinc-700/40'
                }`}
              >
                <p className="flex-1 text-xs text-zinc-300 leading-relaxed">{atom.text}</p>
                {atom.id === currentAtomId && (
                  <span className="text-[9px] text-blue-400 shrink-0">current</span>
                )}
              </button>
            ))}
          </div>
        )}

        {pages > 1 && (
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-40 cursor-pointer"
            >&laquo; Prev</button>
            <span className="text-xs text-zinc-500">{page}/{pages}</span>
            <button
              onClick={() => setPage(p => Math.min(pages, p + 1))}
              disabled={page >= pages}
              className="text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-40 cursor-pointer"
            >Next &raquo;</button>
          </div>
        )}
      </div>
    </Modal>
  );
}
