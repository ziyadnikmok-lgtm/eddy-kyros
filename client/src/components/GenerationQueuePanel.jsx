import { useState, useEffect, useCallback } from 'react';
import { jobs as jobsApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Btn } from './UI';
import { cn } from '../lib/utils';

/**
 * The generation queue, visible.
 *
 * Until this existed the queue was real but invisible: the server would keep rendering after a
 * close, recover work on the next boot and file it into a library, and the only evidence was
 * pictures appearing. "Can we see all of them, and just click retry failed" (owner, 2026-08-15) is
 * the missing half — at 100 lanes you need to know what is moving and what fell over.
 *
 * Polls only while there is something to watch. A queue at rest costs one request every 10s, and
 * the panel hides itself entirely when there is nothing at all — an empty box that never does
 * anything is noise on every page.
 */
const IDLE_MS = 10_000;
const BUSY_MS = 3_000;

export default function GenerationQueuePanel({ className = '' }) {
  const { notify } = useApp();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await jobsApi.list();
      setData(r?.data ?? r);
    } catch {
      // Signed out, offline, or the server is restarting. The panel simply keeps its last view
      // rather than flashing an error over work that is probably fine.
    }
  }, []);

  useEffect(() => {
    load();
    // Faster while work is in flight, slow when idle — the interval is rebuilt whenever that
    // changes, so a finishing queue drops back to the cheap rate on its own.
    const active = data?.counts?.active || 0;
    const id = setInterval(load, active ? BUSY_MS : IDLE_MS);
    return () => clearInterval(id);
  }, [load, data?.counts?.active]);

  const counts = data?.counts;
  const failed = data?.failed || [];
  // Nothing has ever been queued — say nothing at all.
  if (!counts || (!counts.active && !counts.failed && !counts.unfiled)) return null;

  const retryAll = async () => {
    setBusy(true);
    try {
      const r = await jobsApi.retryAllFailed();
      const n = (r?.data ?? r)?.requeued ?? 0;
      notify(n ? `${n} job${n === 1 ? '' : 's'} back on the queue` : 'Nothing to retry', n ? 'success' : 'info');
      await load();
    } catch (err) {
      notify(err.message || 'Could not retry', 'error');
    } finally {
      setBusy(false);
    }
  };

  const retryOne = async (id) => {
    setBusy(true);
    try {
      await jobsApi.retry(id);
      await load();
    } catch (err) {
      notify(err.message || 'Could not retry that one', 'error');
    } finally {
      setBusy(false);
    }
  };

  const Pill = ({ n, label, tone }) => (n ? (
    <span className={cn('rounded-md px-2 py-0.5 text-[0.6875rem] font-bold uppercase tracking-wide', tone)}>
      {n} {label}
    </span>
  ) : null);

  return (
    <div className={cn('rounded-xl border border-white/[0.07] bg-black/30 px-3 py-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-zinc-500">Queue</span>
        <Pill n={counts.queued} label="waiting" tone="bg-zinc-500/20 text-zinc-300" />
        <Pill n={counts.submitting + counts.submitted} label="rendering" tone="bg-blue-500/25 text-blue-200" />
        <Pill n={counts.unfiled} label="to file" tone="bg-emerald-500/20 text-emerald-200" />
        <Pill n={counts.failed} label="failed" tone="bg-rose-500/25 text-rose-200" />

        {counts.failed > 0 && (
          <>
            <Btn variant="secondary" className="!rounded-lg !py-1 !px-3 !text-xs" disabled={busy} onClick={retryAll}>
              {busy ? 'Retrying…' : `Retry ${counts.failed} failed`}
            </Btn>
            <button type="button" onClick={() => setOpen((v) => !v)}
              className="text-[0.6875rem] text-zinc-500 hover:text-zinc-300 cursor-pointer">
              {open ? 'hide' : 'why?'}
            </button>
          </>
        )}
        {!counts.failed && counts.active > 0 && (
          <span className="text-[0.6875rem] text-zinc-600">running in the background — closing the app is safe</span>
        )}
      </div>

      {/* The reasons, not just the count. A failure you cannot read is one you cannot act on, and
          these are the rows a retry will re-charge for. */}
      {open && failed.length > 0 && (
        <div className="mt-2 max-h-48 space-y-1 overflow-y-auto border-t border-white/[0.06] pt-2">
          {failed.map((j) => (
            <div key={j.id} className="flex items-start justify-between gap-2 text-[0.6875rem]">
              <span className="min-w-0 flex-1 text-zinc-500">
                <span className="text-zinc-400">{j.cardName || j.feature}</span>
                {j.error ? ` — ${j.error}` : ''}
              </span>
              <button type="button" disabled={busy} onClick={() => retryOne(j.id)}
                className="shrink-0 text-rose-300/80 hover:text-rose-200 cursor-pointer disabled:opacity-40">
                retry
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
