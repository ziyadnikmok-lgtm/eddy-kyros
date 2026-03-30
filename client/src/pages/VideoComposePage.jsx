import { useState, useRef } from 'react';
import { Card, Btn, Spinner } from '../components/UI';
import { useApp } from '../context/AppContext';

function DropZone({ label, accept, file, onFile, hint }) {
  const inputRef = useRef();
  const [dragging, setDragging] = useState(false);

  function handleDrop(e) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onFile(f);
  }

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={`relative flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 cursor-pointer transition-colors ${
        dragging ? 'border-blue-500/60 bg-blue-500/5' : file ? 'border-zinc-600/60 bg-zinc-800/40' : 'border-zinc-700/50 hover:border-zinc-600/60 bg-zinc-800/20 hover:bg-zinc-800/40'
      }`}
    >
      <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      {file ? (
        <>
          <span className="text-2xl">{accept.includes('video') ? '🎬' : '🎵'}</span>
          <p className="text-sm text-zinc-300 font-medium text-center">{file.name}</p>
          <p className="text-xs text-zinc-500">{(file.size / 1024 / 1024).toFixed(1)} MB — click to replace</p>
        </>
      ) : (
        <>
          <span className="text-3xl opacity-40">{accept.includes('video') ? '🎬' : '🎵'}</span>
          <p className="text-sm font-medium text-zinc-400">{label}</p>
          {hint && <p className="text-xs text-zinc-600 text-center">{hint}</p>}
        </>
      )}
    </div>
  );
}

const TEXT_POSITIONS = [
  { id: 'top', label: 'Top' },
  { id: 'center', label: 'Center' },
  { id: 'bottom', label: 'Bottom' },
];

export default function VideoComposePage() {
  const { notify } = useApp();
  const [videoFile, setVideoFile] = useState(null);
  const [audioFile, setAudioFile] = useState(null);
  const [text, setText] = useState('');
  const [textPosition, setTextPosition] = useState('bottom');
  const [fontSize, setFontSize] = useState(64);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  async function handleCompose() {
    if (!videoFile) { notify('Drop a video first', 'error'); return; }
    setLoading(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('video', videoFile);
      if (audioFile) fd.append('audio', audioFile);
      if (text) fd.append('text', text);
      fd.append('textPosition', textPosition);
      fd.append('fontSize', String(fontSize));

      const r = await fetch('/api/video-compose', {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || d.message || 'Failed');
      setResult(d.data);
      notify('Video composed!', 'success');
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  function handleDownload() {
    if (!result) return;
    const a = document.createElement('a');
    a.href = `data:${result.mimeType};base64,${result.videoBase64}`;
    a.download = result.filename || 'composed_video.mp4';
    a.click();
  }

  const canCompose = videoFile && (audioFile || text.trim());

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Video Composer</h1>
        <p className="text-sm text-zinc-500 mt-1">Drop a video — add audio and/or text overlay</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <p className="text-xs font-medium text-zinc-400 mb-2">Video <span className="text-red-400">*</span></p>
          <DropZone
            label="Drop video here"
            accept="video/*"
            file={videoFile}
            onFile={setVideoFile}
            hint="MP4, MOV, WebM"
          />
        </div>
        <div>
          <p className="text-xs font-medium text-zinc-400 mb-2">Audio <span className="text-zinc-600">(optional)</span></p>
          <DropZone
            label="Drop audio here"
            accept="audio/*"
            file={audioFile}
            onFile={setAudioFile}
            hint="MP3, WAV, M4A — replaces original audio"
          />
          {audioFile && (
            <button onClick={() => setAudioFile(null)} className="mt-1 text-xs text-zinc-600 hover:text-zinc-400 transition">
              Remove audio
            </button>
          )}
        </div>
      </div>

      <Card className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">Text Overlay <span className="text-zinc-600">(optional)</span></label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Caption or text to burn into video…"
            rows={3}
            className="w-full rounded-lg border border-zinc-700/60 bg-zinc-800/60 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/30 resize-none"
          />
        </div>

        {text && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Position</label>
              <div className="flex gap-1.5">
                {TEXT_POSITIONS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setTextPosition(p.id)}
                    className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${
                      textPosition === p.id
                        ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
                        : 'border-zinc-700/60 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Font Size — {fontSize}px</label>
              <input
                type="range"
                min={16}
                max={120}
                step={4}
                value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))}
                className="w-full accent-blue-500"
              />
            </div>
          </div>
        )}

        <Btn onClick={handleCompose} disabled={loading || !canCompose} variant="primary" className="w-full">
          {loading ? <><Spinner size={16} className="mr-2" />Composing…</> : 'Compose Video'}
        </Btn>

        {!canCompose && !loading && (
          <p className="text-xs text-zinc-600 text-center">Add a video + at least audio or text to compose</p>
        )}
      </Card>

      {result && (
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Output</p>
            <span className="text-xs text-zinc-600">{result.sizeKB ? `${(result.sizeKB / 1024).toFixed(1)} MB` : ''}</span>
          </div>
          <video
            src={`data:${result.mimeType};base64,${result.videoBase64}`}
            controls
            className="w-full rounded-lg border border-zinc-700/40 max-h-80"
          />
          <Btn onClick={handleDownload} variant="secondary" className="w-full">
            Download MP4
          </Btn>
        </Card>
      )}
    </div>
  );
}
