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
export async function runPool(items, limit, worker) {
  // A single shared cursor, read-then-incremented by every lane. JS is single-threaded between
  // awaits, so the read+increment pair cannot interleave and no two lanes can claim one item.
  let cursor = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));

  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (cursor < items.length) {
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
