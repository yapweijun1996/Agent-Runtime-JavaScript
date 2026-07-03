// A minimal single-consumer async queue: producers push() synchronously; one
// consumer pulls via next() (resolving { value, done }); close() ends iteration.
// Shared SSOT for the streaming primitives (AGRUN-442 run-event-stream,
// AGRUN-443 streaming-action-executor) so the buffering/backpressure logic lives
// in exactly one place.
function createAsyncEventQueue() {
  const buffer = [];
  const waiters = [];
  let closed = false;
  return {
    push(value) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else buffer.push(value);
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
    next() {
      if (buffer.length) return Promise.resolve({ value: buffer.shift(), done: false });
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => { waiters.push(resolve); });
    },
    get closed() {
      return closed;
    }
  };
}

export { createAsyncEventQueue };
