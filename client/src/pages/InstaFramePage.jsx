import { useState } from 'react';
import { Card, Btn, Spinner } from '../components/UI';
import { useApp } from '../context/AppContext';

export default function InstaFramePage() {
  const { notify, navigateTo } = useApp();
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  async function handleExtract() {
    const clean = url.trim();
    if (!clean) return;
    setLoading(true);
    setResult(null);
    try {
      const r = await fetch('/api/insta-frame', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: clean }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || d.message || 'Failed');
      setResult(d.data);
      notify('First frame extracted!', 'success');
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  function handleDownload() {
    if (!result) return;
    const a = document.createElement('a');
    a.href = `data:${result.mimeType};base64,${result.imageBase64}`;
    a.download = result.filename || 'insta_frame.jpg';
    a.click();
  }

  function handleSendToScene() {
    if (!result) return;
    navigateTo('scene', { frameBase64: result.imageBase64, frameMime: result.mimeType });
    notify('Frame sent to Scene Recreate', 'success');
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Instagram Frame Extractor</h1>
        <p className="text-sm text-zinc-500 mt-1">Paste a Reel URL — get the first frame as an image</p>
      </div>

      <Card className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">Instagram Reel URL</label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.instagram.com/reel/..."
            className="w-full rounded-lg border border-zinc-700/60 bg-zinc-800/60 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/30"
            onKeyDown={(e) => e.key === 'Enter' && handleExtract()}
          />
          <p className="text-[11px] text-zinc-600 mt-1">Requires Apify key — must be a public reel</p>
        </div>

        <Btn onClick={handleExtract} disabled={loading || !url.trim()} variant="primary" className="w-full">
          {loading ? <><Spinner size={16} className="mr-2" />Extracting…</> : 'Extract First Frame'}
        </Btn>
      </Card>

      {result && (
        <Card className="space-y-4">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Result</p>
          <img
            src={`data:${result.mimeType};base64,${result.imageBase64}`}
            alt="First frame"
            className="w-full rounded-lg border border-zinc-700/40 object-contain max-h-96"
          />
          <div className="flex gap-2">
            <Btn onClick={handleDownload} variant="secondary" size="sm" className="flex-1">
              Download JPG
            </Btn>
            <Btn onClick={handleSendToScene} variant="secondary" size="sm" className="flex-1">
              Send to Scene Recreate
            </Btn>
          </div>
        </Card>
      )}
    </div>
  );
}
