import { normalizeHostHookTimeoutMs, callHostHookWithTimeout } from './host-hook-timeout.js';

// AGRUN-418 phase 1: pluggable agent lifecycle hooks (AG2B HookRunner pattern).
//
// Three interceptor kinds, each resolved by a discriminated-union return so the
// loop can read intent without ambiguity:
//   preRequest  → void | { request }  | { response }            (skip provider)
//   onResponse  → void | { response }                           (replace reply)
//   preToolCall → void | { call }     | { result } | { error }  (skip handler)
//
// Chaining semantics: hooks run in registration order; a { request } / { call }
// / { response } return feeds the next hook, while a short-circuit return
// ({ response } on preRequest, { result } / { error } on preToolCall) stops the
// chain immediately.
//
// Raced-or-not (dispatch-matrix §4 posture): RACED. Hooks are host-supplied
// code awaited at loop scope, so every call rides callHostHookWithTimeout —
// a hung or throwing hook degrades to "hook ignored" with a diagnostic entry,
// never freezes the run. An invalid return shape degrades the same way.
//
// This module is path-agnostic registry + executor only. Wiring it into the
// dispatch paths (single-action AND plan batch; runtime.run AND session.run)
// is AGRUN-421/422 work and must cover both doors per the parity rule.


const HOOK_KINDS = Object.freeze(["preRequest", "onResponse", "preToolCall"]);

const HOOK_RETURN_KEYS = Object.freeze({
  preRequest: Object.freeze({ chain: "request", shortCircuit: Object.freeze(["response"]) }),
  onResponse: Object.freeze({ chain: "response", shortCircuit: Object.freeze([]) }),
  preToolCall: Object.freeze({ chain: "call", shortCircuit: Object.freeze(["result", "error"]) })
});

function readHookName(hook, kind, index) {
  return typeof hook.hookName === "string" && hook.hookName
    ? hook.hookName
    : hook.name || `${kind}#${index}`;
}

function resolveHookReturn(kind, value) {
  if (value == null) {
    return { type: "continue" };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { type: "invalid" };
  }
  const keys = HOOK_RETURN_KEYS[kind];
  const present = [keys.chain, ...keys.shortCircuit].filter((key) => key in value);
  if (present.length !== 1 || value[present[0]] == null) {
    return { type: "invalid" };
  }
  const key = present[0];
  return key === keys.chain
    ? { type: "chain", key, value: value[key] }
    : { type: "shortCircuit", key, value: value[key] };
}

function createHookRunner(options = {}) {
  const timeoutMs = normalizeHostHookTimeoutMs(options.timeoutMs);
  const registry = new Map(HOOK_KINDS.map((kind) => [kind, []]));

  function add(kind, hook) {
    if (!registry.has(kind)) {
      throw new Error(`Unknown hook kind "${kind}". Expected one of: ${HOOK_KINDS.join(", ")}.`);
    }
    if (typeof hook !== "function") {
      throw new Error(`Hook for "${kind}" must be a function.`);
    }
    const hooks = registry.get(kind);
    const entry = { hook };
    hooks.push(entry);
    return function dispose() {
      const index = hooks.indexOf(entry);
      if (index !== -1) {
        hooks.splice(index, 1);
      }
    };
  }

  // Runs every registered hook of `kind` in order. `chainValue` starts from
  // ctx[chainKey] and is replaced by each { chain } return; a short-circuit
  // return ends the chain. Hook failures (timeout / throw / invalid shape)
  // are recorded in diagnostics and the hook is skipped — fail-open by design.
  async function runKind(kind, ctx) {
    const source = ctx && typeof ctx === "object" ? ctx : {};
    const keys = HOOK_RETURN_KEYS[kind];
    const diagnostics = [];
    let chainValue = source[keys.chain];

    for (const [index, entry] of registry.get(kind).entries()) {
      const hookName = readHookName(entry.hook, kind, index);
      const hookCtx = { ...source, [keys.chain]: chainValue };
      const outcome = await callHostHookWithTimeout(() => entry.hook(hookCtx), { hookName, timeoutMs });
      if (!outcome.ok) {
        diagnostics.push({ kind, hookName, timedOut: outcome.timedOut === true, message: outcome.message });
        continue;
      }
      const resolved = resolveHookReturn(kind, outcome.value);
      if (resolved.type === "invalid") {
        diagnostics.push({
          kind,
          hookName,
          timedOut: false,
          message: `${hookName} returned an unrecognized shape; hook result ignored`
        });
        continue;
      }
      if (resolved.type === "chain") {
        chainValue = resolved.value;
        continue;
      }
      if (resolved.type === "shortCircuit") {
        return { outcome: resolved.key, [resolved.key]: resolved.value, diagnostics };
      }
    }

    return { outcome: "continue", [keys.chain]: chainValue, diagnostics };
  }

  return {
    add,
    // → { outcome: "continue", request } | { outcome: "response", response }
    runPreRequest: (ctx) => runKind("preRequest", ctx),
    // → { outcome: "continue", response }
    runOnResponse: (ctx) => runKind("onResponse", ctx),
    // → { outcome: "continue", call } | { outcome: "result", result } | { outcome: "error", error }
    runPreToolCall: (ctx) => runKind("preToolCall", ctx)
  };
}

export { createHookRunner };
