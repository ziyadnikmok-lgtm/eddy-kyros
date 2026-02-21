import { useEffect, useRef, useCallback, useState } from 'react';

export function usePoll(fetchFn, intervalMs = 3000) {
  const [data, setData] = useState(null);
  const [active, setActive] = useState(false);
  const timerRef = useRef(null);
  const fnRef = useRef(fetchFn);
  const activeRef = useRef(false);

  // Keep refs in sync to avoid stale closures in setTimeout
  useEffect(() => { fnRef.current = fetchFn; });
  useEffect(() => { activeRef.current = active; });

  const stop = useCallback(() => {
    setActive(false);
    activeRef.current = false;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const start = useCallback(() => {
    setActive(true);
    activeRef.current = true;
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    async function tick() {
      if (cancelled || !activeRef.current) return;
      try {
        const result = await fnRef.current();
        if (cancelled || !activeRef.current) return;
        setData(result);
        if (result?.status === 'completed' || result?.status === 'failed' || result?.status === 'cancelled') {
          setActive(false);
          activeRef.current = false;
          return;
        }
      } catch {
        // Swallow — poll retries on next tick
      }
      if (!cancelled && activeRef.current) {
        timerRef.current = setTimeout(tick, intervalMs);
      }
    }
    tick();

    return () => {
      cancelled = true;
      clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [active, intervalMs]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      activeRef.current = false;
      clearTimeout(timerRef.current);
    };
  }, []);

  return { data, active, start, stop, setData };
}
