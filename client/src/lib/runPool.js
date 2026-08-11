/**
 * Runs `worker` over every item with at most `limit` calls in flight at once.
 *
 * WHY this exists as its own module rather than another inline cursor loop: the bulk regenerate
 * in the review gate can fire twenty Seedream calls from one click, and this codebase has been
 * burned repeatedly by 429 quota storms from unthrottled fan-out. A shared, directly testable
 * helper is the difference between "we believe it is capped" and "we can show it is capped" —
 * a plain .js module can be imported by node with no bundler, which is the only way to
 * demonstrate the cap in a repo with no test framework.
 *
 * A worker that throws is NOT allowed to abort the pool: one failed regenerate must leave the
 * other nineteen running. Failures are the worker's own business — it is expected to record its
 * outcome per item (the gate paints the error onto that card) — so the rejection is swallowed
 * here rather than propagated to Promise.all, which would cancel nothing but would surface as an
 * unhandled rejection and skip the remaining items in that lane.
 */
/**
 * `shouldStop` — an optional predicate checked before each item is claimed. Returning true stops
 * the pool DISPATCHING anything further; it does not abort work already in flight, because those
 * requests are already sent and already billed, and dropping their results would mean paying for
 * images you never receive. So a cancel takes effect at the queue, which is exactly where the
 * unsent items are: on a 60-image run cancelled at 30, the 30 done are kept, the ~6 in flight
 * finish and are kept, and the remaining ~24 are never sent and never charged.
 */
export async function runPool(items, limit, worker, shouldStop) {
  // A single shared cursor, read-then-incremented by every lane. JS is single-threaded between
  // awaits, so the read+increment pair cannot interleave and no two lanes can claim one item.
  let cursor = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));

  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (cursor < items.length) {
        // Checked inside the loop, not once before it: a cancel arriving mid-run has to stop the
        // NEXT claim, and a lane that is awaiting a slow request may not re-enter here for many
        // seconds after the click.
        if (typeof shouldStop === 'function' && shouldStop()) return;
        const index = cursor;
        cursor += 1;
        try {
          await worker(items[index], index);
        } catch {
          // Swallowed on purpose — see the note above. The worker owns its own error reporting.
        }
      }
    }),
  );
}
