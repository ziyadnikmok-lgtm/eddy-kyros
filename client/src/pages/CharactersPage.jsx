import { useState, useEffect } from 'react';
import { characters as charApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { useAsync } from '../hooks/useAsync';
import { Card, Btn, Input, Textarea, Modal, Badge, Spinner, Empty, ConfirmDialog } from '../components/UI';
import { IconUsers, IconCamera, IconImage } from 'nucleo-glass';

const CATEGORIES = ['Clothing', 'Hairstyle', 'Pose', 'Accessory', 'Expression', 'Lighting', 'Custom'];

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

export default function CharactersPage() {
  const { notify, characters: chars, refreshCharacters } = useApp();
  const [selected, setSelected] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showAddRef, setShowAddRef] = useState(false);
  const { loading, run } = useAsync();

  const load = refreshCharacters;

  const selectChar = async (id) => {
    const data = await run(() => charApi.get(id));
    if (data) setSelected(data);
  };

  return (
    <div className="space-y-6 animate-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-gradient">Characters</h1>
          <p className="text-zinc-500 text-sm mt-1">Identity-locked character profiles with reference images.</p>
        </div>
        <Btn onClick={() => setShowCreate(true)}>+ New Character</Btn>
      </div>

      {chars.length === 0 ? (
        <Empty icon={<IconUsers uniqueId="empty-characters" size={40} aria-hidden />} title="No characters yet" subtitle="Create your first identity-locked character" />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {chars.map((c) => (
            <Card key={c.id} className={`cursor-pointer hover:border-zinc-600 transition-all !p-3 ${selected?.id === c.id ? '!border-blue-500 ring-1 ring-blue-500/20' : ''}`}
              onClick={() => selectChar(c.id)}>
              <div className="aspect-square rounded-lg overflow-hidden bg-zinc-900 mb-3">
                {c.hasPrimaryImage && <img src={charApi.imageUrl(c.id)} alt={c.name} className="w-full h-full object-cover" loading="lazy" />}
              </div>
              <div className="text-sm font-medium text-zinc-200 truncate">{c.name}</div>
              <div className="text-xs text-zinc-500 mt-0.5">{c.references?.length || 0} references</div>
            </Card>
          ))}
        </div>
      )}

      {selected && (
        <CharacterDetail char={selected} onUpdate={() => { load(); selectChar(selected.id); }} onDelete={() => { setSelected(null); load(); }}
          onAddRef={() => setShowAddRef(true)} />
      )}

      <CreateCharacterModal open={showCreate} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />
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

  const addPrimaryImage = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    run(async () => {
      const dataUri = await fileToBase64(f);
      await charApi.addPrimaryImage(char.id, { image: dataUri });
      notify('Primary image added', 'success');
      onUpdate();
    });
  };
  const removePrimaryImage = (index) => run(async () => {
    await charApi.removePrimaryImage(char.id, index);
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
  const downloadImage = (url, name) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
  };

  const imgCount = char.primaryImageCount || 1;

  return (
    <Card className="animate-in space-y-4">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0 mr-3">
          <h2 className="text-lg font-semibold">{char.name}</h2>
          <p className="text-xs text-zinc-500 mt-0.5 max-w-md line-clamp-2">{char.masterPrompt}</p>
          <div className="flex gap-2 mt-2">
            <button onClick={copyPrompt} className="text-xs text-zinc-400 hover:text-blue-400 transition cursor-pointer">Copy Prompt</button>
            <button onClick={() => { setPromptDraft(char.masterPrompt); setEditingPrompt(true); }} className="text-xs text-zinc-400 hover:text-blue-400 transition cursor-pointer">Edit Prompt</button>
          </div>
        </div>
        <div className="flex gap-2">
          <Btn variant="secondary" className="!text-xs !py-1.5" onClick={onAddRef}>+ Reference</Btn>
          <Btn variant="danger" className="!text-xs !py-1.5" onClick={() => setConfirmDelete({ type: 'character' })} disabled={loading}>Delete</Btn>
        </div>
      </div>

      {/* Edit master prompt inline */}
      {editingPrompt && (
        <div className="space-y-2 p-3 rounded-lg border border-blue-500/30 bg-blue-500/5">
          <textarea value={promptDraft} onChange={(e) => setPromptDraft(e.target.value)}
            className="w-full bg-zinc-900/80 border border-zinc-700/60 rounded-lg p-3 text-sm text-zinc-200 min-h-[120px] focus:outline-none focus:ring-1 focus:ring-blue-500/50 resize-y" />
          <div className="flex gap-2 justify-end">
            <Btn variant="ghost" className="!text-xs !py-1.5" onClick={() => setEditingPrompt(false)}>Cancel</Btn>
            <Btn className="!text-xs !py-1.5" onClick={savePrompt} disabled={loading || !promptDraft.trim()}>
              {loading ? <Spinner size={14} /> : null} Save
            </Btn>
          </div>
        </div>
      )}

      {/* Primary reference images */}
      <div>
        <span className="text-sm text-zinc-400 font-medium block mb-2">Primary Images ({imgCount}/10)</span>
        <div className="flex gap-3 flex-wrap">
          {Array.from({ length: imgCount }, (_, i) => (
            <div key={i} className="relative group w-20 h-20 rounded-lg overflow-hidden bg-zinc-900 border border-zinc-700/40">
              <img src={charApi.primaryImageUrl(char.id, i)} alt={`Primary ${i + 1}`} className="w-full h-full object-cover" loading="lazy" />
              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition flex items-center justify-center gap-1">
                <button onClick={() => downloadImage(charApi.primaryImageUrl(char.id, i), `${char.name}-primary-${i + 1}.png`)}
                  className="w-6 h-6 rounded-full bg-black/70 text-blue-400 text-xs flex items-center justify-center cursor-pointer" title="Download">
                  ↓
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
            <label className="w-20 h-20 rounded-lg border-2 border-dashed border-zinc-700/60 hover:border-blue-500/40 flex items-center justify-center cursor-pointer transition">
              <span className="text-zinc-500 text-lg">+</span>
              <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={addPrimaryImage} />
            </label>
          )}
        </div>
      </div>

      {/* Style override references */}
      {char.references?.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {char.references.map((r) => (
            <div key={r.id} className={`rounded-lg border p-2 transition ${r.isActive ? 'border-blue-500/50 bg-blue-500/5' : 'border-zinc-700/40'}`}>
              <div className="flex items-center justify-between mb-1.5">
                <Badge color={r.isActive ? 'blue' : 'zinc'}>{r.category}</Badge>
                <div className="flex gap-1">
                  <button onClick={() => downloadImage(charApi.refImageUrl(char.id, r.id), `${char.name}-${r.category}.png`)}
                    className="text-xs text-zinc-500 hover:text-blue-400 cursor-pointer transition" title="Download image">↓</button>
                  <button onClick={() => toggleRef(r.id)} className={`text-xs px-1.5 py-0.5 rounded cursor-pointer transition ${r.isActive ? 'text-blue-400' : 'text-zinc-500 hover:text-zinc-300'}`}>
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

function CreateCharacterModal({ open, onClose, onCreated }) {
  const { notify } = useApp();
  const { loading, run } = useAsync();
  const [name, setName] = useState('');
  const [masterPrompt, setMasterPrompt] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);

  const handleFile = (e) => {
    const f = e.target.files?.[0];
    if (f) {
      if (preview) URL.revokeObjectURL(preview);
      setFile(f);
      setPreview(URL.createObjectURL(f));
    }
  };

  const handleCreate = () => run(async () => {
    if (!name.trim()) { notify('Character name is required', 'error'); return; }
    if (!masterPrompt.trim()) { notify('Master prompt is required — describe face, body, and defining traits', 'error'); return; }
    if (!file) { notify('Primary image is required — upload a clear reference photo', 'error'); return; }
    const dataUri = await fileToBase64(file);
    await charApi.create({ name: name.trim(), masterPrompt: masterPrompt.trim(), image: dataUri });
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
          <span className="text-sm text-zinc-400 font-medium block mb-1.5">Primary Image<span className="text-red-400 ml-0.5">*</span></span>
          <label className={`flex flex-col items-center justify-center border-2 border-dashed rounded-lg p-4 cursor-pointer transition h-32 ${preview ? 'border-blue-500/40 bg-blue-500/5' : 'border-zinc-700/80 hover:border-blue-500/30 bg-zinc-900/30'}`}>
            {preview ? <img src={preview} alt="" className="max-h-full rounded" /> : (
              <div className="text-center">
                <div className="flex justify-center mb-1 [--nc-gradient-1-color-1:currentColor] [--nc-gradient-1-color-2:currentColor] [--nc-gradient-2-color-1:currentColor] [--nc-gradient-2-color-2:currentColor] [--nc-light:currentColor]"><IconCamera uniqueId="char-primary-img" size={28} aria-hidden /></div>
                <span className="text-zinc-400 text-sm">Click to upload a clear reference photo</span>
              </div>
            )}
            <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleFile} />
          </label>
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

  const handleAdd = () => run(async () => {
    if (!file || !overridePrompt.trim()) { notify('Image and override prompt required', 'error'); return; }
    const dataUri = await fileToBase64(file);
    await charApi.addReference(characterId, { image: dataUri, mimeType: file.type, name: file.name, category, overridePrompt: overridePrompt.trim() });
    notify('Reference added', 'success');
    setOverridePrompt(''); setFile(null);
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
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition cursor-pointer ${category === c ? 'bg-blue-600 text-white' : 'bg-zinc-700/60 text-zinc-300 hover:bg-zinc-700'}`}>
                {c}
              </button>
            ))}
          </div>
        </div>
        <Textarea label="Override Prompt" required placeholder="Describe this style override..." value={overridePrompt} onChange={(e) => setOverridePrompt(e.target.value)} />
        <div>
          <span className="text-sm text-zinc-400 font-medium block mb-1.5">Reference Image<span className="text-red-400 ml-0.5">*</span></span>
        </div>
        <label className={`flex flex-col items-center justify-center border-2 border-dashed rounded-lg p-4 cursor-pointer transition h-24 ${file ? 'border-blue-500/40 bg-blue-500/5' : 'border-zinc-700/80 hover:border-blue-500/30 bg-zinc-900/30'}`}>
          {file ? (
            <span className="text-blue-300 text-sm truncate max-w-full px-2">{file.name}</span>
          ) : (
            <div className="text-center">
              <div className="flex justify-center mb-0.5 [--nc-gradient-1-color-1:currentColor] [--nc-gradient-1-color-2:currentColor] [--nc-gradient-2-color-1:currentColor] [--nc-gradient-2-color-2:currentColor] [--nc-light:currentColor]"><IconImage uniqueId="char-ref-img" size={20} aria-hidden /></div>
              <span className="text-zinc-400 text-sm">Click to upload reference image</span>
            </div>
          )}
          <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => setFile(e.target.files?.[0])} />
        </label>
        <Btn onClick={handleAdd} disabled={loading || !file || !overridePrompt.trim()} className="w-full">
          {loading ? <Spinner size={16} /> : null} Add Reference
        </Btn>
      </div>
    </Modal>
  );
}
