import { readString } from './semantic-json.js';

// ADR-0037 — spawn_subagent orchestrator/worker capability.
//
// Constructs the `spawnSubagent` callable that the action handler invokes
// when an AI selects the `spawn_subagent` tool. The capability:
//
//   1. Clones the parent runLoop options.
//   2. Overrides the rawInput prompt with the child's `task`.
//   3. Stamps lineage: child gets a synthetic sessionId; parent's sessionId
//      becomes the child's parentSessionId. AGRUN-240-followup auto-injects
//      these onto every child step.detail / event-ledger entry.
//   4. Enforces depth=1 by always disabling `spawn_subagent` for the child.
//   5. Optionally narrows the child's tool surface by appending non-listed
//      actions to disabledActions when caller passes `tools: [...]`.
//   6. Calls the recursive `runLoop` and normalizes the result into a
//      subagent_result envelope consumed by the parent's action loop.
//
// Child sessions are in-memory only (no sessionRecord persisted). Lineage
// lives entirely in step / ledger events. Persisting child sessionRecords
// is deferred to a future ADR if hosts need it.


const SUBAGENT_ACTION_NAME = "spawn_subagent";
const DEFAULT_CHILD_MAX_STEPS = 15;

// 2026-06-03 isolation hardening — parent run-state fields that must NEVER
// reach the child via the `{ ...parentOptions }` spread. The child is a
// fresh, focused worker (ADR-0037, context-attention-budget-and-subagents.md):
// it must start with a clean per-run state, not the parent's.
//
// `threadHydration` is a CONFIRMED present leak (not merely latent): the
// session handle (src/session/handle.js) sets `threadHydration` on the run
// options, it carries the active thread's `todoState` + `researchContext`,
// and `createActionLoopSession` calls `hydrateRunStateWithThread` on the
// child's fresh runState (because the child has no `runState`) — so without
// this blank the worker inherits the parent thread's TodoState and research
// sources. `turnIntent` is likewise set on parent options by the handle.
//
// The remaining keys are `options.X || rebuild(...)` reads in
// action-loop-session.js: leaving them on the child would make it reuse the
// parent's array/sink/registry instead of building its own. They are not all
// set on parent options today, but blanking them is the default-deny posture
// the multi-agent audit asked for — and it is a no-op when absent.
//
// NOTE on posture: a full allowlist of "fields the child keeps" was evaluated
// and rejected — the child's option consumption is sprawling (~30+ piecemeal
// `options.X` reads across action-loop-session.js / run-loop.js / approval.js
// / finalize), so an allowlist would silently break the child if one infra
// field were missed. This explicit blank-list targets exactly the parent
// run-state category and is guarded by a regression test.
const CHILD_PARENT_STATE_BLANKLIST = Object.freeze([
  "threadHydration",
  "turnIntent",
  "runState",
  // 2026-06-10 — crash-recovery P2 added `resumeState` (run-loop spreads it
  // into runActionLoop, which converts it to the session's runState). A
  // resumed parent that spawns a worker must NOT seed the child with the
  // parent's checkpointed runState — same category as `runState` above.
  "resumeState",
  "todoState",
  "contextSnapshot",
  "sessionContext",
  "sessionRecord",
  "researchContext",
  "researchState",
  "evidenceState",
  "actionHistory",
  "steps",
  "pushStep",
  "memoryEntriesAdded",
  "availableActions",
  "plannerActions"
]);

function blankParentRunState() {
  const out = {};
  for (const key of CHILD_PARENT_STATE_BLANKLIST) {
    out[key] = undefined;
  }
  return out;
}

// Capability factory. Bound once per parent runLoop invocation; injected
// into action.execute(context) by action-loop-action.js. The `runLoop`
// parameter is the function reference (not the runtime), so this module
// is testable in isolation.
function createSpawnSubagentCapability({
  runLoop,
  parentOptions,
  actionRegistryActions
}) {
  if (typeof runLoop !== "function") {
    throw new Error("createSpawnSubagentCapability: runLoop function is required");
  }
  if (!parentOptions || typeof parentOptions !== "object") {
    throw new Error("createSpawnSubagentCapability: parentOptions is required");
  }

  let childSequence = 0;
  const parentSessionId = readString(parentOptions.sessionId);
  const parentRunId = readString(parentOptions.runId) || "run";
  const knownActionNames = collectActionNames(actionRegistryActions);

  return async function spawnSubagent(args) {
    const task = readString(args && args.task);
    if (!task) {
      return failureEnvelope({
        code: "SUBAGENT_INVALID_ARGS",
        message: "spawn_subagent requires a non-empty `task` string."
      });
    }

    childSequence += 1;
    const childSessionId = `${parentSessionId || "session"}.child-${childSequence}`;
    const childRunId = `${parentRunId}.child-${childSequence}`;
    const childMaxSteps = clampChildMaxSteps(args && args.maxSteps, parentOptions);
    const requestedTools = readArray(args && args.tools);
    const childDisabledActions = buildChildDisabledActions({
      parentDisabledActions: readArray(parentOptions.disabledActions),
      runtimeConfigDisabled: readArray(parentOptions.runtimeConfig && parentOptions.runtimeConfig.disabledActions),
      requestedTools,
      knownActionNames
    });

    const childOptions = buildChildOptions({
      parentOptions,
      task,
      childRunId,
      childSessionId,
      parentSessionId,
      childDisabledActions,
      childMaxSteps,
      requestedTools
    });

    let childResult;
    try {
      childResult = await runLoop(childOptions);
    } catch (error) {
      return failureEnvelope({
        code: "SUBAGENT_RUN_ERROR",
        message: readString(error && error.message) || "spawn_subagent execution threw",
        childSessionId,
        childRunId
      });
    }

    return normalizeChildResult({ childResult, childSessionId, childRunId });
  };
}

function buildChildOptions({
  parentOptions,
  task,
  childRunId,
  childSessionId,
  parentSessionId,
  childDisabledActions,
  childMaxSteps,
  requestedTools
}) {
  // ADR-0037 / 2026-05-26 follow-up — child rawInput must be a CLEAN
  // turn request, not a copy of the parent's. The hang discovered in
  // live e2e was a recursion bomb: when the parent was on the
  // approval-resume path (user just clicked Approve), its rawInput
  // carried `type: "approval_resolution"` + a verified `resumeToken`.
  // Spreading that into the child made `isApprovalResolutionRequest`
  // true for the child, which then ran `runApprovalResolution`,
  // restored the same approval, re-executed spawn_subagent, and
  // recursed indefinitely with no I/O between iterations — starving
  // the UI's render frames until the tab froze.
  //
  // Fix: build the child's rawInput from a known-safe allowlist of
  // provider / network fields rather than spreading. The child is
  // always a fresh user-turn request — never an approval resume.
  //
  // AGRUN-255 live e2e 2026-05-26 — second regression caught here:
  // when parent is on the approval-resume path, browser hosts call
  // runtime.run with a MINIMAL rawInput (apiKey, fetch, provider,
  // type:"approval_resolution", resumeToken, ...) — NO model, NO
  // prompt, NO apiVariant. The runtime restores those from resumeToken
  // for the parent's continuation. But the child needs them as plain
  // fields, so it can pass `normalizeBrowserProviderRequest`'s
  // non-empty checks for model / apiKey. We backfill from
  // `parentOptions.request` (the already-normalized provider request)
  // when rawInput is missing them. The child fails synchronously with
  // INVALID_PROVIDER_REQUEST otherwise.
  const childRawInput = buildChildRawInput(parentOptions.rawInput, task, parentSessionId, parentOptions.request);

  const parentRuntimeConfig = parentOptions.runtimeConfig && typeof parentOptions.runtimeConfig === "object"
    ? parentOptions.runtimeConfig
    : {};
  const childRuntimeConfig = {
    // ADR-0057 Phase 1 triage (dispatch-matrix third door, audit §5 "write it
    // down") — `deferredNamespaces` is DELIBERATELY inherited via this parent
    // config spread: the host's deferral posture is createRuntime capability
    // config, not parent run-state. The parent's OPEN state does NOT leak:
    // `runState.actionNamespaceContext` rides runState, which the
    // CHILD_PARENT_STATE_BLANKLIST above blanks (`runState` + `resumeState`),
    // so the child builds a fresh runState and starts with every deferred
    // namespace CLOSED — fresh discovery per ADR-0057 §4. The child's own
    // registry re-registers open_action_namespace from this inherited config.
    ...parentRuntimeConfig,
    maxSteps: childMaxSteps,
    // Child must not re-trigger spawn_subagent via runtimeConfig default
    // (defense in depth — also enforced via disabledActions below).
    disabledActions: mergeUniqueStrings(parentRuntimeConfig.disabledActions, [SUBAGENT_ACTION_NAME]),
    // AGRUN-255 (ADR-0037 follow-up) — child-tool approval via inheritance.
    //
    // When the AI spawns a child with `tools: ["web_search", ...]`, the
    // user already saw the requested tools at the parent's approval
    // prompt for spawn_subagent. Re-prompting inside the child for each
    // declared tool would break the orchestrator/worker UX and likely
    // hang the child (the child has no onStep, so the host UI cannot
    // surface a child-level approval).
    //
    // Decision (Option C, confirmed by advisor): the `tools: [...]`
    // allowlist doubles as a *pre-approval contract*. Declared tools
    // are auto-allowed inside the child via runtimeConfig.actionPolicy,
    // EXCEPT when the host has explicitly denied that tool — host
    // "deny" is a security boundary and must never be overridden.
    //
    // An empty / omitted `tools` list does NOT mean "allow everything";
    // no auto-allow entries are added, and the child falls back to the
    // host's normal tier-based gating (which will block if no onStep).
    actionPolicy: buildChildActionPolicy(parentRuntimeConfig.actionPolicy, requestedTools)
  };

  return {
    ...parentOptions,
    // 2026-06-03 — strip parent run-state BEFORE the explicit overrides so a
    // future field added to parent options cannot silently leak into the
    // child. Fixes a CONFIRMED threadHydration leak (parent thread todoState
    // + researchContext). See CHILD_PARENT_STATE_BLANKLIST above.
    ...blankParentRunState(),
    // 2026-06-10 dispatch-path re-scan — `plannerDirectives` /
    // `plannerDirectivesMode` are DELIBERATELY inherited via the spread above
    // (not stripped, not blanked). They are host planner-prompt guidance, not
    // parent run-state, so they legitimately apply to the worker too — and
    // this keeps them consistent with `runtimeConfig.plannerDirectives`, which
    // the child already inherits through `childRuntimeConfig` (parent config
    // spread). Stripping only the per-run pair would create a confusing split
    // where the child kept the createRuntime directives but lost the per-run
    // ones. Triaged and intentionally left inherited (audit §5 "write it down").
    rawInput: childRawInput,
    runtimeConfig: childRuntimeConfig,
    disabledActions: childDisabledActions,
    runId: childRunId,
    sessionId: childSessionId,
    parentSessionId: parentSessionId || null,
    // ADR-0037 / 2026-05-26 follow-up — child runs in event isolation.
    //
    // Why: live e2e showed that letting the child share the parent's
    // onStep / onStreamEvent caused a React re-render storm in the
    // browser inspector — the parent UI tried to render every child
    // planner-requested / action-executed / token-delta event as if it
    // were a parent activity, blocking the main thread until the child
    // finished. The lineage tags (sessionId/parentSessionId on every
    // step.detail) were doing their job; the host UI just wasn't ready
    // to filter on them yet.
    //
    // What: strip every per-event host callback so child events stay
    // entirely inside the child's runState.eventLedger (G4 ledger). The
    // parent's `executeAction` already receives a single normalized
    // subagent_result envelope, which is the right boundary — the
    // parent should see the child's *result*, not its internal trace.
    //
    // The parent's `callerAbortSignal` IS still inherited (so parent
    // stop cancels the child mid-flight); only the per-step/per-token
    // listeners are silenced. Hosts that want to render child traces
    // can read the returned envelope's child run id and pull events
    // from the child's ledger separately.
    onStep: undefined,
    onStreamEvent: undefined,
    onToken: undefined,
    onReasoning: undefined,
    onPlannerDecision: undefined,
    onToolResult: undefined,
    onInvalidPlannerOutput: undefined,
    onBeforeFinalize: undefined,
    // 2026-06-10 — crash-recovery P2 added `onCheckpoint`. The child must not
    // fire the parent's checkpoint hook: hosts persist envelopes under one
    // run/session key, so child envelopes would overwrite the parent's
    // checkpoint and corrupt crash recovery. Same isolation boundary as the
    // per-step listeners above.
    onCheckpoint: undefined,
    // `normalizedInput` is intentionally NOT inherited — runLoop will
    // recompute it from the new rawInput.
    normalizedInput: undefined,
    // ADR-0037 / 2026-05-26 follow-up — defensive: also discard the
    // parent's normalized `request` object. On the approval-resume
    // path parent's request.type === "approval_resolution" with a
    // resumeToken in body. Even though buildChildRawInput already
    // strips the rawInput markers, leaving a stale request through
    // would re-introduce the recursion via any downstream consumer
    // that re-reads `request.type`. The child's runLoop rebuilds
    // request from the cleaned rawInput via
    // `normalizeToolLoopProviderRequest`.
    request: undefined
  };
}

// Allowlist of rawInput fields the child genuinely needs to call the
// LLM and host network helpers. Anything not on this list is dropped —
// including `type`, `resumeToken`, `_approvalPreVerified`, and any
// future approval-resolution markers. This is intentional: the child
// is never a continuation of the parent's approval flow; it starts a
// fresh tool-loop turn with the child's own `prompt`.
const CHILD_RAW_INPUT_ALLOWLIST = Object.freeze([
  "provider", "providerId",
  "apiKey",
  "model", "modelId",
  "endpoint",
  "fetch",
  "webSearchEndpoint", "webSearchApiKey", "webSearchProvider", "webSearchModel", "webSearchAuthMode",
  "readUrlEndpoint", "readUrlApiKey",
  "authMode",
  "signal",
  // AGRUN-518 — a subagent runs at the same wall-clock as its parent, so it
  // inherits the host-provided time context rather than guessing.
  "timeContext"
]);

function buildChildRawInput(parentRawInput, task, parentSessionId, parentRequest) {
  const out = { prompt: task, parentSessionId };
  if (parentRawInput && typeof parentRawInput === "object" && !Array.isArray(parentRawInput)) {
    for (const key of CHILD_RAW_INPUT_ALLOWLIST) {
      if (Object.prototype.hasOwnProperty.call(parentRawInput, key)) {
        out[key] = parentRawInput[key];
      }
    }
  }
  // AGRUN-255 — backfill from the normalized provider request when
  // rawInput is missing fields (approval-resume path: host's rawInput
  // is minimal and the runtime restores model/apiVariant/etc from the
  // resumeToken into `request`). We only set the field on `out` when
  // it's currently undefined, so the rawInput value (when present)
  // always wins. `prompt` is intentionally NOT inherited — child's
  // prompt is always the task. Approval markers (type, resumeToken,
  // _approvalPreVerified, signal, contextSnapshot, sessionContext)
  // are intentionally NOT in REQUEST_BACKFILL_FIELDS — child must
  // never re-enter the approval-resume branch.
  if (parentRequest && typeof parentRequest === "object" && !Array.isArray(parentRequest)) {
    for (const key of REQUEST_BACKFILL_FIELDS) {
      if (out[key] === undefined && parentRequest[key] !== undefined) {
        out[key] = parentRequest[key];
      }
    }
  }
  return out;
}

// AGRUN-255 — fields backfilled from parentOptions.request when the
// host's rawInput omits them (approval-resume path). The normalized
// `request` object built by normalizeToolLoopProviderRequest carries
// every resolved provider/network setting needed by the child's own
// normalizeBrowserProviderRequest pass. We do NOT backfill `prompt`
// (child sets its own task) and we do NOT backfill any field that
// could re-enter approval resolution.
const REQUEST_BACKFILL_FIELDS = Object.freeze([
  "provider", "providerId",
  "apiKey",
  "model", "modelId",
  "apiVariant",
  "authMode",
  "endpoint",
  "streamEndpoint",
  "fetch",
  "webSearchEndpoint", "webSearchApiKey", "webSearchProvider", "webSearchModel", "webSearchAuthMode",
  "readUrlEndpoint", "readUrlApiKey",
  "searchProvider",
  "reasoningEffort",
  "timeoutMs",
  "systemPrompt",
  "timeContext"
]);

// AGRUN-255 — build child's actionPolicy by inheriting parent's policy
// and adding "allow" entries for tools the AI explicitly requested via
// spawn_subagent's `tools: [...]` argument.
//
// Invariants:
//   1. Parent "deny" is NEVER overridden (host security boundary).
//   2. Empty/omitted requestedTools adds nothing — no implicit allow-all.
//   3. Existing parent entries for other tools are preserved verbatim.
//
// The parent policy entry may be a plain string ("allow"/"ask"/"deny")
// or an object with shape { action: "...", reason?: "..." }. We detect
// both shapes when checking for "deny".
function buildChildActionPolicy(parentPolicy, requestedTools) {
  const out = parentPolicy && typeof parentPolicy === "object" && !Array.isArray(parentPolicy)
    ? { ...parentPolicy }
    : {};
  if (!Array.isArray(requestedTools) || requestedTools.length === 0) return out;
  for (const raw of requestedTools) {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name) continue;
    if (name === SUBAGENT_ACTION_NAME) continue; // never pre-approve recursion
    const existing = out[name];
    const existingAction = typeof existing === "string"
      ? existing
      : (existing && typeof existing === "object" ? existing.action : null);
    if (existingAction === "deny") continue; // never override host deny
    out[name] = "allow";
  }
  return out;
}

function buildChildDisabledActions({
  parentDisabledActions,
  runtimeConfigDisabled,
  requestedTools,
  knownActionNames
}) {
  const disabled = new Set();
  for (const name of parentDisabledActions) disabled.add(name);
  for (const name of runtimeConfigDisabled) disabled.add(name);
  // Decision 1 — depth=1 via physical filter. Always disable the
  // spawn action for the child, no matter what the parent passed in.
  disabled.add(SUBAGENT_ACTION_NAME);

  // Decision 4 — if caller narrowed via `tools: [...]`, disable every
  // known action that is NOT in the allowlist. spawn_subagent stays
  // disabled regardless of allowlist membership.
  if (requestedTools.length > 0) {
    const allowed = new Set(requestedTools.map((name) => name.trim()).filter(Boolean));
    for (const name of knownActionNames) {
      if (name === SUBAGENT_ACTION_NAME) continue;
      if (!allowed.has(name)) disabled.add(name);
    }
  }

  return Array.from(disabled);
}

function clampChildMaxSteps(requested, parentOptions) {
  // Default child budget is DEFAULT_CHILD_MAX_STEPS (15) — a sub-agent is
  // a focused worker, not a full main loop. Caller can request more via
  // `maxSteps`, but the child is always clamped to the parent's overall
  // ceiling so a delegated worker cannot escape the parent's budget.
  const parentMax = readPositiveInteger$b(parentOptions && parentOptions.runtimeConfig && parentOptions.runtimeConfig.maxSteps);
  const requestedMax = readPositiveInteger$b(requested);
  const desired = requestedMax || DEFAULT_CHILD_MAX_STEPS;
  return parentMax ? Math.min(desired, parentMax) : desired;
}

function normalizeChildResult({ childResult, childSessionId, childRunId }) {
  const runState = childResult && childResult.runState ? childResult.runState : {};
  const status = readString(runState.status) || "unknown";
  const cycleCount = Number.isInteger(runState.cycleCount) ? runState.cycleCount : 0;
  const usage = childResult && childResult.lastTokenUsage
    ? childResult.lastTokenUsage
    : (runState.metrics && runState.metrics.usage) || null;
  const finalResponse = readChildFinalResponse(childResult, runState);
  const errorDetail = runState.error || (childResult && childResult.error) || null;
  const emptySuccessError = !errorDetail && isSuccessfulChildStatus(status) && !finalResponse
    ? {
        code: "SUBAGENT_EMPTY_RESPONSE",
        message: "Subagent completed without a non-empty finalResponse."
      }
    : null;
  const effectiveError = errorDetail || emptySuccessError;
  const outputStatus = effectiveError
    ? "failed"
    : (status === "completed" ? "completed" : status);
  const errorCode = readString(effectiveError && effectiveError.code) || "SUBAGENT_FAILED";

  return {
    control: "continue",
    output: {
      kind: "subagent_result",
      childSessionId,
      childRunId,
      status: outputStatus,
      finalResponse,
      cycleCount,
      usage,
      error: effectiveError
        ? {
            code: errorCode,
            message: readString(effectiveError.message) || "Subagent run did not complete cleanly."
          }
        : null
    },
    summary: effectiveError
      ? `spawn_subagent(${childSessionId}) -> failed: ${errorCode}`
      : `spawn_subagent(${childSessionId}) -> ${status} in ${cycleCount} cycle(s)`
  };
}

function isSuccessfulChildStatus(status) {
  return status === "success" || status === "completed";
}

// AGRUN-296 — extract the child's final answer from the runLoop result
// envelope. ROOT CAUSE of the empty-finalResponse demotion (mis-attributed
// to "Gemini empty completion"): `runLoop` returns `result.output` as a
// TERMINAL OBJECT ({ kind, text, ... }) for every successful finalize/final
// terminal, never a bare string. The previous `readString(childResult.output)`
// therefore ALWAYS returned "" for the finalize path (readString of an object
// is ""), so a child that finalized "PONG" was demoted to
// SUBAGENT_EMPTY_RESPONSE even though it answered. We now read `output.text`
// for genuine terminal kinds, keep a string fallback for back-compat, then
// fall back to lastPlannerFinalText.
//
// The kind-guard is deliberate: a blocked child returns
// output.kind === "approval_required" with text "Approval required before
// running X" — that is NOT a final answer and must not leak as a finalResponse.
function readChildFinalResponse(childResult, runState) {
  const output = childResult && childResult.output;
  const outputText = output && typeof output === "object" && !Array.isArray(output)
    && (output.kind === "final_response" || output.kind === "planner_final")
    ? readString(output.text)
    : readString(output);
  return outputText || readString(runState && runState.lastPlannerFinalText) || "";
}

function failureEnvelope({ code, message, childSessionId, childRunId }) {
  return {
    control: "continue",
    output: {
      kind: "subagent_result",
      childSessionId: childSessionId || null,
      childRunId: childRunId || null,
      status: "failed",
      finalResponse: "",
      cycleCount: 0,
      usage: null,
      error: { code, message }
    },
    summary: `spawn_subagent(invalid) -> ${code}`
  };
}

function collectActionNames(actions) {
  if (!Array.isArray(actions)) return [];
  const names = [];
  for (const action of actions) {
    const name = action && typeof action.name === "string" ? action.name.trim() : "";
    if (name) names.push(name);
  }
  return names;
}

function mergeUniqueStrings(...sources) {
  const out = new Set();
  for (const source of sources) {
    if (Array.isArray(source)) {
      for (const item of source) {
        if (typeof item === "string" && item.trim()) out.add(item.trim());
      }
    }
  }
  return Array.from(out);
}

function readArray(value) {
  return Array.isArray(value) ? value.slice() : [];
}

function readPositiveInteger$b(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export { createSpawnSubagentCapability };
