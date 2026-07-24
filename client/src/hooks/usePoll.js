import { useEffect, useRef, useCallback, useState } from 'react';

export function usePoll(fetchFn, intervalMs = 3000) {
  const [data, setData] = useState(null);
  const [active, setActive] = useState(false);
  const timerRef = useRef(null);
  const fnRef = useRef(fetchFn);
  const activeRef = useRef(false);
  const failCountRef = useRef(0);

  useEffect(() => { fnRef.current = fetchFn; });
  useEffect(() => { activeRef.current = active; });

  const stop = useCallback(() => {
    setActive(false);
    activeRef.current = false;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const start = useCallback(() => {
    failCountRef.current = 0;
    setData(null);
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
        failCountRef.current = 0;
        setData(result);
        if (result?.status === 'completed' || result?.status === 'failed' || result?.status === 'cancelled') {
          setActive(false);
          activeRef.current = false;
          return;
        }
      } catch {
        failCountRef.current += 1;
        if (failCountRef.current >= 30) {
          setActive(false);
          activeRef.current = false;
          return;
        }
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

  useEffect(() => {
    return () => {
      activeRef.current = false;
      clearTimeout(timerRef.current);
    };
  }, []);

  return { data, active, start, stop, setData };
}
