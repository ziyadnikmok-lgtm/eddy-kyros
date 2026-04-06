import { useEffect, useRef, useCallback, useState } from 'react';
import { loraDatasets as loraApi } from '../services/api';
const MAX_SSE_ERRORS = 3;
const POLL_INTERVAL_MS = 3000;
export function useLoraDatasetProgress() {
  const [dataset, setDataset] = useState(null);
  const esRef = useRef(null);
  const pollingRef = useRef(null);
  const errorCountRef = useRef(0);
  const idRef = useRef(null);
  const cleanup = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (pollingRef.current) {
      clearTimeout(pollingRef.current);
      pollingRef.current = null;
    }
    errorCountRef.current = 0;
  }, []);
  const startPollingFallback = useCallback((id) => {
    if (pollingRef.current) return;
    async function tick() {
      if (idRef.current !== id) return;
      try {
        const result = await loraApi.get(id);
        if (idRef.current !== id) return;
        setDataset(result);
        if (result?.status !== 'running') {
          pollingRef.current = null;
          return;
        }
      } catch (err) {
        if (err?.status === 404) { pollingRef.current = null; return; }
      }
      if (idRef.current === id) {
        pollingRef.current = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
    tick();
  }, []);
  const subscribe = useCallback((id) => {
    cleanup();
    idRef.current = id;
    if (!id) {
      setDataset(null);
      return;
    }
    try {
      const es = loraApi.progress(id);
      esRef.current = es;
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          errorCountRef.current = 0;
          if (data.event === 'snapshot' || data.event === 'update' || data.event === 'done') {
            const { event: _event, ...payload } = data;
            setDataset(payload);
          }
          if (data.event === 'done' && esRef.current) {
            esRef.current.close();
            esRef.current = null;
          }
        } catch {
          errorCountRef.current++;
          if (errorCountRef.current >= MAX_SSE_ERRORS) {
            if (esRef.current) {
              esRef.current.close();
              esRef.current = null;
            }
            startPollingFallback(id);
          }
        }
      };
      es.onerror = () => {
        errorCountRef.current++;
        if (errorCountRef.current >= MAX_SSE_ERRORS) {
          if (esRef.current) {
            esRef.current.close();
            esRef.current = null;
          }
          startPollingFallback(id);
        }
      };
    } catch {
      startPollingFallback(id);
    }
  }, [cleanup, startPollingFallback]);
  useEffect(() => () => {
    cleanup();
    idRef.current = null;
  }, [cleanup]);
  return { dataset, setDataset, subscribe, cleanup };
}
