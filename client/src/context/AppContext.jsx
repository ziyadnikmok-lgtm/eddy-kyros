import { createContext, useContext, useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { characters as charApi } from '../services/api';

const AppContext = createContext(null);

let toastId = 0;

async function fetchJson(url) {
  const res = await fetch(url);
  const json = await res.json();
  return Array.isArray(json?.data) ? json.data : [];
}

export function AppProvider({ children }) {
  const [activeKey, setActiveKey] = useState(null);
  const [toasts, setToasts] = useState([]);
  const timers = useRef({});

  // Shared data — fetched once, consumed by all pages
  const [characters, setCharacters] = useState([]);
  const [sceneMemories, setSceneMemories] = useState([]);
  const [outfits, setOutfits] = useState([]);

  useEffect(() => {
    charApi.list().then(setCharacters).catch((err) => { console.warn('Bootstrap: characters fetch failed', err); setCharacters([]); });
    fetchJson('/api/scene-memory').then(setSceneMemories).catch((err) => { console.warn('Bootstrap: scene-memory fetch failed', err); setSceneMemories([]); });
    fetchJson('/api/outfits').then(setOutfits).catch((err) => { console.warn('Bootstrap: outfits fetch failed', err); setOutfits([]); });
  }, []);

  const refreshCharacters = useCallback(() => {
    charApi.list().then(setCharacters).catch(() => setCharacters([]));
  }, []);
  const refreshSceneMemories = useCallback(() => {
    fetchJson('/api/scene-memory').then(setSceneMemories).catch(() => setSceneMemories([]));
  }, []);
  const refreshOutfits = useCallback(() => {
    fetchJson('/api/outfits').then(setOutfits).catch(() => setOutfits([]));
  }, []);

  const notify = useCallback((message, type = 'info', duration = 4000) => {
    const id = ++toastId;
    setToasts((t) => [...t.slice(-4), { id, message, type }]);
    timers.current[id] = setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
      delete timers.current[id];
    }, duration);
    return id;
  }, []);

  const dismissToast = useCallback((id) => {
    clearTimeout(timers.current[id]);
    delete timers.current[id];
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  // Cleanup all toast timers on unmount
  useEffect(() => {
    const t = timers;
    return () => { for (const id of Object.keys(t.current)) clearTimeout(t.current[id]); };
  }, []);

  const value = useMemo(() => ({
    activeKey, setActiveKey, toasts, notify, dismissToast,
    characters, refreshCharacters,
    sceneMemories, refreshSceneMemories,
    outfits, refreshOutfits,
  }), [activeKey, setActiveKey, toasts, notify, dismissToast,
    characters, refreshCharacters, sceneMemories, refreshSceneMemories,
    outfits, refreshOutfits]);

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be inside AppProvider');
  return ctx;
}
