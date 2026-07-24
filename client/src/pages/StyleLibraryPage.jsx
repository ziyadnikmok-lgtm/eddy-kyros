import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { styleLibrary as api } from '../services/api';
import { Card, Btn, Input, Textarea, Select, Badge, Spinner, Skeleton, Empty, Modal } from '../components/UI';

const CATEGORIES = ['all', 'pose', 'expression', 'outfit', 'scene', 'lighting', 'camera', 'vibe', 'accessories', 'format'];
const CATEGORY_COLORS = {
  pose: 'blue', expression: 'green', outfit: 'yellow', scene: 'blue',
  lighting: 'yellow', camera: 'zinc', vibe: 'green', accessories: 'red', format: 'purple',
};
const CAT_LABEL = c => c.charAt(0).toUpperCase() + c.slice(1);
const humanTag = t => t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

export default function StyleLibraryPage() {
  const { notify, consumePageParams } = useApp();

  const initParams = useMemo(() => consumePageParams(), []);

  const [atoms, setAtoms] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);

  const [activeCategory, setActiveCategory] = useState('all');
  const [searchQ, setSearchQ] = useState('');
  const [favOnly, setFavOnly] = useState(false);
  const [sourceFilter, setSourceFilter] = useState(initParams.sourceFilter || '');
  const [usernameFilter, setUsernameFilter] = useState(initParams.usernameFilter || '');

  const [selectedIds, setSelectedIds] = useState(new Set());
  const [composedPrompt, setComposedPrompt] = useState('');

  const [showAddModal, setShowAddModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [editingAtom, setEditingAtom] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [importLoading, setImportLoading] = useState(false);
  const [showDeleteMenu, setShowDeleteMenu] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const [duplicateCount, setDuplicateCount] = useState(null);

  const fetchAtoms = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: 50 };
      if (activeCategory !== 'all') params.category = activeCategory;
      if (searchQ.trim()) params.q = searchQ.trim();
      if (favOnly) params.favorite = 'true';
      if (sourceFilter) params.source = sourceFilter;
      if (usernameFilter) params.username = usernameFilter;
      const result = await api.list(params);
      setAtoms(result.atoms || []);
      setTotal(result.total || 0);
      setPages(result.pages || 1);
    } catch (err) { notify(err.message, 'error'); }
    finally { setLoading(false); }
  }, [page, activeCategory, searchQ, favOnly, sourceFilter, usernameFilter, notify]);

  useEffect(() => { fetchAtoms(); }, [fetchAtoms]);
  useEffect(() => { api.stats().then(setStats).catch(() => {}); }, [atoms.length]);

  useEffect(() => {
    if (selectedIds.size === 0) { setComposedPrompt(''); return; }
    api.compose([...selectedIds]).then(r => setComposedPrompt(r.prompt)).catch(() => setComposedPrompt(''));
  }, [selectedIds]);

  const sourceLabels = useMemo(() => {
    const map = {};
    atoms.forEach(a => {
      const label = a.source?.profileUsername || a.source?.sourceLabel;
      if (label) map[label] = (map[label] || 0) + 1;
    });
    return Object.entries(map);
  }, [atoms]);

  const selectedGrouped = useMemo(() => {
    const groups = {};
    for (const id of selectedIds) {
      const a = atoms.find(x => x.id === id);
      if (!a) continue;
      if (!groups[a.category]) groups[a.category] = [];
      groups[a.category].push(a);
    }
    return groups;
  }, [selectedIds, atoms]);

  const toggleSelect = (id) => {
    setSelectedIds(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  const toggleFavorite = async (atom) => {
    try { await api.update(atom.id, { favorite: !atom.favorite }); setAtoms(prev => prev.map(a => a.id === atom.id ? { ...a, favorite: !a.favorite } : a)); }
    catch (err) { notify(err.message, 'error'); }
  };
  const deleteAtom = async (id) => {
    try { await api.remove(id); setAtoms(prev => prev.filter(a => a.id !== id)); setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n; }); notify('Atom deleted', 'success'); }
    catch (err) { notify(err.message, 'error'); }
  };
  const deleteSelected = async () => {
    if (selectedIds.size === 0) return;
    try { await api.bulkDelete([...selectedIds]); notify(`Deleted ${selectedIds.size} atoms`, 'success'); setSelectedIds(new Set()); fetchAtoms(); }
    catch (err) { notify(err.message, 'error'); }
  };
  const deleteBySource = async (sourceLabel) => {
    try { await api.removeBySource(sourceLabel); notify(`Deleted all atoms from "${sourceLabel}"`, 'success'); setSelectedIds(new Set()); fetchAtoms(); }
    catch (err) { notify(err.message, 'error'); }
  };
  const clearAll = async () => {
    try { await api.removeAll(); notify('All atoms cleared', 'success'); setSelectedIds(new Set()); fetchAtoms(); }
    catch (err) { notify(err.message, 'error'); }
  };
  const handleBackfill = async () => {
    try { const result = await api.backfill(); notify(`Imported ${result.imported} atoms from prompt knowledge`, 'success'); fetchAtoms(); }
    catch (err) { notify(err.message, 'error'); }
  };
  const deleteDuplicates = async () => {
    try { const result = await api.deleteDuplicates(); notify(`Removed ${result.removed} duplicate atoms`, 'success'); setDuplicateCount(null); fetchAtoms(); }
    catch (err) { notify(err.message, 'error'); }
  };
  const openDeleteMenu = () => {
    setShowDeleteMenu(v => {
      if (!v) {
        setDuplicateCount(null);
        api.getDuplicateCount().then(r => setDuplicateCount(r.duplicateCount)).catch(() => setDuplicateCount(0));
      }
      return !v;
    });
  };
  const copyComposed = () => {
    if (!composedPrompt) return;
    navigator.clipboard.writeText(composedPrompt);
    notify('Copied to clipboard', 'success');
  };
  const copyAsJSON = () => {
    if (!composedPrompt) return;
    const json = {};
    for (const line of composedPrompt.split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const cat = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      if (cat && val) json[cat] = val;
    }
    navigator.clipboard.writeText(JSON.stringify(json, null, 2));
    notify('Copied JSON to clipboard', 'success');
  };

  const hasSelection = selectedIds.size > 0;

  return (
    <>
    <div className="animate-in">
      <div className="flex gap-4">

        <div className="flex-1 min-w-0 space-y-4">

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              {stats && <p className="text-xs text-zinc-500">{stats.total} atoms</p>}
            </div>
            <div className="flex gap-2 items-center flex-wrap">
              <Btn variant="ghost" onClick={handleBackfill}>Backfill</Btn>
              <Btn variant="ghost" onClick={() => setShowImportModal(true)}>Import JSON</Btn>
              <Btn variant="ghost" onClick={() => { const a = document.createElement('a'); a.href = '/api/style-library/export'; a.download = 'style-library.json'; a.click(); }}>Export JSON</Btn>
              <div className="relative">
                <Btn variant="ghost" onClick={openDeleteMenu}>Delete...</Btn>
                {showDeleteMenu && <DeleteMenu
                  selectedCount={selectedIds.size}
                  sourceLabels={sourceLabels}
                  totalCount={stats?.total || 0}
                  duplicateCount={duplicateCount}
                  onDeleteSelected={() => { setShowDeleteMenu(false); setConfirmAction({ label: `Delete ${selectedIds.size} selected atoms?`, onConfirm: deleteSelected }); }}
                  onDeleteBySource={(label, count) => { setShowDeleteMenu(false); setConfirmAction({ label: `Delete all ${count} atoms from "${label}"?`, onConfirm: () => deleteBySource(label) }); }}
                  onDeleteDuplicates={() => { setShowDeleteMenu(false); setConfirmAction({ label: `Remove ${duplicateCount} duplicate atoms? Keeps one per unique category+text (favored, most used, or earliest).`, onConfirm: deleteDuplicates }); }}
                  onClearAll={() => { setShowDeleteMenu(false); setConfirmAction({ label: `Clear ALL ${stats?.total || 0} atoms? This cannot be undone.`, onConfirm: clearAll }); }}
                  onClose={() => setShowDeleteMenu(false)}
                />}
              </div>
              <Btn variant="primary" onClick={() => setShowAddModal(true)}>+ Add Atom</Btn>
            </div>
          </div>

          <div className="flex gap-1.5 flex-wrap">
            {CATEGORIES.map(cat => {
              const count = stats && cat !== 'all' ? stats.byCategory[cat] || 0 : 0;
              return (
                <button
                  key={cat}
                  onClick={() => { setActiveCategory(cat); setPage(1); }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                    activeCategory === cat
                      ? 'bg-rose-600/20 text-rose-400 border border-rose-500/40'
                      : 'bg-zinc-800/50 text-zinc-400 border border-zinc-700/40 hover:bg-zinc-700/60 hover:text-zinc-300'
                  }`}
                >
                  {cat === 'all' ? 'All' : CAT_LABEL(cat)}
                  {count > 0 && <span className="ml-1.5 text-[0.625rem] opacity-50">{count}</span>}
                </button>
              );
            })}
          </div>

          <div className="flex gap-2 items-center flex-wrap">
            <div className="flex-1 min-w-[180px]">
              <Input placeholder="Search atoms..." value={searchQ} onChange={e => { setSearchQ(e.target.value); setPage(1); }} />
            </div>
            <select
              value={sourceFilter}
              onChange={e => { setSourceFilter(e.target.value); setPage(1); }}
              className="bg-zinc-900/60 border border-zinc-700/80 rounded-lg px-3 py-2.5 text-sm text-zinc-300 outline-none focus:border-rose-500/70 focus:ring-1 focus:ring-rose-500/20"
            >
              <option value="">All Sources</option>
              <option value="manual">Manual</option>
              <option value="profile_analysis">Profile Analysis</option>
              <option value="post_clone">Post Clone</option>
              <option value="json_import">JSON Import</option>
              <option value="backfill">Backfill</option>
            </select>
            <button
              onClick={() => { setFavOnly(f => !f); setPage(1); }}
              className={`px-3 py-2.5 rounded-lg text-sm border transition-colors cursor-pointer ${
                favOnly ? 'bg-yellow-500/15 text-yellow-400 border-yellow-500/40' : 'bg-zinc-800/50 text-zinc-400 border-zinc-700/60 hover:bg-zinc-700/60'
              }`}
            >
              {favOnly ? '\u2605 Favs' : '\u2606 Favs'}
            </button>
            {usernameFilter && (
              <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-rose-500/15 text-rose-400 border border-rose-500/30">
                @{usernameFilter}
                <button
                  onClick={() => { setUsernameFilter(''); setPage(1); }}
                  className="hover:text-rose-200 cursor-pointer"
                >
                  {'\u2715'}
                </button>
              </span>
            )}
          </div>

          {loading ? (
            <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 9 }).map((_, i) => (
                <div key={i} className="rounded-xl border border-zinc-700/60 bg-zinc-800/40 p-3 space-y-2">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              ))}
            </div>
          ) : atoms.length === 0 ? (
            <Empty icon="atom" title="No atoms yet" subtitle="Add atoms manually, import JSON, or run the Profile Analyzer" />
          ) : (
            <>
              <div className={`grid gap-2.5 ${hasSelection ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'}`}>
                {atoms.map(atom => (
                  <AtomCard
                    key={atom.id}
                    atom={atom}
                    selected={selectedIds.has(atom.id)}
                    onToggleSelect={() => toggleSelect(atom.id)}
                    onToggleFavorite={() => toggleFavorite(atom)}
                    onEdit={() => setEditingAtom(atom)}
                    onDelete={() => setConfirmAction({ label: `Delete this ${atom.category} atom?`, onConfirm: () => deleteAtom(atom.id) })}
                  />
                ))}
              </div>
              {pages > 1 && (
                <div className="flex items-center justify-center gap-3 pt-2 pb-4">
                  <Btn variant="ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>&laquo; Prev</Btn>
                  <span className="text-xs text-zinc-500">{page} / {pages}</span>
                  <Btn variant="ghost" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next &raquo;</Btn>
                </div>
              )}
            </>
          )}
        </div>

        {hasSelection && (
          <aside className="w-[320px] shrink-0">
            <div className="sticky top-0 max-h-[calc(100vh-7rem)] flex flex-col rounded-xl border border-zinc-700/80 bg-zinc-900 overflow-hidden">

              <div className="px-4 pt-4 pb-3 border-b border-zinc-800">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-zinc-100">Composer</h2>
                  <button onClick={() => setSelectedIds(new Set())} className="text-[0.6875rem] text-zinc-500 hover:text-zinc-300 cursor-pointer">Clear all</button>
                </div>
                <p className="text-[0.6875rem] text-zinc-500 mt-0.5">{selectedIds.size} atom{selectedIds.size !== 1 ? 's' : ''} selected</p>
              </div>

              <div className="flex-1 overflow-y-auto scroll-fade px-4 py-3 space-y-3">
                {Object.entries(selectedGrouped).map(([cat, catAtoms]) => (
                  <div key={cat}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <Badge color={CATEGORY_COLORS[cat] || 'zinc'}>{cat}</Badge>
                      <span className="text-[0.625rem] text-zinc-600">{catAtoms.length}</span>
                    </div>
                    <div className="space-y-1">
                      {catAtoms.map(a => (
                        <div key={a.id} className="group flex items-start gap-2 py-1.5 px-2 rounded-lg bg-zinc-800/50 hover:bg-zinc-800/80">
                          <p className="flex-1 text-[0.6875rem] text-zinc-300 leading-relaxed line-clamp-2">{a.text}</p>
                          <button
                            onClick={() => toggleSelect(a.id)}
                            className="text-zinc-600 hover:text-red-400 text-xs mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer shrink-0"
                          >{'\u2715'}</button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}

                {composedPrompt && (
                  <div className="pt-2 border-t border-zinc-800">
                    <span className="text-[0.625rem] uppercase tracking-wider text-zinc-600 mb-2 block">Prompt Preview</span>
                    <div className="space-y-1.5">
                      {composedPrompt.split('\n').filter(Boolean).map((line, i) => {
                        const colonIdx = line.indexOf(':');
                        if (colonIdx === -1) return <p key={i} className="text-[0.6875rem] text-zinc-400 leading-relaxed">{line}</p>;
                        const label = line.slice(0, colonIdx);
                        const value = line.slice(colonIdx + 1).trim();
                        const cat = label.toLowerCase();
                        return (
                          <div key={i} className="text-[0.6875rem] leading-relaxed">
                            <span className={`font-medium ${
                              CATEGORY_COLORS[cat] === 'blue' ? 'text-rose-400' :
                              CATEGORY_COLORS[cat] === 'green' ? 'text-green-400' :
                              CATEGORY_COLORS[cat] === 'yellow' ? 'text-yellow-400' :
                              CATEGORY_COLORS[cat] === 'red' ? 'text-red-400' :
                              'text-zinc-400'
                            }`}>{label}:</span>
                            <span className="text-zinc-300 ml-1">{value}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div className="px-4 py-3 border-t border-zinc-800 space-y-2">
                <div className="flex gap-2">
                  <Btn variant="primary" className="flex-1" onClick={copyComposed}>Copy Prompt</Btn>
                  <Btn variant="secondary" className="flex-1" onClick={copyAsJSON}>Copy JSON</Btn>
                </div>
                <Btn variant="danger" className="w-full" onClick={() => setConfirmAction({ label: `Delete ${selectedIds.size} selected atoms?`, onConfirm: deleteSelected })}>
                  Delete Selected
                </Btn>
              </div>
            </div>
          </aside>
        )}
      </div>

    </div>

    <AddAtomModal open={showAddModal} onClose={() => setShowAddModal(false)} onSave={(atom) => { setAtoms(prev => [atom, ...prev]); setShowAddModal(false); notify('Atom created', 'success'); }} notify={notify} />
    <EditAtomModal open={!!editingAtom} atom={editingAtom} onClose={() => setEditingAtom(null)} onSave={(updated) => { setAtoms(prev => prev.map(a => a.id === updated.id ? updated : a)); setEditingAtom(null); notify('Atom updated', 'success'); }} notify={notify} />
    <Modal open={!!confirmAction} title="Confirm Delete" onClose={() => setConfirmAction(null)}>
      <div className="space-y-4">
        <p className="text-sm text-zinc-300">{confirmAction?.label}</p>
        <div className="flex gap-2 justify-end">
          <Btn variant="ghost" onClick={() => setConfirmAction(null)}>Cancel</Btn>
          <Btn variant="danger" onClick={() => { confirmAction?.onConfirm(); setConfirmAction(null); }}>Delete</Btn>
        </div>
      </div>
    </Modal>
    <ImportJSONModal open={showImportModal} onClose={() => { setShowImportModal(false); setImportPreview(null); }} importPreview={importPreview} setImportPreview={setImportPreview} importLoading={importLoading} setImportLoading={setImportLoading} onImported={() => { fetchAtoms(); setShowImportModal(false); setImportPreview(null); }} notify={notify} />
    </>
  );
}

function DeleteMenu({ selectedCount, sourceLabels, totalCount, duplicateCount, onDeleteSelected, onDeleteBySource, onDeleteDuplicates, onClearAll, onClose }) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-0 top-full mt-1 z-50 w-56 bg-zinc-800/90 border border-zinc-700/80 rounded-xl shadow-2xl overflow-hidden dropdown-animate">
        {selectedCount > 0 && (
          <button onClick={onDeleteSelected} className="w-full text-left px-4 py-2.5 text-sm text-zinc-300 hover:bg-zinc-700/80 cursor-pointer">
            Delete {selectedCount} selected
          </button>
        )}
        {duplicateCount === null && (
          <span className="block px-4 py-2.5 text-sm text-zinc-500">Checking duplicates...</span>
        )}
        {duplicateCount > 0 && (
          <button onClick={onDeleteDuplicates} className="w-full text-left px-4 py-2.5 text-sm text-zinc-300 hover:bg-zinc-700/80 cursor-pointer">
            Remove {duplicateCount} duplicates
          </button>
        )}
        {duplicateCount === 0 && (
          <span className="block px-4 py-2.5 text-sm text-zinc-600">No duplicates found</span>
        )}
        {sourceLabels.map(([label, count]) => (
          <button key={label} onClick={() => onDeleteBySource(label, count)} className="w-full text-left px-4 py-2.5 text-sm text-zinc-300 hover:bg-zinc-700/80 cursor-pointer truncate">
            All from {label} ({count})
          </button>
        ))}
        <div className="border-t border-zinc-700/80" />
        <button onClick={onClearAll} className="w-full text-left px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/10 cursor-pointer">
          Clear entire library ({totalCount})
        </button>
      </div>
    </>
  );
}

function AtomCard({ atom, selected, onToggleSelect, onToggleFavorite, onEdit, onDelete }) {
  return (
    <div
      className={`group relative rounded-xl border p-3 transition-all cursor-pointer ${
        selected
          ? 'border-rose-500/60 bg-rose-500/8 ring-1 ring-rose-500/20'
          : 'border-zinc-700/60 bg-zinc-800/60 hover:border-zinc-600 hover:bg-zinc-900/60'
      }`}
      onClick={onToggleSelect}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <Badge color={CATEGORY_COLORS[atom.category] || 'zinc'}>{atom.category}</Badge>
        <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={e => { e.stopPropagation(); onToggleFavorite(); }} className={`text-lg leading-none cursor-pointer ${atom.favorite ? 'text-yellow-400' : 'text-zinc-600 hover:text-yellow-400'}`} title="Favorite">
            {atom.favorite ? '\u2605' : '\u2606'}
          </button>
          <button onClick={e => { e.stopPropagation(); onEdit(); }} className="text-lg leading-none text-zinc-600 hover:text-rose-400 cursor-pointer" title="Edit">
            {'\u270E'}
          </button>
          <button onClick={e => { e.stopPropagation(); onDelete(); }} className="text-lg leading-none text-zinc-600 hover:text-red-400 cursor-pointer" title="Delete">
            {'\u2715'}
          </button>
        </div>
      </div>

      <p className="text-xs text-zinc-300 leading-relaxed line-clamp-3">{atom.text}</p>

      {atom.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {atom.tags.slice(0, 3).map(tag => (
            <span key={tag} className="text-[0.625rem] px-1.5 py-0.5 rounded bg-zinc-700/50 text-zinc-500">{humanTag(tag)}</span>
          ))}
          {atom.tags.length > 3 && <span className="text-[0.625rem] text-zinc-600">+{atom.tags.length - 3}</span>}
        </div>
      )}

      {selected && (
        <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-rose-500" />
      )}
    </div>
  );
}

function AddAtomModal({ open, onClose, onSave, notify }) {
  const [category, setCategory] = useState('pose');
  const [text, setText] = useState('');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!text.trim()) return;
    setSaving(true);
    try {
      const atom = await api.create({ category, text: text.trim(), tags: tags.split(',').map(t => t.trim()).filter(Boolean), source: { type: 'manual' } });
      if (!atom?.id) throw new Error('Atom was not saved. Try a more specific description.');
      onSave(atom);
    } catch (err) { notify(err.message, 'error'); }
    finally { setSaving(false); }
  };

  return (
    <Modal open={open} title="Add Style Atom" onClose={onClose}>
      <div className="space-y-3">
        <Select label="Category" value={category} onChange={e => setCategory(e.target.value)} options={CATEGORIES.filter(c => c !== 'all').map(c => ({ value: c, label: CAT_LABEL(c) }))} />
        <Textarea label="Description" placeholder="Directive tone: 'Standing with weight on left hip...'" value={text} onChange={e => setText(e.target.value)} rows={4} />
        <Input label="Tags (comma separated)" placeholder="indoor, relaxed, luxury" value={tags} onChange={e => setTags(e.target.value)} />
        <Btn variant="primary" className="w-full" onClick={handleSave} disabled={saving || !text.trim()}>
          {saving ? <><Spinner size={14} /> Saving...</> : 'Create Atom'}
        </Btn>
      </div>
    </Modal>
  );
}

function EditAtomModal({ open, atom, onClose, onSave, notify }) {
  const [category, setCategory] = useState(atom?.category || 'pose');
  const [text, setText] = useState(atom?.text || '');
  const [tags, setTags] = useState((atom?.tags || []).join(', '));

  useEffect(() => {
    if (atom) {
      setCategory(atom.category);
      setText(atom.text);
      setTags((atom.tags || []).join(', '));
    }
  }, [atom]);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!text.trim()) return;
    setSaving(true);
    try {
      const updated = await api.update(atom.id, { category, text: text.trim(), tags: tags.split(',').map(t => t.trim()).filter(Boolean) });
      onSave(updated);
    } catch (err) { notify(err.message, 'error'); }
    finally { setSaving(false); }
  };

  return (
    <Modal open={open} title="Edit Atom" onClose={onClose}>
      <div className="space-y-3">
        <Select label="Category" value={category} onChange={e => setCategory(e.target.value)} options={CATEGORIES.filter(c => c !== 'all').map(c => ({ value: c, label: CAT_LABEL(c) }))} />
        <Textarea label="Description" value={text} onChange={e => setText(e.target.value)} rows={4} />
        <Input label="Tags (comma separated)" value={tags} onChange={e => setTags(e.target.value)} />
        <Btn variant="primary" className="w-full" onClick={handleSave} disabled={saving || !text.trim()}>
          {saving ? <><Spinner size={14} /> Saving...</> : 'Save Changes'}
        </Btn>
      </div>
    </Modal>
  );
}

function ImportJSONModal({ open, onClose, importPreview, setImportPreview, importLoading, setImportLoading, onImported, notify }) {
  const fileRef = useRef(null);
  const [sourceLabel, setSourceLabel] = useState('');
  const [checkedAtoms, setCheckedAtoms] = useState(new Set());
  const [saving, setSaving] = useState(false);

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const label = file.name.replace(/\.json$/i, '');
    setSourceLabel(label);
    setImportLoading(true);
    try {
      const text = await file.text();
      const jsonData = JSON.parse(text);
      const result = await api.importJSON(jsonData, label);
      setImportPreview(result.atoms || []);
      setCheckedAtoms(new Set(result.atoms.map((_, i) => i)));
    } catch (err) { notify(err.message || 'Failed to parse JSON', 'error'); setImportPreview(null); }
    finally { setImportLoading(false); }
  };

  const toggleCheck = (idx) => { setCheckedAtoms(prev => { const n = new Set(prev); if (n.has(idx)) n.delete(idx); else n.add(idx); return n; }); };

  const handleSave = async () => {
    if (!importPreview || checkedAtoms.size === 0) return;
    setSaving(true);
    try {
      const selected = importPreview.filter((_, i) => checkedAtoms.has(i));
      await api.bulkCreate(selected.map(a => ({ category: a.category, text: a.text, tags: a.tags || [], source: { type: 'json_import', sourceLabel } })));
      notify(`Imported ${selected.length} atoms`, 'success');
      onImported();
    } catch (err) { notify(err.message, 'error'); }
    finally { setSaving(false); }
  };

  const groupedPreview = useMemo(() => {
    if (!importPreview) return {};
    const groups = {};
    importPreview.forEach((atom, idx) => { if (!groups[atom.category]) groups[atom.category] = []; groups[atom.category].push({ ...atom, _idx: idx }); });
    return groups;
  }, [importPreview]);

  return (
    <Modal open={open} title="Import from JSON" onClose={onClose}>
      <div className="space-y-4 max-h-[70vh] overflow-y-auto">
        {!importPreview ? (
          <>
            <p className="text-xs text-zinc-400">Upload a subject profile JSON or prompts_examples JSON. The importer will extract style atoms and strip identity references.</p>
            <input ref={fileRef} type="file" accept=".json" onChange={handleFileSelect} className="hidden" />
            <Btn variant="primary" onClick={() => fileRef.current?.click()} disabled={importLoading}>
              {importLoading ? <><Spinner size={14} /> Analyzing...</> : 'Choose JSON File'}
            </Btn>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-400">Found {importPreview.length} atoms from <span className="text-zinc-300 font-medium">{sourceLabel}</span></span>
              <div className="flex gap-2">
                <button onClick={() => setCheckedAtoms(new Set(importPreview.map((_, i) => i)))} className="text-xs text-rose-400 hover:text-rose-300 cursor-pointer">Select All</button>
                <button onClick={() => setCheckedAtoms(new Set())} className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer">Deselect All</button>
              </div>
            </div>
            {Object.entries(groupedPreview).map(([category, items]) => (
              <div key={category}>
                <h4 className="text-xs font-medium text-zinc-400 mb-1 capitalize">{category} ({items.length})</h4>
                <div className="space-y-1">
                  {items.map(atom => (
                    <label key={atom._idx} className="flex items-start gap-2 p-2 rounded-lg bg-zinc-800/40 hover:bg-zinc-800/70 cursor-pointer">
                      <input type="checkbox" checked={checkedAtoms.has(atom._idx)} onChange={() => toggleCheck(atom._idx)} className="mt-0.5 accent-rose-500" />
                      <p className="flex-1 text-xs text-zinc-300 leading-relaxed">{atom.text}</p>
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <Btn variant="primary" className="w-full" onClick={handleSave} disabled={saving || checkedAtoms.size === 0}>
              {saving ? <><Spinner size={14} /> Importing...</> : `Import ${checkedAtoms.size} Selected`}
            </Btn>
          </>
        )}
      </div>
    </Modal>
  );
}
