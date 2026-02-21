import { useEffect, useRef, useCallback, useState } from 'react';
import { batch as batchApi } from '../services/api';

const MAX_SSE_ERRORS = 3;
const POLL_INTERVAL_MS = 3000;

/**
 * Hook that subscribes to real-time batch progress via SSE.
 * Falls back to polling if SSE errors out repeatedly.
 *
 * Usage:
 *   const { job, setJob, subscribe, cleanup } = useBatchProgress();
 *   // After starting a batch:
 *   subscribe(data.jobId);
 *   // On cancel or unmount:
 *   cleanup();
 */
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

  /** Polling fallback — used when SSE fails repeatedly. */
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
      } catch {
        // swallow — retry on next tick
      }
      if (jobIdRef.current === jid) {
        pollingRef.current = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
    tick();
  }, []);

  /** Open SSE connection for the given job. Cleans up any previous subscription first. */
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
            // Full job state — strip the synthetic 'event' field
            const { event: _, ...jobData } = data;
            setJob(jobData);
          } else if (data.event === 'task') {
            // Update progress counters instantly, then fetch full state for new images
            setJob((prev) => prev ? { ...prev, completed: data.completed, failed: data.failed } : prev);
            batchApi.get(jid).then((full) => {
              if (jobIdRef.current === jid) setJob(full);
            }).catch(() => {});
          } else if (data.event === 'done') {
            // Fetch final state with all results
            batchApi.get(jid).then((full) => {
              if (jobIdRef.current === jid) setJob(full);
            }).catch(() => {
              // At minimum update status from SSE data
              setJob((prev) => prev ? { ...prev, status: data.status, completed: data.completed, failed: data.failed } : prev);
            });
            if (esRef.current) {
              esRef.current.close();
              esRef.current = null;
            }
          }
        } catch {
          // Malformed SSE event — count toward error threshold so repeated
          // parse failures trigger the polling fallback instead of silently dropping data
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
          // Close SSE, fall back to polling
          if (esRef.current) {
            esRef.current.close();
            esRef.current = null;
          }
          startPollingFallback(jid);
        }
        // Otherwise EventSource will auto-reconnect
      };
    } catch {
      // EventSource constructor failed — fall back to polling
      startPollingFallback(jid);
    }
  }, [cleanup, startPollingFallback]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
      jobIdRef.current = null;
    };
  }, [cleanup]);

  return { job, setJob, subscribe, cleanup };
}
