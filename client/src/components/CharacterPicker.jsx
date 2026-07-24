import { useState, useMemo } from "react";
import { Badge } from "./UI";

const PINS_KEY = "kyros.charPicker.pinnedIds";
function loadPins() {
  try { return new Set(JSON.parse(localStorage.getItem(PINS_KEY) || "[]")); } catch { return new Set(); }
}
function savePins(set) {
  try { localStorage.setItem(PINS_KEY, JSON.stringify([...set])); } catch {}
}

const AVATAR_COLORS = [
  "from-pink-500 to-rose-600",
  "from-rose-500 to-rose-600",
  "from-rose-500 to-cyan-600",
  "from-emerald-500 to-teal-600",
  "from-orange-500 to-amber-600",
  "from-red-500 to-pink-600",
  "from-rose-500 to-rose-600",
  "from-fuchsia-500 to-rose-600",
];
function avatarColor(name = "") {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initials(name = "") {
  const parts = name.replace(/_/g, " ").split(" ").filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export default function CharacterPicker({
  chars = [],
  selectedIds = [],
  onToggle,
  charDetails = {},
  label = "Character",
  maxHeight = "max-h-56",
}) {
  const [pinnedIds, setPinnedIds] = useState(() => loadPins());
  const [search, setSearch] = useState("");

  const togglePin = (id, e) => {
    e.stopPropagation();
    setPinnedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      savePins(next);
      return next;
    });
  };

  const sorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q ? chars.filter(c => c.name.toLowerCase().includes(q)) : chars;
    const pinned = filtered.filter(c => pinnedIds.has(c.id));
    const rest = filtered.filter(c => !pinnedIds.has(c.id));
    return { pinned, rest, hasPins: pinned.length > 0 };
  }, [chars, pinnedIds, search]);

  if (chars.length === 0) {
    return (
      <div>
        {label && <span className="text-xs text-zinc-400 font-medium block mb-1.5">{label}</span>}
        <p className="text-xs text-zinc-500">No characters yet — create one in the Characters section.</p>
      </div>
    );
  }

  const renderChar = (c) => {
    const isChecked = selectedIds.includes(c.id);
    const isPinned = pinnedIds.has(c.id);
    const detail = charDetails[c.id];
    const activeRefs = detail?.references?.filter(r => r.isActive).length ?? 0;
    const color = avatarColor(c.name);

    return (
      <button
        key={c.id}
        type="button"
        onClick={() => onToggle(c.id)}
        className={`w-full flex items-center gap-2.5 rounded-xl border px-2.5 py-2 text-sm transition cursor-pointer text-left group ${
          isChecked
            ? "border-rose-500/70 bg-rose-500/15 text-rose-100 shadow-sm shadow-rose-500/10"
            : "border-zinc-700/50 bg-zinc-900/40 text-zinc-300 hover:border-zinc-600/70 hover:bg-zinc-800/50"
        }`}
      >
        <span className={`flex-shrink-0 w-7 h-7 rounded-lg bg-gradient-to-br ${color} flex items-center justify-center text-[0.625rem] font-bold text-white shadow-sm`}>
          {initials(c.name)}
        </span>
        <span className="flex-1 font-medium truncate text-[0.8125rem]">{c.name}</span>
        {activeRefs > 0 && (
          <span className="text-[0.625rem] text-zinc-500 shrink-0">{activeRefs}r</span>
        )}
        <span
          role="button"
          tabIndex={-1}
          onClick={(e) => togglePin(c.id, e)}
          title={isPinned ? "Unpin" : "Pin to top"}
          className={`flex-shrink-0 text-[0.8125rem] leading-none transition opacity-0 group-hover:opacity-100 ${
            isPinned ? "opacity-100 text-yellow-400" : "text-zinc-600 hover:text-yellow-400"
          }`}
        >
          {isPinned ? "📌" : "📍"}
        </span>
        <span className={`flex-shrink-0 w-4 h-4 rounded-md border-2 flex items-center justify-center transition ${
          isChecked ? "border-rose-400 bg-rose-500" : "border-zinc-600"
        }`}>
          {isChecked && (
            <svg width="9" height="7" viewBox="0 0 10 8" fill="none">
              <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
      </button>
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        {label && <span className="text-xs text-zinc-400 font-medium">{label}</span>}
        {selectedIds.length > 0 && <Badge color="blue">{selectedIds.length} selected</Badge>}
      </div>
      {chars.length > 5 && (
        <div className="mb-2">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search characters..."
            className="w-full rounded-lg border border-zinc-700/60 bg-zinc-950/40 px-2.5 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 outline-none focus:border-rose-500/50"
          />
        </div>
      )}
      <div className={`${maxHeight} overflow-y-auto space-y-1 pr-0.5`}>
        {sorted.hasPins && (
          <>
            <div className="text-[0.5625rem] uppercase tracking-widest text-zinc-600 px-1 pb-0.5 font-semibold">Pinned</div>
            {sorted.pinned.map(renderChar)}
            {sorted.rest.length > 0 && (
              <div className="text-[0.5625rem] uppercase tracking-widest text-zinc-600 px-1 pb-0.5 pt-1 font-semibold border-t border-zinc-800/60 mt-1">All</div>
            )}
          </>
        )}
        {sorted.rest.map(renderChar)}
        {sorted.pinned.length === 0 && sorted.rest.length === 0 && (
          <p className="text-xs text-zinc-600 px-1">No results for &quot;{search}&quot;</p>
        )}
      </div>
    </div>
  );
}
