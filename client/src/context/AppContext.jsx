import { createContext, useContext, useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { characters as charApi } from '../services/api';

const AppContext = createContext(null);

const VALID_PAGE_IDS = new Set(['generate', 'batch', 'auto', 'carousel', 'scene', 'reel', 'postClone', 'styleLibrary', 'promptBuilder', 'profileAnalyzer', 'storyteller', 'gallery', 'characters', 'keys']);

function pageFromPathname(pathname) {
  const segment = (pathname || '/').replace(/^\/+|\/+$/g, '') || 'generate';
  return VALID_PAGE_IDS.has(segment) ? segment : 'generate';
}

function pathnameFromPage(pageId) {
  return pageId === 'generate' ? '/' : `/${pageId}`;
}

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

  const [page, setPage] = useState(() => pageFromPathname(typeof window !== 'undefined' ? window.location.pathname : '/'));
  const [pageParams, setPageParams] = useState({});
  const navigateTo = useCallback((pageId, params = {}) => {
    const id = VALID_PAGE_IDS.has(pageId) ? pageId : 'generate';
    setPage(id);
    setPageParams(params);
    if (typeof window !== 'undefined') {
      const path = pathnameFromPage(id);
      if (window.location.pathname !== path) {
        window.history.pushState(null, '', path);
      }
    }
  }, []);
  const consumePageParams = useCallback(() => {
    const p = pageParams;
    if (Object.keys(p).length > 0) setPageParams({});
    return p;
  }, [pageParams]);

  const [characters, setCharacters] = useState([]);
  const [sceneMemories, setSceneMemories] = useState([]);
  const [outfits, setOutfits] = useState([]);

  useEffect(() => {
    const onPopState = () => setPage(pageFromPathname(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    charApi.list().then(setCharacters).catch(() => setCharacters([]));
    fetchJson('/api/scene-memory').then(setSceneMemories).catch(() => setSceneMemories([]));
    fetchJson('/api/outfits').then(setOutfits).catch(() => setOutfits([]));
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

  useEffect(() => {
    const t = timers;
    return () => { for (const id of Object.keys(t.current)) clearTimeout(t.current[id]); };
  }, []);

  const value = useMemo(() => ({
    activeKey, setActiveKey, toasts, notify, dismissToast,
    page, navigateTo, consumePageParams,
    characters, refreshCharacters,
    sceneMemories, refreshSceneMemories,
    outfits, refreshOutfits,
  }), [activeKey, setActiveKey, toasts, notify, dismissToast,
    page, navigateTo, consumePageParams,
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
