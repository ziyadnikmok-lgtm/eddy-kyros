import { useState, useEffect, useRef, useCallback } from 'react';
import { characters as charApi, outfits as outfitApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { resizeAndCompressImage } from '../lib/imageCompression';
import { useAsync } from '../hooks/useAsync';
import { Card, Btn, Input, Textarea, Modal, Badge, Spinner, Empty, ConfirmDialog } from '../components/UI';
import { IconUsers, IconCamera, IconImage } from 'nucleo-glass';
import { downloadBlob } from '../lib/stripMetadata';

const CATEGORIES = ['Clothing', 'Hairstyle', 'Pose', 'Accessory', 'Expression', 'Lighting', 'Custom'];
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_CHARACTER_IMAGE_BYTES = 10 * 1024 * 1024;

function formatFileSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function getImageValidationError(file) {
  if (!file) return 'Please choose an image file';
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return 'Unsupported image format. Use PNG, JPG, or WEBP. HEIC is not supported.';
  }
  if (file.size > MAX_CHARACTER_IMAGE_BYTES) {
    return `Image is too large (${formatFileSize(file.size)}). Use a file under 10MB.`;
  }
  return null;
}

function validateCharacterImageFile(file, notify) {
  const error = getImageValidationError(file);
  if (error) {
    notify(error, 'error');
    return false;
  }
  return true;
}

function getPastedImageFile(event) {
  const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith('image/'));
  return item?.getAsFile() || null;
}

function characterImageFormData(fields, file) {
  const formData = new FormData();
  Object.entries(fields).forEach(([key, value]) => {
    if (value !== undefined && value !== null) formData.append(key, value);
  });
  formData.append('image', file, file.name || 'character-image');
  return formData;
}

export default function CharactersPage() {
  const { notify, characters: chars, refreshCharacters } = useApp();
  const [selected, setSelected] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showAddRef, setShowAddRef] = useState(false);
  const [createSeedFile, setCreateSeedFile] = useState(null);
  const [isCreateCardDragging, setIsCreateCardDragging] = useState(false);
  const { loading, run } = useAsync();

  const load = refreshCharacters;

  const selectChar = async (id) => {
    const data = await run(() => charApi.get(id));
    if (data) setSelected(data);
  };

  const openCreate = useCallback((file = null) => {
    setCreateSeedFile(file);
    setShowCreate(true);
  }, []);

  const handleCreateSeedFile = useCallback((file) => {
    if (!validateCharacterImageFile(file, notify)) return;
    openCreate(file);
  }, [notify, openCreate]);

  const handleCreateCardPaste = useCallback((event) => {
    const file = getPastedImageFile(event);
    if (!file) return;
    event.preventDefault();
    setIsCreateCardDragging(false);
    handleCreateSeedFile(file);
  }, [handleCreateSeedFile]);

  const handleCreateCardDrop = useCallback((event) => {
    event.preventDefault();
    setIsCreateCardDragging(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) handleCreateSeedFile(file);
  }, [handleCreateSeedFile]);

  return (
    <div className="space-y-6 animate-in">
      {chars.length === 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 min-h-[400px]">
          {/* 1 — New Character (main, bigger) */}
          <button
            onClick={() => openCreate()}
            onDragOver={(event) => { event.preventDefault(); setIsCreateCardDragging(true); }}
            onDragLeave={() => setIsCreateCardDragging(false)}
            onDrop={handleCreateCardDrop}
            onPaste={handleCreateCardPaste}
            className={`group relative rounded-2xl border transition-all duration-300 flex flex-col items-center justify-center gap-6 cursor-pointer overflow-hidden py-16 px-8 ${
              isCreateCardDragging
                ? 'border-rose-500/70 bg-rose-500/10'
                : 'border-zinc-700/50 bg-zinc-900/40 hover:bg-zinc-900/70 hover:border-rose-500/40'
            }`}
          >
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(59,130,246,0.07)_0%,transparent_70%)] opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(59,130,246,0.04)_0%,transparent_60%)]" />

            <div className="relative w-24 h-24 rounded-2xl bg-gradient-to-br from-rose-600/30 to-rose-800/20 border border-rose-500/30 flex items-center justify-center shadow-[0_0_40px_rgba(59,130,246,0.15)] group-hover:shadow-[0_0_70px_rgba(59,130,246,0.3)] transition-all duration-300">
              <span className="text-5xl text-rose-400 font-extralight leading-none group-hover:scale-110 transition-transform duration-200 inline-block">+</span>
            </div>

            <div className="relative text-center space-y-2">
              <p className="text-2xl font-semibold text-zinc-100 group-hover:text-white transition-colors">New Character</p>
              <p className="text-sm text-zinc-500 group-hover:text-zinc-400 transition-colors max-w-xs leading-relaxed">
                Create your own identity-locked character and use it across all your generations
              </p>
            </div>

            <div className="relative flex items-center gap-2 text-xs text-zinc-600 group-hover:text-zinc-500 transition-colors">
              <span className="w-6 h-px bg-zinc-700/60" />
              Drop or paste image to start
              <span className="w-6 h-px bg-zinc-700/60" />
            </div>
          </button>

          {/* 2 — Get a Character */}
          <button
            onClick={() => window.open('https://aicreatormarketplace.com?ref=ZiyadAiOFM', '_blank', 'noopener,noreferrer')}
            className="group relative rounded-2xl border border-zinc-700/40 bg-zinc-900/20 hover:bg-zinc-900/50 hover:border-zinc-600/60 transition-all duration-300 flex flex-col items-center justify-center gap-6 cursor-pointer overflow-hidden py-16 px-8"
          >
            <div className="relative w-24 h-24 rounded-2xl bg-zinc-800/60 border border-zinc-700/40 flex items-center justify-center group-hover:border-zinc-600 transition-all duration-300">
              <IconUsers uniqueId="get-char-icon" size={36} className="text-zinc-500 group-hover:text-zinc-400 transition-colors" aria-hidden />
            </div>

            <div className="relative text-center space-y-2">
              <p className="text-2xl font-semibold text-zinc-300 group-hover:text-zinc-100 transition-colors">Get a Character</p>
              <p className="text-sm text-zinc-600 group-hover:text-zinc-500 transition-colors max-w-xs leading-relaxed">
                Don't have one yet? Browse ready-made AI characters and start creating right away
              </p>
            </div>

            <div className="relative flex items-center gap-2 text-xs text-zinc-600 group-hover:text-zinc-500 transition-colors">
              <span className="w-6 h-px bg-zinc-700/60" />
              Browse marketplace
              <span className="w-6 h-px bg-zinc-700/60" />
            </div>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {/* Big + New Character card first */}
          <button
            onClick={() => openCreate()}
            onDragOver={(event) => { event.preventDefault(); setIsCreateCardDragging(true); }}
            onDragLeave={() => setIsCreateCardDragging(false)}
            onDrop={handleCreateCardDrop}
            onPaste={handleCreateCardPaste}
            className={`rounded-xl border-2 border-dashed transition-all flex flex-col items-center justify-center gap-2.5 cursor-pointer group aspect-square p-4 ${
              isCreateCardDragging
                ? 'border-rose-500/70 bg-rose-500/12'
                : 'border-rose-500/30 bg-rose-500/5 hover:bg-rose-500/10 hover:border-rose-500/50'
            }`}
          >
            <div className="w-12 h-12 rounded-xl bg-rose-600/20 border border-rose-500/40 flex items-center justify-center group-hover:bg-rose-600/30 transition-all">
              <span className="text-2xl text-rose-400 font-light leading-none">+</span>
            </div>
            <span className="text-sm font-semibold text-zinc-300 group-hover:text-zinc-100 transition-colors text-center">New Character</span>
            <span className="text-[0.6875rem] text-zinc-500 text-center">Drop or paste image</span>
          </button>

          {chars.map((c) => (
            <Card key={c.id} className={`cursor-pointer hover:border-zinc-600 transition-all !p-3 ${selected?.id === c.id ? '!border-rose-500 ring-1 ring-rose-500/20' : ''}`}
              onClick={() => selectChar(c.id)}>
              {/* Reference badges at top */}
              {c.references?.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {c.references.slice(0, 4).map((r, i) => (
                    <span key={i} className={`text-[0.5625rem] px-1.5 py-0.5 rounded-full font-medium border ${r.isActive !== false ? 'bg-rose-500/10 text-rose-400 border-rose-500/30' : 'bg-zinc-800 text-zinc-500 border-zinc-700/40'}`}>
                      {r.category || r}
                    </span>
                  ))}
                  {c.references.length > 4 && (
                    <span className="text-[0.5625rem] px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-500 border border-zinc-700/40">+{c.references.length - 4}</span>
                  )}
                </div>
              )}
              <div className="aspect-square rounded-lg overflow-hidden bg-zinc-900 mb-2">
                {c.hasPrimaryImage && <img src={charApi.imageUrl(c.id)} alt={c.name} className="w-full h-full object-cover" loading="lazy" />}
              </div>
              <div className="text-sm font-medium text-zinc-200 truncate">{c.name}</div>
              <div className="text-xs text-zinc-500 mt-0.5">{c.references?.length || 0} ref{c.references?.length !== 1 ? 's' : ''}</div>
            </Card>
          ))}
        </div>
      )}

      {selected && (
        <CharacterDetail char={selected} onUpdate={() => { load(); selectChar(selected.id); }} onDelete={() => { setSelected(null); load(); }}
          onAddRef={() => setShowAddRef(true)} />
      )}

      {selected && <Wardrobe characterId={selected.id} characterName={selected.name} />}

      <CreateCharacterModal
        open={showCreate}
        seedFile={createSeedFile}
        onClose={() => { setShowCreate(false); setCreateSeedFile(null); }}
        onCreated={() => { setShowCreate(false); setCreateSeedFile(null); load(); }}
      />
      {selected && <AddReferenceModal open={showAddRef} onClose={() => setShowAddRef(false)} characterId={selected.id} onAdded={() => { setShowAddRef(false); selectChar(selected.id); }} />}
    </div>
  );
}

function CharacterDetail({ char, onUpdate, onDelete, onAddRef }) {
  const { notify } = useApp();
  const { loading, run } = useAsync();
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState('');
  const [isPrimaryDragging, setIsPrimaryDragging] = useState(false);
  const primaryInputRef = useRef(null);
  // Cache-buster: primary image URLs are indexed (/primary-images/0,1,2). After a delete the
  // files shift down but the URLs don't, so the browser serves the CACHED old image — which
  // looked like "the wrong image was deleted". Bumping this on every change forces a re-fetch.
  const [imgBust, setImgBust] = useState(0);
  const bustImages = useCallback(() => setImgBust((v) => v + 1), []);
  const [dragIndex, setDragIndex] = useState(null);

  // Drag a primary image onto another to reorder. Index 0 is the face anchor (prompt image 1).
  const reorderPrimary = useCallback((from, to) => {
    if (from === to || from == null || to == null) return;
    const n = char.primaryImageCount || 1;
    const order = Array.from({ length: n }, (_, i) => i);
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    run(async () => {
      await charApi.reorderPrimaryImages(char.id, order);
      bustImages(); onUpdate();
    });
  }, [char.id, char.primaryImageCount, run, onUpdate, bustImages]);

  const addPrimaryImageFile = useCallback((file) => {
    if (!validateCharacterImageFile(file, notify)) return;
    run(async () => {
      const compressedFile = await resizeAndCompressImage(file);
      await charApi.addPrimaryImage(char.id, characterImageFormData({}, compressedFile));
      notify('Primary image added', 'success');
      bustImages(); onUpdate();
    });
  }, [char.id, notify, onUpdate, run, bustImages]);

  const addPrimaryImage = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    addPrimaryImageFile(file);
    e.target.value = '';
  };

  // Swap a specific primary image for a new one. No in-place endpoint exists, so it's
  // remove-that-index then add — done in one run() so the list refreshes once at the end.
  const replacePrimaryImageAt = useCallback((index) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file || !validateCharacterImageFile(file, notify)) return;
      run(async () => {
        const compressedFile = await resizeAndCompressImage(file);
        await charApi.removePrimaryImage(char.id, index);
        await charApi.addPrimaryImage(char.id, characterImageFormData({}, compressedFile));
        notify('Primary image replaced', 'success');
        bustImages(); onUpdate();
      });
    };
    input.click();
  }, [char.id, notify, onUpdate, run]);
  const removePrimaryImage = (index) => run(async () => {
    await charApi.removePrimaryImage(char.id, index);
    bustImages();
    notify('Primary image removed', 'success');
    onUpdate();
  });
  const toggleRef = (refId) => run(async () => {
    await charApi.toggleReference(char.id, refId);
    onUpdate();
  });
  const deleteRef = (refId) => run(async () => {
    await charApi.removeReference(char.id, refId);
    notify('Reference removed', 'success');
    onUpdate();
  });
  const deleteChar = () => run(async () => {
    await charApi.remove(char.id);
    notify('Character deleted', 'success');
    onDelete();
  });
  const duplicateChar = () => run(async () => {
    const copy = await charApi.duplicate(char.id);
    notify(`Duplicated as "${copy.name}"`, 'success');
    onUpdate();   // reloads the grid so the copy shows, keeps the original selected
  });
  const copyPrompt = () => {
    navigator.clipboard.writeText(char.masterPrompt);
    notify('Master prompt copied', 'success');
  };
  const savePrompt = () => run(async () => {
    await charApi.update(char.id, { masterPrompt: promptDraft.trim() });
    notify('Master prompt updated', 'success');
    setEditingPrompt(false);
    onUpdate();
  });
  const downloadImage = async (url, name) => {
    // Through downloadBlob so the saved file carries no generator metadata.
    const blob = await (await fetch(url, { credentials: 'include' })).blob();
    await downloadBlob(blob, name);
  };

  const imgCount = char.primaryImageCount || 1;

  return (
    <Card className="animate-in space-y-4">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0 mr-3">
          <h2 className="text-lg font-semibold">{char.name}</h2>
          <p className="text-xs text-zinc-500 mt-0.5 max-w-md line-clamp-2">{char.masterPrompt}</p>
          <div className="flex gap-2 mt-2">
            <button onClick={copyPrompt} className="text-xs text-zinc-400 hover:text-rose-400 transition cursor-pointer">Copy Prompt</button>
            <button onClick={() => { setPromptDraft(char.masterPrompt); setEditingPrompt(true); }} className="text-xs text-zinc-400 hover:text-rose-400 transition cursor-pointer">Edit Prompt</button>
          </div>
        </div>
        <div className="flex gap-2">
          <Btn variant="secondary" className="!text-xs !py-1.5" onClick={onAddRef}>+ Reference</Btn>
          <Btn variant="secondary" className="!text-xs !py-1.5" onClick={duplicateChar} disabled={loading}>Duplicate</Btn>
          <Btn variant="danger" className="!text-xs !py-1.5" onClick={() => setConfirmDelete({ type: 'character' })} disabled={loading}>Delete</Btn>
        </div>
      </div>

      {editingPrompt && (
        <div className="space-y-2 p-3 rounded-lg border border-rose-500/30 bg-rose-500/5">
          <textarea value={promptDraft} onChange={(e) => setPromptDraft(e.target.value)}
            className="w-full bg-zinc-900/80 border border-zinc-700/60 rounded-lg p-3 text-sm text-zinc-200 min-h-[120px] focus:outline-none focus:ring-1 focus:ring-rose-500/50 resize-y" />
          <div className="flex gap-2 justify-end">
            <Btn variant="ghost" className="!text-xs !py-1.5" onClick={() => setEditingPrompt(false)}>Cancel</Btn>
            <Btn className="!text-xs !py-1.5" onClick={savePrompt} disabled={loading || !promptDraft.trim()}>
              {loading ? <Spinner size={14} /> : null} Save
            </Btn>
          </div>
        </div>
      )}

      <div>
        <span className="text-sm text-zinc-400 font-medium block mb-2">Primary Images ({imgCount}/10)</span>
        <div className="flex gap-3 flex-wrap">
          {Array.from({ length: imgCount }, (_, i) => (
            <div
              key={`${i}-${imgBust}`}
              draggable
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); reorderPrimary(dragIndex, i); setDragIndex(null); }}
              onDragEnd={() => setDragIndex(null)}
              className={`relative group w-20 h-20 rounded-lg overflow-hidden bg-zinc-900 border cursor-grab active:cursor-grabbing transition ${i === 0 ? 'border-rose-500/70 ring-1 ring-rose-500/40' : 'border-zinc-700/40'} ${dragIndex === i ? 'opacity-40' : ''}`}
              title="Drag to reorder — the first image is the face"
            >
              <img src={`${charApi.primaryImageUrl(char.id, i)}?v=${imgBust}`} alt={`Primary ${i + 1}`} className="w-full h-full object-cover pointer-events-none" loading="lazy" />
              {i === 0 && (
                <span className="absolute bottom-0 inset-x-0 bg-rose-600/90 text-center text-[0.5rem] font-bold uppercase tracking-wider text-white py-0.5 pointer-events-none">Face</span>
              )}
              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition flex items-center justify-center gap-1">
                <button onClick={() => downloadImage(charApi.primaryImageUrl(char.id, i), `${char.name}-primary-${i + 1}.png`)}
                  className="w-6 h-6 rounded-full bg-black/70 text-rose-400 text-xs flex items-center justify-center cursor-pointer" title="Download">
                  ↓
                </button>
                <button onClick={() => replacePrimaryImageAt(i)}
                  className="w-6 h-6 rounded-full bg-black/70 text-sky-400 text-xs flex items-center justify-center cursor-pointer" title="Replace this image">
                  ⟳
                </button>
                {imgCount > 1 && (
                  <button onClick={() => setConfirmDelete({ type: 'primary', index: i })}
                    className="w-6 h-6 rounded-full bg-black/70 text-red-400 text-xs flex items-center justify-center cursor-pointer" title="Delete">
                    ✕
                  </button>
                )}
              </div>
            </div>
          ))}
          {imgCount < 10 && (
            <div
              tabIndex={0}
              onClick={() => primaryInputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  primaryInputRef.current?.click();
                }
              }}
              onPaste={(event) => {
                const file = getPastedImageFile(event);
                if (!file) return;
                event.preventDefault();
                addPrimaryImageFile(file);
              }}
              onDragOver={(event) => { event.preventDefault(); setIsPrimaryDragging(true); }}
              onDragLeave={() => setIsPrimaryDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setIsPrimaryDragging(false);
                const file = event.dataTransfer?.files?.[0];
                if (file) addPrimaryImageFile(file);
              }}
              className={`w-20 h-20 rounded-lg border-2 border-dashed flex flex-col items-center justify-center cursor-pointer transition outline-none ${
                isPrimaryDragging
                  ? 'border-rose-500/70 bg-rose-500/10'
                  : 'border-zinc-700/60 hover:border-rose-500/40'
              }`}
            >
              <span className="text-zinc-500 text-lg leading-none">+</span>
              <span className="mt-1 text-[0.5625rem] text-zinc-500">Drop / Paste</span>
              <input ref={primaryInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={addPrimaryImage} />
            </div>
          )}
        </div>
      </div>

      {char.references?.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {char.references.map((r) => (
            <div key={r.id} className={`rounded-lg border p-2 transition ${r.isActive ? 'border-rose-500/50 bg-rose-500/5' : 'border-zinc-700/40'}`}>
              <div className="flex items-center justify-between mb-1.5">
                <Badge color={r.isActive ? 'blue' : 'zinc'}>{r.category}</Badge>
                <div className="flex gap-1">
                  <button onClick={() => downloadImage(charApi.refImageUrl(char.id, r.id), `${char.name}-${r.category}.png`)}
                    className="text-xs text-zinc-500 hover:text-rose-400 cursor-pointer transition" title="Download image">↓</button>
                  <button onClick={() => toggleRef(r.id)} className={`text-xs px-1.5 py-0.5 rounded cursor-pointer transition ${r.isActive ? 'text-rose-400' : 'text-zinc-500 hover:text-zinc-300'}`}>
                    {r.isActive ? 'ON' : 'OFF'}
                  </button>
                  <button onClick={() => setConfirmDelete({ type: 'reference', id: r.id, label: r.category })} aria-label="Remove reference" className="text-xs text-zinc-600 hover:text-red-400 cursor-pointer transition">✕</button>
                </div>
              </div>
              <p className="text-xs text-zinc-400 line-clamp-2">{r.overridePrompt}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-zinc-500">No references yet. Add one to enable style overrides.</p>
      )}
      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete?.type === 'character') deleteChar();
          else if (confirmDelete?.type === 'primary') removePrimaryImage(confirmDelete.index);
          else if (confirmDelete?.type === 'reference') deleteRef(confirmDelete.id);
        }}
        title={
          confirmDelete?.type === 'character' ? `Delete "${char.name}"?`
            : confirmDelete?.type === 'primary' ? 'Remove primary image?'
              : `Remove ${confirmDelete?.label || ''} reference?`
        }
        message={
          confirmDelete?.type === 'character'
            ? 'This will permanently delete the character and all its references. This cannot be undone.'
            : confirmDelete?.type === 'primary'
              ? 'This will remove this primary reference image from the character.'
              : 'This will remove the reference image from this character.'
        }
        confirmLabel={confirmDelete?.type === 'character' ? 'Delete Character' : 'Remove'}
      />
    </Card>
  );
}

function CreateCharacterModal({ open, onClose, onCreated, seedFile }) {
  const { notify } = useApp();
  const { loading, run } = useAsync();
  const [name, setName] = useState('');
  const [masterPrompt, setMasterPrompt] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [isDragging, setIsDragging] = useState(false);

  const applyFile = useCallback((nextFile) => {
    if (!validateCharacterImageFile(nextFile, notify)) return;
    setFile(nextFile);
    const nextUrl = URL.createObjectURL(nextFile);
    setPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return nextUrl;
    });
  }, [notify]);

  const handleFile = (e) => {
    const nextFile = e.target.files?.[0];
    if (!nextFile) return;
    applyFile(nextFile);
    e.target.value = '';
  };

  useEffect(() => {
    if (!open) return;
    const onPaste = (event) => {
      const pastedFile = getPastedImageFile(event);
      if (!pastedFile) return;
      event.preventDefault();
      applyFile(pastedFile);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [open, applyFile]);

  useEffect(() => {
    if (open && seedFile) applyFile(seedFile);
  }, [open, seedFile, applyFile]);

  const handleCreate = () => run(async () => {
    if (!name.trim()) { notify('Character name is required', 'error'); return; }
    if (!masterPrompt.trim()) { notify('Master prompt is required — describe face, body, and defining traits', 'error'); return; }
    if (!file) { notify('Primary image is required — upload a clear reference photo', 'error'); return; }
    const compressedFile = await resizeAndCompressImage(file);
    await charApi.create(characterImageFormData({ name: name.trim(), masterPrompt: masterPrompt.trim() }, compressedFile));
    notify('Character created', 'success');
    if (preview) URL.revokeObjectURL(preview);
    setName(''); setMasterPrompt(''); setFile(null); setPreview(null);
    onCreated();
  });

  return (
    <Modal open={open} onClose={onClose} title="New Character">
      <div className="space-y-4">
        <Input label="Character Name" required placeholder="e.g. Aria the Warrior" value={name} onChange={(e) => setName(e.target.value)} />
        <Textarea label="Master Prompt (Identity Lock)" required placeholder="Describe face, body, skin, defining traits..." value={masterPrompt} onChange={(e) => setMasterPrompt(e.target.value)} className="!min-h-[100px]" />
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm text-zinc-400 font-medium">Primary Image<span className="text-red-400 ml-0.5">*</span></span>
            <Badge color="zinc">Ctrl+V to paste</Badge>
          </div>
          <label
            onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              const droppedFile = event.dataTransfer?.files?.[0];
              if (droppedFile) applyFile(droppedFile);
            }}
            className={`flex flex-col items-center justify-center border-2 border-dashed rounded-lg p-4 cursor-pointer transition h-32 ${
              isDragging
                ? 'border-rose-500/70 bg-rose-500/10'
                : preview
                  ? 'border-rose-500/40 bg-rose-500/5'
                  : 'border-zinc-700/80 hover:border-rose-500/30 bg-zinc-900/30'
            }`}
          >
            {preview ? <img src={preview} alt="" className="max-h-full rounded" /> : (
              <div className="text-center">
                <div className="flex justify-center mb-1 [--nc-gradient-1-color-1:currentColor] [--nc-gradient-1-color-2:currentColor]"><IconCamera uniqueId="char-primary-img" size={28} aria-hidden /></div>
                <span className="text-zinc-400 text-sm">Drop, click or paste a clear reference photo</span>
              </div>
            )}
            <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleFile} />
          </label>
          <p className="text-xs text-zinc-500 mt-2">Use PNG, JPG, or WEBP under 10MB. HEIC is not supported.</p>
          {file ? <p className="text-[0.6875rem] text-zinc-400 mt-1">{file.name} · {formatFileSize(file.size)}</p> : null}
        </div>
        <Btn onClick={handleCreate} disabled={loading || !name.trim() || !masterPrompt.trim() || !file} className="w-full">
          {loading ? <Spinner size={16} /> : null} Create Character
        </Btn>
      </div>
    </Modal>
  );
}

function AddReferenceModal({ open, onClose, characterId, onAdded }) {
  const { notify } = useApp();
  const { loading, run } = useAsync();
  const [category, setCategory] = useState('Clothing');
  const [overridePrompt, setOverridePrompt] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [isDragging, setIsDragging] = useState(false);

  const applyFile = useCallback((nextFile) => {
    if (!validateCharacterImageFile(nextFile, notify)) return;
    setFile(nextFile);
    const nextUrl = URL.createObjectURL(nextFile);
    setPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return nextUrl;
    });
  }, [notify]);

  useEffect(() => {
    if (!open) return;
    const onPaste = (event) => {
      const pastedFile = getPastedImageFile(event);
      if (!pastedFile) return;
      event.preventDefault();
      applyFile(pastedFile);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [open, applyFile]);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  const handleAdd = () => run(async () => {
    if (!file || !overridePrompt.trim()) { notify('Image and override prompt required', 'error'); return; }
    const compressedFile = await resizeAndCompressImage(file);
    await charApi.addReference(characterId, characterImageFormData({ category, overridePrompt: overridePrompt.trim() }, compressedFile));
    notify('Reference added', 'success');
    setOverridePrompt(''); setFile(null);
    setPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    onAdded();
  });

  return (
    <Modal open={open} onClose={onClose} title="Add Reference">
      <div className="space-y-4">
        <div>
          <span className="text-sm text-zinc-400 font-medium block mb-1.5">Category</span>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <button key={c} onClick={() => setCategory(c)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition cursor-pointer ${category === c ? 'bg-rose-600 text-white' : 'bg-zinc-700/60 text-zinc-300 hover:bg-zinc-700'}`}>
                {c}
              </button>
            ))}
          </div>
        </div>
        <Textarea label="Override Prompt" required placeholder="Describe this style override..." value={overridePrompt} onChange={(e) => setOverridePrompt(e.target.value)} />
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm text-zinc-400 font-medium">Reference Image<span className="text-red-400 ml-0.5">*</span></span>
            <Badge color="zinc">Ctrl+V to paste</Badge>
          </div>
        </div>
        <label
          onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            const droppedFile = event.dataTransfer?.files?.[0];
            if (droppedFile) applyFile(droppedFile);
          }}
          className={`flex flex-col items-center justify-center border-2 border-dashed rounded-lg p-4 cursor-pointer transition h-28 ${
            isDragging
              ? 'border-rose-500/70 bg-rose-500/10'
              : file
                ? 'border-rose-500/40 bg-rose-500/5'
                : 'border-zinc-700/80 hover:border-rose-500/30 bg-zinc-900/30'
          }`}
        >
          {preview ? (
            <img src={preview} alt="" className="max-h-full rounded object-contain" />
          ) : (
            <div className="text-center">
              <div className="flex justify-center mb-0.5 [--nc-gradient-1-color-1:currentColor] [--nc-gradient-1-color-2:currentColor]"><IconImage uniqueId="char-ref-img" size={20} aria-hidden /></div>
              <span className="text-zinc-400 text-sm">Drop, click or paste reference image</span>
            </div>
          )}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const nextFile = e.target.files?.[0];
              if (nextFile) applyFile(nextFile);
              e.target.value = '';
            }}
          />
        </label>
        {file ? <p className="text-[0.6875rem] text-zinc-400 mt-2">{file.name} · {formatFileSize(file.size)}</p> : null}
        <Btn onClick={handleAdd} disabled={loading || !file || !overridePrompt.trim()} className="w-full">
          {loading ? <Spinner size={16} /> : null} Add Reference
        </Btn>
      </div>
    </Modal>
  );
}

const OUTFIT_FIELDS = [
  { key: 'top', label: 'Top', placeholder: 'e.g. White cropped tank top' },
  { key: 'bottom', label: 'Bottom', placeholder: 'e.g. High-waisted black jeans' },
  { key: 'footwear', label: 'Footwear', placeholder: 'e.g. White sneakers' },
  { key: 'accessories', label: 'Accessories', placeholder: 'e.g. Gold hoop earrings, thin chain necklace' },
];

const TAG_PRESETS = ['Casual', 'Formal', 'Sporty', 'Streetwear', 'Beach', 'Evening', 'Cozy', 'Bold'];

function Wardrobe({ characterId, characterName }) {
  const { notify, refreshOutfits } = useApp();
  const { loading, run } = useAsync();
  const [outfits, setOutfits] = useState([]);
  const [editingOutfit, setEditingOutfit] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = () => {
    outfitApi.list(characterId).then(setOutfits).catch(() => setOutfits([]));
  };

  useEffect(() => { load(); }, [characterId]);

  const handleDelete = (id) => run(async () => {
    await outfitApi.remove(id);
    notify('Outfit deleted', 'success');
    setConfirmDelete(null);
    load();
    refreshOutfits();
  });

  const charOutfits = outfits.filter((o) => o.characterId === characterId);
  const sharedOutfits = outfits.filter((o) => !o.characterId);

  return (
    <Card className="animate-in space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-zinc-200">Wardrobe</h3>
          <p className="text-xs text-zinc-500 mt-0.5">{charOutfits.length} outfit{charOutfits.length !== 1 ? 's' : ''} for {characterName}{sharedOutfits.length > 0 ? ` + ${sharedOutfits.length} shared` : ''}</p>
        </div>
        <Btn variant="secondary" className="!text-xs !py-1.5" onClick={() => setShowCreate(true)}>+ Outfit</Btn>
      </div>

      {outfits.length === 0 ? (
        <p className="text-sm text-zinc-500 py-4 text-center">No outfits yet. Create one to use in generation.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {outfits.map((outfit) => (
            <OutfitCard key={outfit.id} outfit={outfit} isShared={!outfit.characterId}
              onEdit={() => setEditingOutfit(outfit)}
              onDelete={() => setConfirmDelete(outfit)} />
          ))}
        </div>
      )}

      <OutfitModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        characterId={characterId}
        onSaved={() => { setShowCreate(false); load(); refreshOutfits(); }}
      />
      <OutfitModal
        open={!!editingOutfit}
        onClose={() => setEditingOutfit(null)}
        outfit={editingOutfit}
        characterId={characterId}
        onSaved={() => { setEditingOutfit(null); load(); refreshOutfits(); }}
      />
      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && handleDelete(confirmDelete.id)}
        title={`Delete "${confirmDelete?.name}"?`}
        message="This outfit will be permanently removed. This cannot be undone."
        confirmLabel="Delete Outfit"
      />
    </Card>
  );
}

function OutfitCard({ outfit, isShared, onEdit, onDelete }) {
  const summary = [outfit.top, outfit.bottom, outfit.footwear].filter(Boolean).join(' / ');

  return (
    <div className="rounded-lg border border-zinc-700/40 bg-zinc-900/30 p-3 space-y-2 hover:border-zinc-600 transition group">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-200 truncate">{outfit.name}</span>
            {isShared && <Badge color="zinc">Shared</Badge>}
          </div>
          <p className="text-xs text-zinc-500 mt-0.5 line-clamp-1">{summary}</p>
        </div>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition shrink-0">
          <button onClick={onEdit} className="text-xs text-zinc-500 hover:text-rose-400 cursor-pointer transition px-1">Edit</button>
          <button onClick={onDelete} className="text-xs text-zinc-500 hover:text-red-400 cursor-pointer transition px-1">Del</button>
        </div>
      </div>

      {outfit.accessories && (
        <p className="text-[0.6875rem] text-zinc-500"><span className="text-zinc-600">Acc:</span> {outfit.accessories}</p>
      )}

      {(outfit.hairstyleOverride || outfit.makeupOverride) && (
        <div className="flex gap-2 flex-wrap">
          {outfit.hairstyleOverride && <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20">Hair: {outfit.hairstyleOverride}</span>}
          {outfit.makeupOverride && <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-pink-500/10 text-pink-400 border border-pink-500/20">Makeup: {outfit.makeupOverride}</span>}
        </div>
      )}

      {outfit.tags?.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {outfit.tags.map((tag) => (
            <span key={tag} className="text-[0.625rem] px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700/50">{tag}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function OutfitModal({ open, onClose, outfit, characterId, onSaved }) {
  const { notify } = useApp();
  const { loading, run } = useAsync();
  const isEdit = !!outfit;

  const [name, setName] = useState('');
  const [top, setTop] = useState('');
  const [bottom, setBottom] = useState('');
  const [footwear, setFootwear] = useState('');
  const [accessories, setAccessories] = useState('');
  const [hairstyleOverride, setHairstyleOverride] = useState('');
  const [makeupOverride, setMakeupOverride] = useState('');
  const [tags, setTags] = useState([]);
  const [assignToChar, setAssignToChar] = useState(true);

  useEffect(() => {
    if (open) {
      setName(outfit?.name || '');
      setTop(outfit?.top || '');
      setBottom(outfit?.bottom || '');
      setFootwear(outfit?.footwear || '');
      setAccessories(outfit?.accessories || '');
      setHairstyleOverride(outfit?.hairstyleOverride || '');
      setMakeupOverride(outfit?.makeupOverride || '');
      setTags(outfit?.tags || []);
      setAssignToChar(outfit ? !!outfit.characterId : true);
    }
  }, [open, outfit]);

  const toggleTag = (tag) => {
    setTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]);
  };

  const handleSave = () => run(async () => {
    if (!name.trim() || !top.trim() || !bottom.trim() || !accessories.trim() || !footwear.trim()) {
      notify('Name, top, bottom, accessories, and footwear are required', 'error');
      return;
    }
    const payload = {
      name: name.trim(),
      top: top.trim(),
      bottom: bottom.trim(),
      footwear: footwear.trim(),
      accessories: accessories.trim(),
      hairstyleOverride: hairstyleOverride.trim() || undefined,
      makeupOverride: makeupOverride.trim() || undefined,
      tags,
      characterId: assignToChar ? characterId : null,
    };

    if (isEdit) {
      await outfitApi.update(outfit.id, payload);
      notify('Outfit updated', 'success');
    } else {
      await outfitApi.create(payload);
      notify('Outfit created', 'success');
    }
    onSaved();
  });

  const canSave = name.trim() && top.trim() && bottom.trim() && accessories.trim() && footwear.trim();

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit Outfit' : 'New Outfit'}>
      <div className="space-y-4">
        <Input label="Outfit Name" required placeholder="e.g. Casual Summer" value={name} onChange={(e) => setName(e.target.value)} />

        {OUTFIT_FIELDS.map((f) => {
          const setters = { top: setTop, bottom: setBottom, footwear: setFootwear, accessories: setAccessories };
          const values = { top, bottom, footwear, accessories };
          return (
            <Input key={f.key} label={f.label} required placeholder={f.placeholder}
              value={values[f.key]} onChange={(e) => setters[f.key](e.target.value)} />
          );
        })}

        <Input label="Hairstyle Override" placeholder="Leave empty to keep character default"
          value={hairstyleOverride} onChange={(e) => setHairstyleOverride(e.target.value)} />

        <Input label="Makeup Override" placeholder="Leave empty to keep character default"
          value={makeupOverride} onChange={(e) => setMakeupOverride(e.target.value)} />

        <div>
          <span className="text-sm text-zinc-400 font-medium block mb-1.5">Tags</span>
          <div className="flex flex-wrap gap-2">
            {TAG_PRESETS.map((tag) => (
              <button key={tag} type="button" onClick={() => toggleTag(tag)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition cursor-pointer ${tags.includes(tag) ? 'bg-rose-600 text-white' : 'bg-zinc-700/60 text-zinc-300 hover:bg-zinc-700'}`}>
                {tag}
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-2.5 cursor-pointer select-none text-sm">
          <input type="checkbox" checked={assignToChar} onChange={(e) => setAssignToChar(e.target.checked)}
            className="rounded border-zinc-600 bg-zinc-800 text-rose-600 focus:ring-rose-500/30" />
          <span className="text-zinc-400">Assign to this character</span>
        </label>

        <Btn onClick={handleSave} disabled={loading || !canSave} className="w-full">
          {loading ? <Spinner size={16} /> : null} {isEdit ? 'Save Changes' : 'Create Outfit'}
        </Btn>
      </div>
    </Modal>
  );
}
