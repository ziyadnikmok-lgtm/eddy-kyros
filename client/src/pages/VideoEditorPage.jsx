import { useState, useEffect, useCallback } from 'react';
import { video as videoApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Spinner, Empty } from '../components/UI';
import VideoEditor from '../components/VideoEditor';

// The Video Editor as a first-class PAGE/tab (same shape as the Image Editor), not a modal.
// - Opened from a clip's "Edit" button, it arrives with { filename } in the page params and drops
//   straight into the editor.
// - Opened from the sidebar with nothing selected, it shows a picker of your gallery clips.
// Cancel / a finished export returns to the picker so you can edit another.
export default function VideoEditorPage() {
  const { notify, consumePageParams } = useApp();
  const [filename, setFilename] = useState(null);
  const [clips, setClips] = useState([]);
  const [loading, setLoading] = useState(false);

  // A clip handed in via navigateTo('videoEditor', { filename }) opens immediately.
  useEffect(() => {
    const params = consumePageParams();
    if (params?.filename) setFilename(params.filename);
  }, [consumePageParams]);

  const loadClips = useCallback(async () => {
    setLoading(true);
    try {
      const items = await videoApi.history();
      // Only completed clips with a LOCAL file can be edited (the server edits it in place-ish).
      setClips((items || []).filter((it) => it.status === 'completed' && it.filename));
    } catch {
      notify('Could not load your videos', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  // Load the picker list whenever no clip is open (initial, and after Cancel/export returns).
  useEffect(() => { if (!filename) loadClips(); }, [filename, loadClips]);

  if (filename) {
    return (
      <VideoEditor
        video={{ filename }}
        onClose={() => setFilename(null)}
        onSaved={() => { /* returning to the picker below reloads the list */ }}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">Video Editor</h1>
          <p className="text-sm text-zinc-500">Pick a clip to trim, add stickers &amp; text, and adjust — or hit Edit on any video.</p>
        </div>
        <button onClick={loadClips} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-1.5 text-xs text-zinc-300 hover:bg-white/[0.08] transition cursor-pointer">Refresh</button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-zinc-400"><Spinner size={18} /> <span className="ml-2">Loading your clips…</span></div>
        ) : clips.length === 0 ? (
          <Empty icon="video" title="No editable clips yet" subtitle="Generate a video and it will show up here to edit." />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {clips.map((c) => (
              <button
                key={c.id}
                onClick={() => setFilename(c.filename)}
                className="group relative aspect-[3/4] overflow-hidden rounded-xl border border-white/[0.06] bg-black hover:border-violet-500/60 transition"
                title={c.prompt || 'Edit this clip'}
              >
                <video
                  src={videoApi.fileUrl(c.filename)}
                  className="h-full w-full object-cover"
                  muted
                  playsInline
                  preload="metadata"
                  onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                  onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0; }}
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent opacity-0 group-hover:opacity-100 transition flex items-end justify-center pb-3">
                  <span className="rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 py-1.5 text-xs font-semibold text-white shadow-lg shadow-violet-500/30">Edit</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
