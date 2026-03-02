import { useEffect, useRef, useCallback, useState } from 'react';
import { batch as batchApi } from '../services/api';

const MAX_SSE_ERRORS = 3;
const POLL_INTERVAL_MS = 3000;

export function useBatchProgress() {
  const [job, setJob] = useState(null);
  const esRef = useRef(null);
  const pollingRef = useRef(null);
  const errorCountRef = useRef(0);
  const jobIdRef = useRef(null);

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

  const startPollingFallback = useCallback((jid) => {
    if (pollingRef.current) return;

    async function tick() {
      if (jobIdRef.current !== jid) return;
      try {
        const result = await batchApi.get(jid);
        if (jobIdRef.current !== jid) return;
        setJob(result);
        if (result?.status === 'completed' || result?.status === 'failed' || result?.status === 'cancelled') {
          pollingRef.current = null;
          return;
        }
      } catch (err) {
        if (err?.status === 404) { pollingRef.current = null; return; }
      }
      if (jobIdRef.current === jid) {
        pollingRef.current = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
    tick();
  }, []);

  const subscribe = useCallback((jid) => {
    cleanup();
    jobIdRef.current = jid;

    if (!jid) {
      setJob(null);
      return;
    }

    try {
      const es = batchApi.progress(jid);
      esRef.current = es;

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          errorCountRef.current = 0;

          if (data.event === 'snapshot') {
            const { event: _, ...jobData } = data;
            setJob(jobData);
          } else if (data.event === 'task') {
            setJob((prev) => prev ? { ...prev, completed: data.completed, failed: data.failed } : prev);
            batchApi.get(jid).then((full) => {
              if (jobIdRef.current === jid) setJob(full);
            }).catch(() => {});
          } else if (data.event === 'done') {
            batchApi.get(jid).then((full) => {
              if (jobIdRef.current === jid) setJob(full);
            }).catch(() => {
              setJob((prev) => prev ? { ...prev, status: data.status, completed: data.completed, failed: data.failed } : prev);
            });
            if (esRef.current) {
              esRef.current.close();
              esRef.current = null;
            }
          }
        } catch {
          errorCountRef.current++;
          if (errorCountRef.current >= MAX_SSE_ERRORS) {
            if (esRef.current) {
              esRef.current.close();
              esRef.current = null;
            }
            startPollingFallback(jid);
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
          startPollingFallback(jid);
        }
      };
    } catch {
      startPollingFallback(jid);
    }
  }, [cleanup, startPollingFallback]);

  useEffect(() => {
    return () => {
      cleanup();
      jobIdRef.current = null;
    };
  }, [cleanup]);

  return { job, setJob, subscribe, cleanup };
}
