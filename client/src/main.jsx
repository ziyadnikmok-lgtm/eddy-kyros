import { createRoot } from 'react-dom/client';
import { AppProvider } from './context/AppContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import App from './App';
import { startBackgroundQueues } from './lib/queueEngine';
import { getWorkspace, applyWorkspace } from './lib/workspace';
import './index.css';

// Paint the saved workspace's theme BEFORE React mounts, otherwise the app flashes the default
// (Eddy pink) for a frame and then repaints — visible on every launch.
applyWorkspace(getWorkspace());

// Keep generation queues (Photo Match / Pose Remix / Scene) processing + auto-retrying
// even when you navigate away from their page.
startBackgroundQueues();

// After a rebuild, an already-open window holds a stale index that references
// code-split chunk hashes which no longer exist on disk. Navigating to a lazy page
// then 404s the chunk and renders blank. Reload once (guarded against loops) to pull
// the current asset hashes instead.
function handleStaleChunk(event) {
  try {
    if (event?.preventDefault) event.preventDefault();
    const KEY = 'kyros_chunk_reload_at';
    const last = Number(window.sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last > 10000) {
      window.sessionStorage.setItem(KEY, String(Date.now()));
      window.location.reload();
    }
  } catch { /* ignore */ }
}
// Vite fires this when a dynamic import (lazy page chunk) fails to load.
window.addEventListener('vite:preloadError', handleStaleChunk);
// Belt-and-suspenders: catch the same failure surfaced as a rejected import.
window.addEventListener('unhandledrejection', (e) => {
  const msg = String(e?.reason?.message || e?.reason || '');
  if (/Failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i.test(msg)) {
    handleStaleChunk(e);
  }
});

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <AppProvider>
      <App />
    </AppProvider>
  </ErrorBoundary>
);
