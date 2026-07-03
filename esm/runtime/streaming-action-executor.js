import { createAbortError } from './abort-signal.js';
import { serializeError } from './errors.js';
import { createAsyncEventQueue } from './async-event-queue.js';

// AGRUN-443 — Streaming Action Executor (slice 1: the scheduling primitive).
//
// Today the action loop executes a planner's actions and only then moves on.
// 443's goal is to start concurrency-safe (read-only) actions the moment they
// are known — e.g. as the provider streams tool calls — and surface each result
// as it completes, so a multi-tool turn finishes in ~max(action) instead of
// ~sum(action) wall-clock.
//
// This module is the pure SCHEDULER. It owns concurrency, ordering, completion-
// order result delivery, and sibling-abort — nothing else. It does NOT decide
// which actions are safe to parallelize: the caller stamps each descriptor with
// `concurrencySafe` / `readonly` (the wiring layer derives those from action
// permission metadata — read-only tier == concurrency-safe), keeping the
// AI-first / no-hardcode contract (no action-name lists live here).
//
// Contract:
//   add({ id, concurrencySafe, readonly, run })  enqueue an action. `run(signal)`
//       returns a Promise; `signal` is the shared abort signal (see sibling-abort).
//   close()                                       no more actions will be added.
//   getCompletedResults()                         async generator yielding
//       { id, ok, value? , error?, aborted? } in COMPLETION order until drained.
//   abort()                                       abort the whole batch.
//   getState()                                    { added, settled, running }.
//
// Ordering: a `concurrencySafe` action starts immediately (subject to the
// concurrency cap). A NON-concurrency-safe action is a BARRIER — it starts only
// once every earlier action has settled, runs alone, and every later action
// waits for it. So reads parallelize and a write is serialized against its
// neighbours, preserving the planner's intended order around mutations.
//
// Sibling-abort: when a NON-read-only action rejects, the shared signal aborts —
// in-flight siblings observe `signal.aborted` and may bail, and not-yet-started
// actions are drained as `{ ok: false, aborted: true }`. A read-only failure is
// isolated (it never aborts siblings).


const DEFAULT_CONCURRENCY = 8;

function normalizeConcurrency(value) {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CONCURRENCY;
}

function createStreamingActionExecutor(options) {
  const opts = options && typeof options === "object" ? options : {};
  const concurrency = normalizeConcurrency(opts.concurrency);
  const controller = new AbortController();

  const externalSignal = opts.signal && typeof opts.signal.addEventListener === "function"
    ? opts.signal
    : null;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const results = createAsyncEventQueue();
  const queue = [];
  let added = 0;
  let settled = 0;
  let running = 0;
  let barrierInFlight = false;
  let closed = false;

  function maybeClose() {
    if (closed && running === 0 && queue.length === 0) results.close();
  }

  function start(descriptor) {
    running += 1;
    if (!descriptor.concurrencySafe) barrierInFlight = true;
    Promise.resolve()
      .then(() => descriptor.run(controller.signal))
      .then(
        (value) => finish(descriptor, { id: descriptor.id, ok: true, value }),
        (error) => finish(descriptor, { id: descriptor.id, ok: false, error: serializeError(error) })
      );
  }

  function finish(descriptor, result) {
    running -= 1;
    if (!descriptor.concurrencySafe) barrierInFlight = false;
    settled += 1;
    // Sibling-abort: a mutating (non-read-only) failure aborts the batch. A
    // read-only failure is isolated — its siblings keep running.
    if (!result.ok && !descriptor.readonly && !controller.signal.aborted) {
      controller.abort();
    }
    results.push(result);
    pump();
    maybeClose();
  }

  function drainAbortedQueue() {
    while (queue.length) {
      const descriptor = queue.shift();
      settled += 1;
      results.push({
        id: descriptor.id,
        ok: false,
        aborted: true,
        error: serializeError(createAbortError(`Action "${descriptor.id}" aborted before it started.`))
      });
    }
  }

  function pump() {
    if (controller.signal.aborted) {
      drainAbortedQueue();
      maybeClose();
      return;
    }
    while (queue.length > 0 && running < concurrency && !barrierInFlight) {
      const head = queue[0];
      if (!head.concurrencySafe) {
        // Barrier: wait for everything in flight to settle, then run it alone.
        if (running > 0) break;
        queue.shift();
        start(head);
      } else {
        queue.shift();
        start(head);
      }
    }
  }

  function normalizeDescriptor(descriptor) {
    if (!descriptor || typeof descriptor !== "object" || typeof descriptor.run !== "function") {
      throw new Error("createStreamingActionExecutor.add: descriptor with a run() function is required");
    }
    return {
      id: descriptor.id == null ? `action-${added}` : descriptor.id,
      concurrencySafe: Boolean(descriptor.concurrencySafe),
      readonly: Boolean(descriptor.readonly),
      run: descriptor.run
    };
  }

  return {
    add(descriptor) {
      if (closed) throw new Error("createStreamingActionExecutor.add: executor is closed");
      const normalized = normalizeDescriptor(descriptor);
      added += 1;
      queue.push(normalized);
      pump();
      return normalized.id;
    },

    close() {
      closed = true;
      maybeClose();
    },

    abort() {
      controller.abort();
      pump();
    },

    async *getCompletedResults() {
      while (true) {
        const next = await results.next();
        if (next.done) return;
        yield next.value;
      }
    },

    getState() {
      return { added, settled, running };
    },

    get signal() {
      return controller.signal;
    }
  };
}

export { createStreamingActionExecutor };
