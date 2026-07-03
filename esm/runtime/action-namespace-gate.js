import { isEvidenceConvergenceRun } from './convergence-activation.js';
import { PUBLISH_DIRECT_ACTION, WORKSPACE_REVIEW_CANDIDATE_ACTION, FINALIZE_CANDIDATE_ACTION, WORKSPACE_MULTI_EDIT_ACTION, WORKSPACE_MOVE_ACTION, WORKSPACE_REMOVE_ACTION, WORKSPACE_INSERT_AFTER_SECTION_ACTION, WORKSPACE_APPLY_PATCH_ACTION, WORKSPACE_PROPOSE_PATCH_ACTION, WORKSPACE_REPLACE_ACTION, WORKSPACE_WRITE_ACTION, WORKSPACE_READ_ACTION, WORKSPACE_LIST_ACTION } from './action-names.js';

// ADR-0057 Phase 0+1 (AGRUN-565) — deferred action loading: the namespace
// mechanism's single source of truth (membership map + manifest + closed-
// namespace gate predicate + open-state writers + prompt hint-line renderer).
//
// PHASE 1 WIRING (CLAUDE.md "Dispatch-Path Parity" rule): the gate predicate
// below is deliberately a shared module so BOTH dispatch doors import THIS
// function instead of inlining the check twice:
//   - single-action door: action-loop-session-loop.js, beside the existing
//     isDecisionActionAvailable disabled-check;
//   - plan-batch door: action-loop-plan-validation.js, beside isActionAvailable
//     / validateRuntimeActionSurface (availability precedes policy);
//   - prompt/catalog: planner-action-surface.js subtracts closed-namespace
//     members from the per-cycle planner catalog (so hasAction() gates and
//     both catalog renderings shrink for free), and planner-prompt.js renders
//     renderClosedNamespaceHintLines for the currently-closed namespaces.
//
// Like action-names.js, this module imports ONLY pure data plus the leaf
// capability reader convergence-activation.js (zero imports itself), so it
// can be imported from any of those sites without a cycle.
//
// Namespace membership is declarative data, not a classifier: the runtime
// never guesses which namespaces a task needs — the AI opens a deferred
// namespace explicitly via open_action_namespace (Phase 1). Only the
// `workspace` namespace exists in Phase 0/1; `research` and `todo` are
// Phase 2 (ADR-0057 §7).


const WORKSPACE_NAMESPACE = "workspace";

// Action name → namespace name for every namespaced built-in action. Actions
// absent from this map are namespace-less = always-on (the skill catalog trio,
// execute_skill_tool, ask_clarification, handoff_to_skill, spawn_subagent,
// repo_*, and all host custom actions — ADR-0057 §1).
const BUILT_IN_ACTION_NAMESPACES = Object.freeze({
  [WORKSPACE_LIST_ACTION]: WORKSPACE_NAMESPACE,
  [WORKSPACE_READ_ACTION]: WORKSPACE_NAMESPACE,
  [WORKSPACE_WRITE_ACTION]: WORKSPACE_NAMESPACE,
  [WORKSPACE_REPLACE_ACTION]: WORKSPACE_NAMESPACE,
  [WORKSPACE_PROPOSE_PATCH_ACTION]: WORKSPACE_NAMESPACE,
  [WORKSPACE_APPLY_PATCH_ACTION]: WORKSPACE_NAMESPACE,
  [WORKSPACE_INSERT_AFTER_SECTION_ACTION]: WORKSPACE_NAMESPACE,
  [WORKSPACE_REMOVE_ACTION]: WORKSPACE_NAMESPACE,
  [WORKSPACE_MOVE_ACTION]: WORKSPACE_NAMESPACE,
  [WORKSPACE_MULTI_EDIT_ACTION]: WORKSPACE_NAMESPACE,
  [FINALIZE_CANDIDATE_ACTION]: WORKSPACE_NAMESPACE,
  [WORKSPACE_REVIEW_CANDIDATE_ACTION]: WORKSPACE_NAMESPACE,
  [PUBLISH_DIRECT_ACTION]: WORKSPACE_NAMESPACE
});

// One entry per declared namespace. `description` is the ONLY text a closed
// namespace costs in the prompt (rendered by renderClosedNamespaceHintLines),
// so keep it to 1-2 terse lines. Host-overridable via the ADR-0035 prompts map
// convention once Phase 1 wires the renderer into the prompt builder.
const ACTION_NAMESPACE_MANIFEST = Object.freeze([
  Object.freeze({
    description: "draft, edit, review and publish long multi-section deliverables in a virtual file workspace. Open before any multi-section drafting.",
    name: WORKSPACE_NAMESPACE
  })
]);

const NAMESPACE_DESCRIPTIONS = new Map(
  ACTION_NAMESPACE_MANIFEST.map((entry) => [entry.name, entry.description])
);

// ADR-0057 Phase 1 §4 — the ONE structured-observation code both dispatch
// doors emit for a closed-namespace rejection. Deliberately identical on the
// single-action door (pushStep type detail + actionHistory kind) and the
// plan-batch door (planner_feedback.code) so plan feedback and single-action
// feedback are word-for-word consistent — the condition is the same on both
// doors, unlike the `_in_plan`-suffixed codes for plan-specific rules.
const ACTION_NAMESPACE_CLOSED_CODE = "action_namespace_closed";

// Declared namespace for an action name, or null for namespace-less actions.
// hasOwnProperty guard: AI-emitted names like "constructor" must not walk the
// Object prototype chain into a truthy non-namespace value.
function getActionNamespace(actionName) {
  const name = typeof actionName === "string" ? actionName.trim() : "";
  if (!name || !Object.prototype.hasOwnProperty.call(BUILT_IN_ACTION_NAMESPACES, name)) {
    return null;
  }
  return BUILT_IN_ACTION_NAMESPACES[name];
}

// The shared two-door gate predicate (ADR-0057 §4). Pure function, no side
// effects: `null` means the action is not behind a closed namespace (either
// namespace-less, not deferred by the host, already opened this run, or
// implicitly open per §5); otherwise returns `{namespace, hint}` where `hint`
// is the recoverable structured-observation text BOTH doors must surface
// word-for-word.
function resolveClosedNamespaceForAction(runState, runtimeConfig, actionName) {
  const namespace = getActionNamespace(actionName);
  if (!namespace) return null;
  if (!isNamespaceClosed(runState, runtimeConfig, namespace)) return null;
  return {
    hint: `${actionName.trim()} is in the closed namespace '${namespace}'; call open_action_namespace {namespace:'${namespace}'} first.`,
    namespace
  };
}

// Currently-closed namespace names for the current run, in manifest order.
// Feeds renderClosedNamespaceHintLines and the prompt-side catalog filter's
// callers; shares the exact open/closed logic with the door predicate above
// so the hint can never disagree with the doors.
function listClosedNamespaces(runState, runtimeConfig) {
  const deferred = readDeferredNamespaces(runtimeConfig);
  if (deferred.size === 0) return [];
  return ACTION_NAMESPACE_MANIFEST
    .map((entry) => entry.name)
    .filter((name) => deferred.has(name) && isNamespaceClosed(runState, runtimeConfig, name));
}

// True for names declared in ACTION_NAMESPACE_MANIFEST — the validation
// surface for open_action_namespace args and createRuntime({deferredNamespaces}).
function isKnownActionNamespace(name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return Boolean(trimmed) && NAMESPACE_DESCRIPTIONS.has(trimmed);
}

// ADR-0057 §3 — per-run open-state slot owner. Creates/repairs
// `runState.actionNamespaceContext` ({ deferred, opened }) beside
// agentSkillContext. Idempotent: an existing `opened` map (e.g. a resumed
// crash-recovery runState) is preserved; `deferred` is re-mirrored from
// runtimeConfig for observability (the gate itself always reads
// runtimeConfig.deferredNamespaces, never this copy).
function ensureActionNamespaceContext(runState, runtimeConfig) {
  if (!runState || typeof runState !== "object") return null;
  let context = runState.actionNamespaceContext;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    context = { deferred: [], opened: {} };
    runState.actionNamespaceContext = context;
  }
  if (!context.opened || typeof context.opened !== "object" || Array.isArray(context.opened)) {
    context.opened = {};
  }
  context.deferred = [...readDeferredNamespaces(runtimeConfig)];
  return context;
}

// The ONLY writer of `actionNamespaceContext.opened` (called by the
// open_action_namespace action). Opening is idempotent — re-opening keeps
// the original openedAtCycle and reports alreadyOpen.
function markActionNamespaceOpened(runState, runtimeConfig, namespace) {
  const context = ensureActionNamespaceContext(runState, runtimeConfig);
  if (!context) return null;
  const name = typeof namespace === "string" ? namespace.trim() : "";
  if (!name) return null;
  const alreadyOpen =
    Object.prototype.hasOwnProperty.call(context.opened, name) && Boolean(context.opened[name]);
  if (!alreadyOpen) {
    context.opened[name] = {
      openedAtCycle: runState && Number.isInteger(runState.cycleCount) ? runState.cycleCount : 0
    };
  }
  const record = context.opened[name];
  return {
    alreadyOpen,
    namespace: name,
    openedAtCycle: record && typeof record === "object" && Number.isInteger(record.openedAtCycle)
      ? record.openedAtCycle
      : 0
  };
}

// Prompt hint line(s) for the currently-closed namespaces (ADR-0057 §2) —
// one line naming every closed namespace with its manifest description, or []
// when nothing is closed. Pure renderer: it does not decide what is closed;
// the caller passes the computed closed set.
function renderClosedNamespaceHintLines(closedNamespaces) {
  const names = [];
  const seen = new Set();
  for (const entry of Array.isArray(closedNamespaces) ? closedNamespaces : []) {
    const name = typeof entry === "string" ? entry.trim() : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  if (names.length === 0) return [];
  const rendered = names.map((name) => {
    const description = NAMESPACE_DESCRIPTIONS.get(name);
    return description ? `${name} (${description})` : name;
  });
  return [
    `Closed action namespaces: ${rendered.join(", ")}. Call open_action_namespace with the namespace name before using its actions.`
  ];
}

function readDeferredNamespaces(runtimeConfig) {
  const list = runtimeConfig && typeof runtimeConfig === "object"
    ? runtimeConfig.deferredNamespaces
    : null;
  if (!Array.isArray(list)) return new Set();
  return new Set(
    list
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean)
  );
}

// The single closed/open decision shared by the door predicate, the prompt
// hint, and the catalog filter. Order: host deferral → explicit open →
// §5 state-driven implicit open.
function isNamespaceClosed(runState, runtimeConfig, namespace) {
  if (!readDeferredNamespaces(runtimeConfig).has(namespace)) return false;
  if (isNamespaceOpened(runState, namespace)) return false;
  if (isNamespaceImplicitlyOpen(runState, namespace)) return false;
  return true;
}

// `runState.actionNamespaceContext` may be absent (pre-Phase-1 checkpoints,
// bare test runStates), so every layer is read defensively.
function isNamespaceOpened(runState, namespace) {
  const context = runState && typeof runState === "object"
    ? runState.actionNamespaceContext
    : null;
  const opened = context && typeof context === "object" ? context.opened : null;
  if (!opened || typeof opened !== "object") return false;
  return Object.prototype.hasOwnProperty.call(opened, namespace) && Boolean(opened[namespace]);
}

// ADR-0057 §5 — state-driven auto-open (data-gated, not a classifier). When
// runtime state the AI's own earlier actions created already hands the AI a
// contract naming a namespace's actions, the namespace is treated as open so
// that contract can never deadlock behind the gate:
//   1. An ACTIVE terminal-repair contract whose allowedActions lists a member
//      of the namespace (terminal-repair-state.js writes that list; the
//      repair surface owns the catalog while active — planner-action-surface's
//      allowlist early-return is the prompt-side twin of this rule).
//   2. For the workspace namespace: an engaged evidence-convergence run
//      (isEvidenceConvergenceRun — the SAME capability signal the AGRUN-256
//      publish gate already uses to expose workspace_publish_candidate, and
//      the activation signal of the research report loop, whose contract
//      assumes workspace drafting).
// Honest limit (flagged in the Phase 1 report): a thread-hydrated
// researchReportLoop slice WITHOUT a re-engaged skill context has no clean
// exported runState signal today; that continuation costs one explicit
// re-open round-trip instead of inventing a proxy reader here.
function isNamespaceImplicitlyOpen(runState, namespace) {
  if (hasRepairContractNamingNamespace(runState, namespace)) return true;
  if (namespace === WORKSPACE_NAMESPACE && isEvidenceConvergenceRun(runState)) return true;
  return false;
}

function hasRepairContractNamingNamespace(runState, namespace) {
  const state = runState && typeof runState === "object" ? runState.terminalRepairState : null;
  if (!state || typeof state !== "object" || state.active !== true) return false;
  const allowed = Array.isArray(state.allowedActions) ? state.allowedActions : [];
  return allowed.some((name) => getActionNamespace(name) === namespace);
}

export { ACTION_NAMESPACE_CLOSED_CODE, ACTION_NAMESPACE_MANIFEST, BUILT_IN_ACTION_NAMESPACES, WORKSPACE_NAMESPACE, ensureActionNamespaceContext, getActionNamespace, isKnownActionNamespace, listClosedNamespaces, markActionNamespaceOpened, renderClosedNamespaceHintLines, resolveClosedNamespaceForAction };
