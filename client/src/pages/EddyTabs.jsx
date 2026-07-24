import { useState } from 'react';
import { Card, Btn, Spinner } from '../components/UI';
import { useApp } from '../context/AppContext';
import { gallery as galleryApi } from '../services/api';
import { createEddyCollection } from '../lib/eddyCollectionStore';
import EddyCollection from '../components/EddyCollection';
import EddySheetImport from '../components/EddySheetImport';

/**
 * Eddy's four collection tabs. Each is the same engine pointed at its OWN IndexedDB database —
 * Eddy's images never mix with the main gallery, and the four tabs never see each other.
 */


/**
 * Pulls Eddy-tagged pictures out of the main gallery into Eddy's Library.
 *
 * A generation is saved server side even if the browser reloads mid-request, but it is the
 * browser that files it here — so a refresh leaves the picture safe yet missing from Eddy.
 * This finds those and files them by the character tag they were generated under.
 */
function RecoverFromGallery({ onDone }) {
  const { notify } = useApp();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const store = createEddyCollection('eddy-library');
      const res = await galleryApi.list();
      const all = Array.isArray(res) ? res : (res?.images || res?.gallery || []);
      const mine = all.filter((g) => (g.tags || []).includes('eddy'));

      // Existing entries point at /gallery/<id>/image, so the id in the URL is the dedupe key.
      const have = new Set((await store.listItems()).map((i) => (i.url || '').split('/gallery/')[1]?.split('/')[0]).filter(Boolean));
      const missing = mine.filter((g) => !have.has(g.id));
      if (!missing.length) { notify('Nothing missing — Library is up to date', 'success'); return; }

      for (const g of missing) {
        const character = (g.tags || []).find((t) => t !== 'eddy' && t !== 'seedream-5-pro-edit' && t !== 'wavespeed' && t !== 'muapi');
        const folderId = character ? (await store.ensureFolder(character))?.id : null;
        await store.addItems([{ url: galleryApi.imageUrl(g.id), prompt: g.prompt || '', name: `${character || 'eddy'}-${g.id}` }], folderId);
      }
      notify(`Recovered ${missing.length} image${missing.length === 1 ? '' : 's'}`, 'success');
      onDone?.();
    } catch (err) {
      notify(err.message || 'Could not read the gallery', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">
          Reloaded while something was generating? The picture is still saved — pull it in here.
        </p>
        <Btn variant="secondary" className="!rounded-lg !py-2 !px-4 !text-sm" onClick={run} disabled={busy}>
          {busy ? <><Spinner size={14} /><span className="ml-2">Checking…</span></> : 'Recover missing'}
        </Btn>
      </div>
    </Card>
  );
}

export function EddyLibraryPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div className="w-full space-y-4">
      <RecoverFromGallery onDone={() => setRefreshKey((k) => k + 1)} />
      <EddyCollection
        dbName="eddy-library"
        title="Eddy · Library"
        subtitle="Eddy's own images, and everything Eddy generates."
        refreshKey={refreshKey}
      />
    </div>
  );
}

export function EddyOutfitPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div className="w-full space-y-4">
      <EddySheetImport dbName="eddy-outfit" label="outfits" onImported={() => setRefreshKey((k) => k + 1)} />
      <EddyCollection
        dbName="eddy-outfit"
        title="Eddy · Outfit"
        subtitle="Write the outfit as a prompt. Drop an image with it if you want an example to look at."
        promptLabel="outfit"
      describeKind="outfit"
        withPrompt
            refreshKey={refreshKey}
      />
    </div>
  );
}

export function EddyPosePage() {
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div className="w-full space-y-4">
      <EddySheetImport dbName="eddy-pose" label="poses" onImported={() => setRefreshKey((k) => k + 1)} />
      <EddyCollection
        dbName="eddy-pose"
        title="Eddy · Pose"
        subtitle="Write the pose as a prompt. Faces in pose images are blurred automatically — Seedream copies any face it is shown."
        promptLabel="pose"
      autoBlur
        describeKind="pose"
        withPrompt
        withVideoPrompt
            refreshKey={refreshKey}
      />
    </div>
  );
}

export function EddyEnvironmentPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div className="w-full space-y-4">
      <EddySheetImport dbName="eddy-environment" label="environments" onImported={() => setRefreshKey((k) => k + 1)} />
      <EddyCollection
        dbName="eddy-environment"
        title="Eddy · Environment"
        subtitle="The place a shot happens in. Write it as a prompt, or drop a photo of the location — unlike a pose, the image itself is sent, so the room comes back as it looks."
        promptLabel="environment"
        describeKind="environment"
        withPrompt
        refreshKey={refreshKey}
      />
    </div>
  );
}

/**
 * Video prompts, each with the reference image the clip starts from.
 *
 * Deliberately an IMAGE collection, not a clip store: what gets kept here is the still that
 * seeds a video plus the prompt describing the motion — which is exactly how the source sheets
 * are laid out (one image per row, two or three prompt variations beside it).
 *
 * No auto-blur: unlike a pose, this image IS the subject of the shot, so removing the face
 * would defeat the point.
 */
export function VideoLibraryPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div className="w-full space-y-4">
      <EddySheetImport dbName="eddy-video" label="video prompts" onImported={() => setRefreshKey((k) => k + 1)} />
      <EddyCollection
        dbName="eddy-video"
        title="Video Library"
        subtitle="The reference image plus the video prompt that goes with it. A sheet row with several prompt variations imports as one card per variation, all sharing the row's image."
        promptLabel="video prompt"
        withPrompt
        refreshKey={refreshKey}
      />
    </div>
  );
}
