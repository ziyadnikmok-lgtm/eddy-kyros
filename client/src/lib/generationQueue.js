/**
 * Running a Seedream job through the durable queue, with the same shape the pages already use.
 *
 * `queuedSeedreamEdit` awaits a finished result exactly like `seedream.edit` does, so a page adopts
 * it by changing one call. The difference is underneath: the work is written to disk before
 * anything is sent, the server owns the render, and closing the app no longer loses it.
 *
 * WHAT SURVIVES WHAT:
 *   * closed before it was sent   -> still queued; the server sends it on the next boot
 *   * closed while rendering      -> the task id is on disk; the server collects the picture and
 *                                    the next load files it into the library you chose
 *   * closed after it finished    -> it is waiting in the unfiled list; reconcileUnfiled files it
 *
 * The one case that does NOT auto-resume is a crash in the instant between Muapi accepting and the
 * id being written. That job is failed rather than resent, because it may already have been
 * charged — see THE ORPHAN WINDOW in server/services/jobQueue.js.
 */
import { jobs as jobsApi, gallery as galleryApi } from '../services/api';
import { createEddyCollection } from './eddyCollectionStore';
import { fileIntoLibrary, destLabel } from './libraryDestination';

// The server polls Muapi every 6s, so asking faster than that only adds requests without learning
// anything sooner.
const POLL_MS = 3000;
// A render that has not finished in this long is not going to inside this page's lifetime. The JOB
// is not abandoned — it stays on the queue and the server keeps at it — only this await gives up,
// and whatever lands is filed on the next load.
const WAIT_TIMEOUT_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class QueuedJobStillRunning extends Error {
  constructor(jobId) {
    super('Still rendering — it will finish in the background and land in your library.');
    this.name = 'QueuedJobStillRunning';
    this.jobId = jobId;
  }
}

/**
 * Enqueue and wait. Resolves { galleryId, url, jobId }.
 *
 * Throws on a failed job. Throws QueuedJobStillRunning if the wait times out — which is NOT a
 * failure and callers should say so, because the work is still on the queue.
 */
export async function queuedSeedreamEdit({
  feature,
  images,
  prompt,
  aspectRatio,
  resolution,
  destDb,
  destFolder,
  cardPrompt,
  cardName,
  signal,
}) {
  const created = await jobsApi.enqueue({
    feature,
    payload: { images, prompt, aspectRatio, resolution },
    destDb,
    destFolder,
    cardPrompt,
    cardName,
  });
  const jobId = created?.data?.id ?? created?.id;
  if (!jobId) throw new Error('The queue did not return a job id');

  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new QueuedJobStillRunning(jobId);
    await sleep(POLL_MS);
    let job;
    try {
      const r = await jobsApi.get(jobId);
      job = r?.data ?? r;
    } catch {
      continue;   // a blip in the status check is not a failed render — ask again
    }
    if (job.status === 'done') {
      return { jobId, galleryId: job.galleryId, url: galleryApi.imageUrl(job.galleryId) };
    }
    if (job.status === 'failed') throw new Error(job.error || 'Generation failed');
  }
  throw new QueuedJobStillRunning(jobId);
}

/**
 * File everything that finished while this page was not watching.
 *
 * Called once on load. Each job carries the destination it was STARTED with, not whatever the
 * dropdown says now — a run begun into Base Library belongs in Base Library even if the control has
 * been changed twice since.
 *
 * A job is marked filed ONLY after the write succeeds. If storage is full or the write throws, it
 * stays unfiled and is retried on the next load, which is the right way round: a picture that is
 * still owed is recoverable, one marked filed but never written is invisible forever.
 *
 * Returns { filed, failed } so the caller can say something if anything landed.
 */
export async function reconcileUnfiled() {
  let list;
  try {
    const r = await jobsApi.list();
    list = (r?.data ?? r)?.unfiled || [];
  } catch {
    return { filed: 0, failed: 0 };   // offline or signed out — nothing to do, and nothing to say
  }
  if (!list.length) return { filed: 0, failed: 0 };

  let filed = 0;
  let failed = 0;
  for (const job of list) {
    if (!job.galleryId) continue;
    try {
      const store = createEddyCollection(job.destDb || 'eddy-library');
      // eslint-disable-next-line no-await-in-loop
      await fileIntoLibrary(store, {
        url: galleryApi.imageUrl(job.galleryId),
        prompt: job.cardPrompt || 'Recovered generation',
        name: job.cardName || `recovered-${job.id.slice(0, 8)}`,
      }, { folder: job.destFolder || '', label: destLabel(job.destDb) });
      // eslint-disable-next-line no-await-in-loop
      await jobsApi.markFiled(job.id);
      filed += 1;
    } catch {
      // Left unfiled on purpose — the next load tries again.
      failed += 1;
    }
  }
  return { filed, failed };
}
