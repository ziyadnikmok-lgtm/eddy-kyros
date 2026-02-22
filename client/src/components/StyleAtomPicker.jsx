import { useState, useEffect, useCallback, useRef } from 'react';
import { styleLibrary as api } from '../services/api';
import { Modal, Btn, Badge, Spinner } from './UI';

const CATEGORIES = ['all', 'pose', 'expression', 'outfit', 'scene', 'lighting', 'camera', 'vibe', 'accessories', 'format'];
const CATEGORY_COLORS = {
  pose: 'blue', expression: 'green', outfit: 'yellow', scene: 'blue',
  lighting: 'yellow', camera: 'zinc', vibe: 'green', accessories: 'red', format: 'purple',
};

export default function StyleAtomPicker({ selectedIds, onApply, onClose }) {
  const [atoms, setAtoms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState('all');
  const [searchQ, setSearchQ] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [selected, setSelected] = useState(new Set(selectedIds || []));
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceRef = useRef(null);

  // Debounce search input — 300ms delay prevents rapid API calls
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(searchQ), 300);
    return () => clearTimeout(debounceRef.current);
  }, [searchQ]);

  const fetchAtoms = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: 30 };
      if (category !== 'all') params.category = category;
      if (debouncedSearch.trim()) params.q = debouncedSearch.trim();
      const result = await api.list(params);
      setAtoms(result.atoms || []);
      setPages(result.pages || 1);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [page, category, debouncedSearch]);

  useEffect(() => { fetchAtoms(); }, [fetchAtoms]);

  const toggle = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <Modal open title="Pick Style Atoms" onClose={onClose}>
      <div className="flex flex-col max-h-[70vh]">
        {/* Filters (sticky top) */}
        <div className="space-y-3 pb-3 shrink-0">
          {/* Category tabs */}
          <div className="flex gap-1 flex-wrap">
            {CATEGORIES.map(cat => (
              <button
                key={cat}
                onClick={() => { setCategory(cat); setPage(1); }}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  category === cat
                    ? 'bg-blue-600/20 text-blue-400 border border-blue-500/40'
                    : 'bg-zinc-800/50 text-zinc-400 border border-zinc-700/60 hover:bg-zinc-800/80'
                }`}
              >
                {cat === 'all' ? 'All' : cat.charAt(0).toUpperCase() + cat.slice(1)}
              </button>
            ))}
          </div>

          {/* Search */}
          <input
            type="text"
            placeholder="Search atoms..."
            value={searchQ}
            onChange={e => { setSearchQ(e.target.value); setPage(1); }}
            className="w-full bg-zinc-900/60 border border-zinc-700/80 rounded-lg px-3 py-2 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 outline-none"
          />
        </div>

        {/* Scrollable atom list */}
        <div className="flex-1 overflow-y-auto scroll-fade space-y-1.5 min-h-0">
          {loading ? (
            <div className="flex justify-center py-8"><Spinner size={24} /></div>
          ) : atoms.length === 0 ? (
            <p className="text-xs text-zinc-500 text-center py-8">No atoms found</p>
          ) : (
            atoms.map(atom => (
              <div
                key={atom.id}
                onClick={() => toggle(atom.id)}
                className={`flex items-start gap-2 p-2 rounded-lg cursor-pointer transition-all ${
                  selected.has(atom.id)
                    ? 'bg-blue-500/10 border border-blue-500/30'
                    : 'bg-zinc-800/40 border border-transparent hover:bg-zinc-800/80'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(atom.id)}
                  onChange={() => toggle(atom.id)}
                  className="mt-0.5 accent-blue-500"
                />
                <Badge color={CATEGORY_COLORS[atom.category] || 'zinc'}>{atom.category}</Badge>
                <p className="flex-1 text-xs text-zinc-300 leading-relaxed line-clamp-2">{atom.text}</p>
              </div>
            ))
          )}

          {/* Pagination */}
          {pages > 1 && (
            <div className="flex items-center justify-center gap-2 py-2">
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

        {/* Sticky footer */}
        <div className="flex items-center justify-between pt-3 mt-3 border-t border-zinc-700/60 shrink-0">
          <span className="text-xs text-zinc-400">{selected.size} selected</span>
          <div className="flex gap-2">
            <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
            <Btn variant="primary" onClick={() => onApply([...selected])}>Apply</Btn>
          </div>
        </div>
      </div>
    </Modal>
  );
}
