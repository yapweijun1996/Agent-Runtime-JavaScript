// Bounded-parallelism map: run `worker(item)` over `items` with at most `limit`
// workers in flight, returning one allSettled-shaped entry per item IN INPUT
// ORDER — `{ status: "fulfilled", value }` or `{ status: "rejected", reason }`.
// A fixed worker pool drains a shared cursor, so a slow item never stops a free
// worker from starting the next.
//
// SSOT for the plan-batch (action-loop-plan-actions.js) and section-synthesize
// (action-loop-plan-synthesize.js) execution paths, which previously held two
// byte-identical copies of this helper.
//
// Note (AGRUN-443): this is the plan path's EXISTING concurrency. The streaming
// action executor (createStreamingActionExecutor) is a richer scheduler
// (completion-order delivery, sibling-abort, read/write barrier) intended for
// the start-tools-during-streaming path; it is intentionally NOT swapped in here,
// because the plan envelope is fully parsed before execution and the executor's
// extra semantics would change plan failure/ordering behavior.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit || 1), items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = {
          status: "fulfilled",
          value: await worker(items[index])
        };
      } catch (error) {
        results[index] = {
          reason: error,
          status: "rejected"
        };
      }
    }
  }));

  return results;
}

export { runWithConcurrency };
