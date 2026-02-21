import { useState, useEffect } from 'react';
import { characters as charApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { useAsync } from '../hooks/useAsync';
import { Card, Btn, Input, Textarea, Modal, Badge, Spinner, Empty, ConfirmDialog } from '../components/UI';

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
          <h1 className="text-3xl font-bold tracking-tight text-gradient">Characters</h1>
          <p className="text-zinc-500 text-sm mt-1">Identity-locked character profiles with reference images.</p>
        </div>
        <Btn onClick={() => setShowCreate(true)}>+ New Character</Btn>
      </div>

      {chars.length === 0 ? (
        <Empty icon="🧑‍🎨" title="No characters yet" subtitle="Create your first identity-locked character" />
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

  return (
    <Card className="animate-in space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold">{char.name}</h2>
          <p className="text-xs text-zinc-500 mt-0.5 max-w-md line-clamp-2">{char.masterPrompt}</p>
        </div>
        <div className="flex gap-2">
          <Btn variant="secondary" className="!text-xs !py-1.5" onClick={onAddRef}>+ Reference</Btn>
          <Btn variant="danger" className="!text-xs !py-1.5" onClick={() => setConfirmDelete({ type: 'character' })} disabled={loading}>Delete</Btn>
        </div>
      </div>
      {char.references?.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {char.references.map((r) => (
            <div key={r.id} className={`rounded-lg border p-2 transition ${r.isActive ? 'border-blue-500/50 bg-blue-500/5' : 'border-zinc-700/40'}`}>
              <div className="flex items-center justify-between mb-1.5">
                <Badge color={r.isActive ? 'blue' : 'zinc'}>{r.category}</Badge>
                <div className="flex gap-1">
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
          else if (confirmDelete?.type === 'reference') deleteRef(confirmDelete.id);
        }}
        title={confirmDelete?.type === 'character' ? `Delete "${char.name}"?` : `Remove ${confirmDelete?.label || ''} reference?`}
        message={confirmDelete?.type === 'character'
          ? 'This will permanently delete the character and all its references. This cannot be undone.'
          : 'This will remove the reference image from this character.'}
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
    if (f) { setFile(f); setPreview(URL.createObjectURL(f)); }
  };

  const handleCreate = () => run(async () => {
    if (!name.trim()) { notify('Character name is required', 'error'); return; }
    if (!masterPrompt.trim()) { notify('Master prompt is required — describe face, body, and defining traits', 'error'); return; }
    if (!file) { notify('Primary image is required — upload a clear reference photo', 'error'); return; }
    const dataUri = await fileToBase64(file);
    await charApi.create({ name: name.trim(), masterPrompt: masterPrompt.trim(), image: dataUri });
    notify('Character created', 'success');
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
                <div className="text-2xl mb-1">📸</div>
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
              <div className="text-lg mb-0.5">🖼️</div>
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
