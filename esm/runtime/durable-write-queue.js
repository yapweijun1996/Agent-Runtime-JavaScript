// AGRUN-440 — Durable ordered write queue.
//
// A FIFO that SERIALIZES async write jobs so they commit in enqueue order (no
// interleaving across concurrent callers), CAPTURES errors instead of leaking
// unhandled rejections (so a fire-and-forget enqueue can never crash the
// runtime), and exposes flush() so a host can await durability at a checkpoint
// (beforeunload, session close).
//
// This is the PRECONDITION that makes moving a write off the critical path safe
// (AGRUN-440 assistant transcript, AGRUN-444 memory extraction): ordering +
// flush + error-capture are exactly what a fire-and-forget write needs. It does
// NOT add crash-durability beyond the underlying storage adapter — it guarantees
// in-order, error-captured, awaitable writes, nothing more.
//
// Generic by design (no session/message knowledge) so it can back any ordered
// async write surface.

function createWriteQueue(options = {}) {
  const onError = typeof options.onError === "function" ? options.onError : null;
  const defaultLabel = typeof options.label === "string" && options.label.trim()
    ? options.label.trim()
    : "write";

  // The ordering chain. It NEVER rejects: every job's failure is swallowed here
  // so the next job still runs in order, and the failure is surfaced through the
  // returned promise / onError instead.
  let tail = Promise.resolve();
  let pending = 0;
  let lastError = null;

  function report(error, label) {
    lastError = error;
    if (!onError) return;
    try {
      onError({ error, label });
    } catch (_observerError) {
      // Error observers must never break the queue.
    }
  }

  // enqueue(job) runs `job()` strictly after every previously-enqueued job has
  // settled. The returned promise RESOLVES (never rejects) with the job's value,
  // or null if it threw — so a fire-and-forget caller produces no unhandled
  // rejection. Awaiting the returned promise = "this write (and all before it)
  // is durably committed".
  function enqueue(job, label) {
    if (typeof job !== "function") return Promise.resolve(null);
    const jobLabel = typeof label === "string" && label.trim() ? label.trim() : defaultLabel;
    pending += 1;
    const started = tail.then(() => job());
    // Continue the chain regardless of this job's outcome.
    tail = started.then(() => undefined, () => undefined);
    return started.then(
      (value) => {
        pending -= 1;
        return value;
      },
      (error) => {
        pending -= 1;
        report(error, jobLabel);
        return null;
      }
    );
  }

  // flush() resolves once every job enqueued BEFORE this call has settled. Jobs
  // enqueued afterwards are not awaited (they extend the chain further).
  function flush() {
    return tail.then(() => undefined);
  }

  return {
    enqueue,
    flush,
    size() {
      return pending;
    },
    lastError() {
      return lastError;
    }
  };
}

export { createWriteQueue };
