import { useState, useEffect, useRef } from 'react';
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
  // Guards the automatic sweep below: StrictMode mounts twice in dev, and two sweeps racing each
  // other would both read the same "have" set and file every missing picture twice.
  const sweptRef = useRef(false);

  // `quiet` = the automatic sweep on mount. It says nothing when there was nothing to do, because a
  // toast on every single visit to the Library is noise; a recovery that DID something still speaks.
  const run = async ({ quiet = false } = {}) => {
    setBusy(true);
    try {
      const store = createEddyCollection('eddy-library');
      const res = await galleryApi.list();
      const all = Array.isArray(res) ? res : (res?.images || res?.gallery || []);
      const mine = all.filter((g) => (g.tags || []).includes('eddy'));

      // Existing entries point at /gallery/<id>/image, so the id in the URL is the dedupe key.
      const have = new Set((await store.listItems()).map((i) => (i.url || '').split('/gallery/')[1]?.split('/')[0]).filter(Boolean));
      const missing = mine.filter((g) => !have.has(g.id));
      if (!missing.length) { if (!quiet) notify('Nothing missing — Library is up to date', 'success'); return; }

      // Tags the server always writes; anything left is the caller's own marker, not a character.
      const ENGINE_TAGS = new Set(['seedream-5-pro-edit', 'nano-banana-2', 'wavespeed', 'muapi']);
      const ROUTE_TAGS = new Set(['eddy', 'edit', 'base', 'pose', 'plate', 'fallback']);
      for (const g of missing) {
        const tags = g.tags || [];
        const character = tags.find((t) => !ENGINE_TAGS.has(t) && !ROUTE_TAGS.has(t));
        /**
         * Filed the SAME WAY a live run files it, or recovery just moves the problem.
         *
         * Two things were wrong here. It passed folderId=null when no character could be read --
         * and a null folderId is not "unsorted", it is invisible: the item shows under "All" and in
         * no folder at all, which is how 89 pictures went missing on 2026-08-09. And it filed the
         * character flat, while a live run nests the engine under her, so a recovered picture landed
         * beside her folder instead of inside it and still read as missing.
         */
        /**
         * Filed the SAME WAY a live run files it, or recovery just moves the problem.
         *
         * It used to pass folderId=null when no character could be read -- and null is not
         * "unsorted", it is invisible: the item shows under "All" and in no folder at all, which is
         * how 89 pictures went missing on 2026-08-09.
         */
        const folderId = character ? (await store.ensureFolder(character))?.id : null;
        // The floor. Never null: "in the wrong folder" is recoverable by dragging, "nowhere" is not.
        const dest = folderId || (await store.ensureFolder('Eddy'))?.id || null;
        await store.addItems([{ url: galleryApi.imageUrl(g.id), prompt: g.prompt || '', name: `${character || 'eddy'}-${g.id}` }], dest);
      }
      notify(`Recovered ${missing.length} image${missing.length === 1 ? '' : 's'}`, 'success');
      onDone?.();
    } catch (err) {
      if (!quiet) notify(err.message || 'Could not read the gallery', 'error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * RUNS ON ITS OWN, every time the Library opens.
   *
   * Filing happens in the BROWSER: the server saves and bills a generation whether or not the tab
   * survives, so a reload, a crash or a closed window mid-batch leaves the picture safe on disk and
   * missing from Eddy. Until now the only cure was remembering to press a button — which is why
   * pictures kept "not going to the Library" (audit, 2026-08-09).
   *
   * Safe to run unattended: it dedupes on the gallery id already in each row's URL, so a picture
   * that IS filed is never filed twice, and it only ever adds.
   */
  useEffect(() => {
    if (sweptRef.current) return;
    sweptRef.current = true;
    run({ quiet: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount, by design
  }, []);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">
          Reloaded while something was generating? The picture is still saved — pull it in here.
        </p>
        <Btn variant="secondary" className="!rounded-lg !py-2 !px-4 !text-sm" onClick={() => run()} disabled={busy}>
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
        enablePlate
        withPrompt
        withVideoPrompt
            refreshKey={refreshKey}
      />
    </div>
  );
}

/**
 * Base Library — where Base puts what it generates, and the only place the Generate page's
 * "Main photo" slot needs to look. Kept separate from Eddy · Library (which is every result the
 * page has ever produced) so a base photo is never lost in a pile of finished shots.
 */
export function EddyBaseLibraryPage() {
  return (
    <div className="w-full space-y-4">
      <EddyCollection
        dbName="eddy-base"
        title="Eddy · Base Library"
        subtitle="Base photos, filed by character. Generated in the Base tab, and picked from here as the Main photo on Generate."
        promptLabel="base"
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
