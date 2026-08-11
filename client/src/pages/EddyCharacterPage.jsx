import { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, Btn, Input, Spinner } from '../components/UI';
import { useApp } from '../context/AppContext';
import { characters as charApi } from '../services/api';
import { createEddyCollection } from '../lib/eddyCollectionStore';
import { cn } from '../lib/utils';

/**
 * Eddy's characters: a list of people, not a pile of photos.
 *
 * A character is a folder; her images are its contents. Two of them can carry a role:
 *   base  — image 1, the face and identity Seedream anchors on
 *   scene — the picture whose background and setting should be reused
 * Everything else is an extra identity reference.
 */
const DB = 'eddy-character';
// A character is a person, and every collection that files things per-person should know about her
// the moment she exists — not the first time something happens to land there (owner, 2026-08-09).
const BASE_DB = 'eddy-base';
const LIBRARY_DB = 'eddy-library';

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function urlToDataUrl(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error('Could not load image');
  const blob = await resp.blob();
  return fileToDataUrl(new File([blob], 'ref', { type: blob.type || 'image/png' }));
}

export default function EddyCharacterPage() {
  const { notify } = useApp();
  const store = useMemo(() => createEddyCollection(DB), []);
  const baseStore = useMemo(() => createEddyCollection(BASE_DB), []);
  const libraryStore = useMemo(() => createEddyCollection(LIBRARY_DB), []);

  /**
   * Give a character her folder in Base Library and Eddy Library too.
   *
   * ensureFolder is a no-op when the folder already exists, so this is safe to call on every
   * create and every import — and it means Base can file straight into her name, and anything
   * sent to the Library has somewhere to go, without either page having to invent the folder
   * later.
   */
  const mirrorFolders = useCallback(async (name) => {
    const clean = String(name || '').trim();
    if (!clean) return;
    // Failure here must never fail the character itself — the folders are a convenience.
    try { await baseStore.ensureFolder(clean); } catch { /* non-fatal */ }
    try { await libraryStore.ensureFolder(clean); } catch { /* non-fatal */ }
  }, [baseStore, libraryStore]);

  const [folders, setFolders] = useState([]);
  const [items, setItems] = useState([]);
  const [thumbs, setThumbs] = useState({});
  const [openId, setOpenId] = useState(null);        // null = the character list
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [importList, setImportList] = useState(null);
  const [importing, setImporting] = useState('');
  const [dragging, setDragging] = useState(false);

  const refresh = useCallback(async () => {
    const [f, i] = await Promise.all([store.listFolders(), store.listItems()]);
    setFolders(f);
    setItems(i);
    const map = {};
    await Promise.all(i.map(async (it) => { map[it.id] = it.url || await store.getImage(it.id); }));
    setThumbs(map);
    setLoading(false);
  }, [store]);

  useEffect(() => { refresh(); }, [refresh]);

  // Oldest first, then whichever image is marked base is pulled to the front — this is the exact
  // order Generate sends, so what is on screen is what Seedream receives.
  const imagesOf = useCallback((folderId) => {
    const mine = items.filter((i) => i.folderId === folderId).sort((a, b) => a.createdAt - b.createdAt);
    const base = mine.findIndex((i) => i.role === 'base');
    return base > 0 ? [mine[base], ...mine.filter((_, n) => n !== base)] : mine;
  }, [items]);

  const open = folders.find((f) => f.id === openId) || null;
  const openImages = openId ? imagesOf(openId) : [];

  const addFiles = useCallback(async (files, folderId) => {
    const valid = Array.from(files || []).filter((f) => /^image\/(png|jpe?g|webp)$/i.test(f.type));
    if (!valid.length) return;
    // Settle per file so one unreadable photo cannot drop the whole drop silently.
    const read = await Promise.allSettled(valid.map(async (f) => ({ dataUrl: await fileToDataUrl(f), name: f.name })));
    const payload = read.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!payload.length) { notify('None of those files could be read', 'error'); await refresh(); return; }
    try {
      const stored = await store.addItems(payload, folderId);
      const lost = (valid.length - stored.length) + (stored.failed || 0);
      if (lost) notify(`Added ${stored.length} of ${valid.length} — ${lost} could not be saved`, 'error');
      else notify(`Added ${stored.length} image${stored.length === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      notify(err.message || 'Could not save those images', 'error');
    }
    await refresh();
  }, [store, refresh, notify]);

  // Drop and paste only make sense inside a character — at the list level there is no one to
  // attach them to.
  /**
   * Drop a FOLDER onto this page and it becomes a character: the folder's name is hers, its images
   * become her references.
   *
   * dataTransfer.files flattens a directory drop into a bare file list, so the folder name — the
   * one piece of information that makes this work — is thrown away. webkitGetAsEntry keeps it
   * (owner, 2026-08-09: "I will drag a folder named lily with images and it gonna add it as
   * character").
   *
   * ensureFolder matches by name, so re-dropping the same folder tops her up rather than creating
   * a second Lily. Sub-directories are walked into and their images join the same character — a
   * character is one person, not a tree, so nesting is flattened deliberately rather than
   * mirrored.
   */
  const addDroppedCharacters = useCallback(async (entries) => {
    const readDir = (reader) => new Promise((res, rej) => reader.readEntries(res, rej));
    const asFile = (entry) => new Promise((res, rej) => entry.file(res, rej));

    let made = 0;
    let imgs = 0;
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const folder = await store.ensureFolder(entry.name);
      await mirrorFolders(entry.name);
      made += 1;

      const collect = async (dir) => {
        const reader = dir.createReader();
        // readEntries returns ~100 at a time; a single call silently truncates a big folder.
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          const batch = await readDir(reader);
          if (!batch.length) break;
          for (const child of batch) {
            if (child.isDirectory) { await collect(child); continue; }
            // eslint-disable-next-line no-await-in-loop
            const f = await asFile(child);
            if (!f.type.startsWith('image/')) continue;
            // eslint-disable-next-line no-await-in-loop
            const dataUrl = await fileToDataUrl(f);
            // eslint-disable-next-line no-await-in-loop
            await store.addItems([{ dataUrl, name: entry.name }], folder.id);
            imgs += 1;
          }
        }
      };
      await collect(entry);
    }
    await refresh();
    notify(
      made
        ? `Added ${made} character${made === 1 ? '' : 's'} · ${imgs} image${imgs === 1 ? '' : 's'}`
        : 'No folders in that drop',
      made ? 'success' : 'error',
    );
  }, [store, mirrorFolders, refresh, notify]);

  useEffect(() => {
    if (!openId) return undefined;
    const over = (e) => { e.preventDefault(); if (e.dataTransfer?.types?.includes('Files')) setDragging(true); };
    const leave = (e) => { if (!e.relatedTarget) setDragging(false); };
    const drop = (e) => {
      e.preventDefault();
      setDragging(false);
      // Directories FIRST: a folder drop also fills dataTransfer.files with its contents
      // flattened, so checking files first would take the flat path and lose the folder name.
      const entries = Array.from(e.dataTransfer?.items || [])
        .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
        .filter(Boolean);
      if (entries.some((en) => en.isDirectory)) { addDroppedCharacters(entries); return; }
      if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files, openId);
    };
    const paste = (e) => {
      const files = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
      if (files.length) { e.preventDefault(); addFiles(files, openId); }
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      window.removeEventListener('paste', paste);
    };
  }, [openId, addFiles, addDroppedCharacters]);

  // A role is exclusive within a character: marking a new base or scene clears the old one.
  const setRole = async (folderId, itemId, role) => {
    const mine = items.filter((i) => i.folderId === folderId);
    for (const it of mine) {
      const wanted = it.id === itemId ? (it.role === role ? '' : role) : (it.role === role ? '' : it.role || '');
      if ((it.role || '') !== wanted) await store.updateItem(it.id, { role: wanted });
    }
    await refresh();
  };


  const createCharacter = async () => {
    if (!newName.trim()) return;
    const f = await store.createFolder(newName);
    await mirrorFolders(newName);
    setNewName('');
    await refresh();
    setOpenId(f.id);
  };

  const loadImportable = async () => {
    if (importList) { setImportList(null); return; }
    try {
      const res = await charApi.list();
      setImportList(Array.isArray(res) ? res : (res?.characters || []));
    } catch {
      notify('Could not load your characters', 'error');
    }
  };

  const importOne = async (char) => {
    setImporting(char.id);
    try {
      const urls = [];
      for (let i = 0; i < (char.primaryImageCount || 1); i += 1) urls.push(charApi.primaryImageUrl(char.id, i));
      try {
        const detail = await charApi.get(char.id);
        // References default to inactive, so they are NOT filtered on isActive — doing that
        // once discarded every reference a character had.
        for (const ref of detail?.references || []) urls.push(charApi.refImageUrl(char.id, ref.id));
      } catch { /* her primary images are enough */ }

      const images = [];
      for (const u of urls) {
        try { images.push({ dataUrl: await urlToDataUrl(u), name: char.name }); } catch { /* skip */ }
      }
      if (!images.length) throw new Error('None of her images could be read');

      // ensureFolder, not find-then-create: the read would otherwise sit outside the write
      // queue and could miss a folder that is already queued — the exact race that produced
      // two "Grace" folders.
      const folder = await store.ensureFolder(char.name);
      await mirrorFolders(char.name);
      const stored = await store.addItems(images, folder.id);
      const lost = (images.length - stored.length) + (stored.failed || 0);
      if (lost) notify(`${char.name}: saved ${stored.length} of ${images.length} images`, 'error');
      else notify(`${char.name} imported — ${stored.length} image${stored.length === 1 ? '' : 's'}`, 'success');
      setImportList(null);
      await refresh();
    } catch (err) {
      notify(err.message || 'Import failed', 'error');
    } finally {
      setImporting('');
    }
  };

  /**
   * Import characters from an exported JSON file.
   *
   * The tab could ONLY pull from the server Characters API — there was no way to take a character
   * someone sent you as a file, which is how they actually get shared (owner, 2026-08-07: Eddy
   * sent six over Telegram and nothing here could read them).
   *
   * Tolerant about the name field on purpose. Our own export writes `folder`, the collection
   * exporter writes `title`, and Eddy's file uses `character` — three names for one thing, and
   * rejecting two of them would just push the mismatch onto whoever is sending the file.
   *
   * Grouped by name so one file can carry several characters, and `role` is carried through, so a
   * photo marked BASE stays the base — which is what Base Image Generation reads to decide which
   * reference leads.
   */
  const importFromFile = async (file) => {
    if (!file) return;
    setImporting('file');
    try {
      const rows = JSON.parse(await file.text());
      if (!Array.isArray(rows)) throw new Error('That file is not a character export');

      const groups = new Map();
      for (const r of rows) {
        const name = String(r?.character || r?.folder || r?.title || '').trim();
        const img = r?.image || r?.dataUrl || '';
        if (!name || !String(img).startsWith('data:')) continue;
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push({ dataUrl: img, name, role: r.role || '' });
      }
      if (!groups.size) throw new Error('No characters with images in that file');

      let chars = 0, imgs = 0, lost = 0;
      for (const [name, images] of groups) {
        // ensureFolder, not find-then-create — same race that once produced two "Grace" folders.
        // eslint-disable-next-line no-await-in-loop
        const folder = await store.ensureFolder(name);
        // eslint-disable-next-line no-await-in-loop -- same reason as the write below
        await mirrorFolders(name);
        // eslint-disable-next-line no-await-in-loop
        const stored = await store.addItems(images, folder.id);
        // addItems skips an item whose bytes blew the quota rather than throwing, so a partial
        // import must be REPORTED — a 21MB reference silently vanishing is worse than a warning.
        lost += (images.length - stored.length) + (stored.failed || 0);
        // Re-apply role: addItems only carries the fields it knows about.
        for (let i = 0; i < stored.length; i += 1) {
          const role = images[i]?.role;
          // eslint-disable-next-line no-await-in-loop
          if (role) await store.updateItem(stored[i].id, { role });
        }
        chars += 1; imgs += stored.length;
      }
      await refresh();
      notify(
        lost ? `Imported ${chars} character${chars === 1 ? '' : 's'}, ${imgs} image${imgs === 1 ? '' : 's'} — ${lost} too large to store`
             : `Imported ${chars} character${chars === 1 ? '' : 's'}, ${imgs} image${imgs === 1 ? '' : 's'}`,
        lost ? 'error' : 'success',
      );
    } catch (err) {
      notify(err.message || 'Could not read that file', 'error');
    } finally {
      setImporting('');
    }
  };

  /** Export every character as the same shape importFromFile reads, so a file round-trips. */
  const exportAll = async () => {
    try {
      const rows = [];
      for (const f of folders) {
        for (const it of items.filter((i) => i.folderId === f.id)) {
          // eslint-disable-next-line no-await-in-loop
          const dataUrl = thumbs[it.id] || await store.getImage(it.id);
          if (dataUrl) rows.push({ character: f.name, image: dataUrl, role: it.role || '' });
        }
      }
      if (!rows.length) { notify('Nothing to export', 'error'); return; }
      const blob = new Blob([JSON.stringify(rows)], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href; a.download = 'eddy-character.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10000);
      notify(`Exported ${rows.length} image${rows.length === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      notify(err.message || 'Export failed', 'error');
    }
  };

  const removeCharacter = async (id) => {
    for (const it of items.filter((i) => i.folderId === id)) await store.removeItem(it.id);
    await store.deleteFolder(id);
    if (openId === id) setOpenId(null);
    await refresh();
  };

  if (loading) return <div className="flex justify-center py-16"><Spinner size={28} /></div>;

  // ── One character ──────────────────────────────────────────────────────────────────────────
  if (open) {
    return (
      <div className={cn('mx-auto max-w-4xl space-y-4 animate-in', dragging && 'ring-2 ring-rose-500/50 rounded-2xl')}>
        <div className="flex items-center gap-3">
          <Btn variant="ghost" className="!rounded-lg !py-1.5 !px-3 !text-sm" onClick={() => setOpenId(null)}>← All characters</Btn>
          <h2 className="text-lg font-semibold text-zinc-100">{open.name}</h2>
          <span className="text-xs text-zinc-600">{openImages.length} image{openImages.length === 1 ? '' : 's'}</span>
          <label className="ml-auto inline-flex cursor-pointer items-center rounded-lg border border-white/[0.06] bg-white/[0.04] px-4 py-2 text-sm text-zinc-300 hover:bg-white/[0.07]">
            Add images
            <input type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden"
              onChange={(e) => { addFiles(e.target.files, open.id); e.target.value = ''; }} />
          </label>
        </div>

        <p className="text-xs text-zinc-500">
          <span className="text-rose-400">Base</span> is image 1 — her face and identity.
          <span className="text-emerald-400"> Body</span> is where her figure and bust come from.
          <span className="text-sky-400"> Scene</span> is the background and lighting to reuse.
          Clothing is never taken from these — that comes from the outfit. Drop or paste to add more.
        </p>

        {!openImages.length ? (
          <p className="py-10 text-center text-sm text-zinc-600">No images yet — drop, paste or upload her photos.</p>
        ) : (
          <div className="grid [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))] gap-3">
            {openImages.map((it, idx) => (
              <Card key={it.id} className="p-2 space-y-2">
                <div className="relative">
                  <img src={thumbs[it.id]} alt="" className="aspect-[3/4] w-full rounded-lg object-cover bg-zinc-950" />
                  {idx === 0 && <span className="absolute left-1 top-1 rounded-md bg-rose-500 px-1.5 py-0.5 text-[0.5625rem] font-bold text-white">BASE</span>}
                  <button
                    onClick={async () => { await store.removeItem(it.id); await refresh(); }}
                    title="Remove this image"
                    className="absolute right-1 bottom-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/70 text-sm text-zinc-200 transition hover:bg-red-600 hover:text-white cursor-pointer"
                  >×</button>
                  {it.role === 'body' && <span className="absolute right-1 top-1 rounded-md bg-emerald-500 px-1.5 py-0.5 text-[0.5625rem] font-bold text-white">BODY</span>}
                  {it.role === 'scene' && <span className="absolute right-1 top-1 rounded-md bg-sky-500 px-1.5 py-0.5 text-[0.5625rem] font-bold text-white">SCENE</span>}
                </div>
                <div className="grid grid-cols-3 gap-1">
                  <Btn variant={idx === 0 ? 'primary' : 'secondary'} className="!w-full !rounded-lg !py-1 !px-0 !text-[0.625rem]"
                    onClick={() => setRole(open.id, it.id, 'base')}>Base</Btn>
                  <Btn variant={it.role === 'body' ? 'primary' : 'secondary'} className="!w-full !rounded-lg !py-1 !px-0 !text-[0.625rem]"
                    onClick={() => setRole(open.id, it.id, 'body')}>Body</Btn>
                  <Btn variant={it.role === 'scene' ? 'primary' : 'secondary'} className="!w-full !rounded-lg !py-1 !px-0 !text-[0.625rem]"
                    onClick={() => setRole(open.id, it.id, 'scene')}>Scene</Btn>

                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── The character list ─────────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-4xl space-y-4 animate-in">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100">Eddy · Character</h2>
        <p className="text-sm text-zinc-500">Pick a character to see her images and set which one is the base and which is the scene.</p>
      </div>

      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input value={newName} onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') createCharacter(); }}
            placeholder="New character name" className="!h-9 !py-1 !text-sm w-52" />
          <Btn className="!rounded-lg !py-2 !px-4 !text-sm" onClick={createCharacter}>Create</Btn>
          <Btn variant="secondary" className="!rounded-lg !py-2 !px-4 !text-sm ml-auto" onClick={loadImportable}>
            {importList ? 'Close' : 'Import from Characters'}
          </Btn>
          {/* Import a character someone SENT you. Reads `character`, `folder` or `title` as the
              name, so an export from this tab, from the collection exporter, or from a partner's
              build all work without anyone having to reshape the file first. */}
          <label className={cn('rounded-lg border border-zinc-600 bg-zinc-800 px-4 py-2 text-sm font-semibold text-zinc-100 transition',
            importing === 'file' ? 'opacity-60' : 'cursor-pointer hover:border-zinc-500')}>
            {importing === 'file' ? 'Importing…' : 'Import file'}
            <input type="file" accept="application/json,.json" className="hidden"
              disabled={importing === 'file'}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; importFromFile(f); }} />
          </label>
          <Btn variant="secondary" className="!rounded-lg !py-2 !px-4 !text-sm" onClick={exportAll}>Export all</Btn>
        </div>

        {importList && (
          !importList.length ? <p className="py-3 text-center text-xs text-zinc-600">No characters found.</p> : (
            <div className="grid [grid-template-columns:repeat(auto-fill,minmax(110px,1fr))] gap-2">
              {importList.map((c) => (
                <button key={c.id} onClick={() => importOne(c)} disabled={Boolean(importing)}
                  className="overflow-hidden rounded-xl border border-zinc-800/60 text-left transition hover:border-rose-500/60 disabled:opacity-50 cursor-pointer">
                  <div className="relative">
                    <img src={charApi.imageUrl(c.id)} alt="" className="aspect-square w-full object-cover bg-zinc-950" loading="lazy" />
                    {importing === c.id && <div className="absolute inset-0 flex items-center justify-center bg-black/60"><Spinner size={20} /></div>}
                  </div>
                  <p className="truncate px-2 py-1.5 text-xs text-zinc-200">{c.name}</p>
                </button>
              ))}
            </div>
          )
        )}
      </Card>

      {!folders.length ? (
        <p className="py-10 text-center text-sm text-zinc-600">No characters yet — create one, or import from Characters.</p>
      ) : (
        <div className="grid [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))] gap-3">
          {folders.map((f) => {
            const imgs = imagesOf(f.id);
            return (
              <Card key={f.id} className="group relative p-2 space-y-2 cursor-pointer transition hover:ring-1 hover:ring-rose-500/40"
                onClick={() => setOpenId(f.id)}>
                {imgs.length
                  ? <img src={thumbs[imgs[0].id]} alt="" className="aspect-[3/4] w-full rounded-lg object-cover bg-zinc-950" />
                  : <div className="flex aspect-[3/4] items-center justify-center rounded-lg bg-white/[0.02] text-xs text-zinc-600">No images</div>}
                <div className="px-1 pb-1">
                  <p className="truncate text-sm font-medium text-zinc-200">{f.name}</p>
                  <p className="text-[0.625rem] text-zinc-600">{imgs.length} image{imgs.length === 1 ? '' : 's'}</p>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); removeCharacter(f.id); }}
                  title="Delete character and her images"
                  className="absolute right-2 top-2 hidden h-6 w-6 items-center justify-center rounded-full bg-black/70 text-xs text-zinc-300 hover:text-red-400 group-hover:flex cursor-pointer"
                >×</button>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
