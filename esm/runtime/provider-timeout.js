import { readMaxObservedProviderLatencyMs } from './provider-latency.js';
import { DEFAULT_LLM_TIMEOUT_MS } from '../skills/providers/fetch-resilience.js';

/**
 * AGRUN-212a amendment 2D — Semantic provider-timeout derivation.
 *
 * Why this exists:
 *   The provider layer (openai-browser.js / gemini-browser.js) honors
 *   `request.timeoutMs` and falls back to DEFAULT_LLM_TIMEOUT_MS (60s).
 *   60s is right for short planner turns but breaks long-output
 *   finalize calls when an autopilot plan compacts a large research
 *   context into a single answer. Live test (2026-04-26) confirmed:
 *   plan 5/5 advanced cleanly inside one session.run(), then the
 *   finalize call exceeded 60s composing the comparison table.
 *
 * Why a helper (not a hardcoded bump):
 *   - The right deadline depends on what the call is doing. Planner
 *     cycles need a different budget than finalize (which carries the
 *     full evidence stack and emits the user-visible answer).
 *   - The signal that "this turn is long-running" is structural, not
 *     a knob: a non-empty TodoState plan or long-research report contract
 *     is the signal.
 *   - Hosts can still pin an explicit `request.timeoutMs`; this helper
 *     never overrides an explicit value.
 *
 * Contract:
 *   - Pure: same inputs → same number (or null).
 *   - Returns null when the caller should fall through to provider
 *     defaults — keeps the helper additive (no regression for callers
 *     that do not opt in).
 *   - Honors an explicit `baseTimeoutMs` first; the autopilot rule
 *     only applies when the caller has not already chosen a value.
 */


const PLANNER_AUTOPILOT_TIMEOUT_MS = 120_000;
const FINALIZE_AUTOPILOT_TIMEOUT_MS = 180_000;
const LONG_RESEARCH_MIN_LENGTH = 1000;
// AGRUN-568 — adaptive-deadline tunables. FACTOR scales the run's max
// observed successful call duration into the next call's budget; CAP bounds
// both this floor and the retry escalation in provider.js so a genuinely
// hung provider still dies in bounded time.
const ADAPTIVE_TIMEOUT_FACTOR = 2;
const ADAPTIVE_TIMEOUT_CAP_MS = 600_000;

/**
 * @param {object} options
 * @param {object|null} options.runState   - per-turn runState (carries todoState).
 * @param {"planner"|"finalize"} options.kind - which call site is asking.
 * @param {number|null|undefined} [options.baseTimeoutMs] - explicit value
 *   already on `request.timeoutMs`, if any. Returned as-is when present.
 * @returns {number|null}
 */
function deriveProviderTimeoutMs(options) {
  const opts = options && typeof options === "object" ? options : {};
  const explicit = readPositiveInteger$d(opts.baseTimeoutMs);
  if (explicit) return explicit;
  const structural = isLongRunningTurnInPlay(opts.runState)
    ? (opts.kind === "finalize"
      ? FINALIZE_AUTOPILOT_TIMEOUT_MS
      : PLANNER_AUTOPILOT_TIMEOUT_MS)
    : null;
  // AGRUN-568 — adaptive floor from THIS run's observed successful call
  // durations (provider-latency.js). A slow provider (deepseek at ~59 tok/s
  // with hidden reasoning tokens) can legitimately spend 89s on one
  // successful planner cycle; the next cycle's budget must sit comfortably
  // above that, or the run dies on a fixed deadline the provider was never
  // going to meet (captured live failure: 89.3s success, then 120+0.5+120 =
  // 240.5s double-timeout run abort). The floor only ever RAISES the
  // deadline: fast providers' observed calls stay far below the 60s default
  // and the structural 120s/180s budgets, so nothing changes for them.
  // Multiplier 2x: one observed max plus equal headroom — enough to absorb
  // per-call variance without turning a genuinely hung call into a
  // many-minute wait (the cap bounds the worst case).
  const observedMaxMs = readMaxObservedProviderLatencyMs(opts.runState);
  const adaptive = observedMaxMs
    ? Math.min(ADAPTIVE_TIMEOUT_CAP_MS, observedMaxMs * ADAPTIVE_TIMEOUT_FACTOR)
    : null;
  const baseline = structural || DEFAULT_LLM_TIMEOUT_MS;
  if (adaptive && adaptive > baseline) {
    return adaptive;
  }
  return structural;
}

function isLongRunningTurnInPlay(runState) {
  return isAutopilotPlanInPlay(runState)
    || isLongResearchInPlay(runState)
    || isSubstantialWorkspaceInPlay(runState);
}

// F2 (weak-model e2e comparison) — a model-agnostic structural signal. The
// two signals above both depend on the MODEL doing something smart first
// (laying out a todo plan / engaging a skill that forms an acceptance
// packet). A weak model that does neither runs the whole long task at the
// 60s default — live evidence (2026-06-10): deepseek-v4-flash built a
// 1440-word workspace with no todo plan, then died on a single >60s planner
// call. Workspace substance is objective: once the run has accumulated
// LONG_RESEARCH_MIN_LENGTH words (or CJK chars) of drafted content, the
// turn IS long-running regardless of how the model got there.
function isSubstantialWorkspaceInPlay(runState) {
  if (!runState || typeof runState !== "object") return false;
  const workspace = runState.virtualWorkspace;
  const files = workspace && typeof workspace === "object" && workspace.files && typeof workspace.files === "object"
    ? workspace.files
    : null;
  if (!files) return false;
  let words = 0;
  let cjkChars = 0;
  for (const key of Object.keys(files)) {
    const file = files[key];
    const content = typeof file === "string"
      ? file
      : (file && typeof file === "object" && typeof file.content === "string" ? file.content : "");
    if (!content) continue;
    words += (content.match(/[A-Za-z0-9]+(?:[.'_-][A-Za-z0-9]+)*/g) || []).length;
    cjkChars += (content.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g) || []).length;
    // Early exit — the threshold is the only question; never scan more
    // workspace than needed on the per-planner-call hot path.
    if (words >= LONG_RESEARCH_MIN_LENGTH || cjkChars >= LONG_RESEARCH_MIN_LENGTH) return true;
  }
  return false;
}

function isAutopilotPlanInPlay(runState) {
  if (!runState || typeof runState !== "object") return false;
  const todoState = runState.todoState;
  if (!todoState || typeof todoState !== "object") return false;
  if (!Array.isArray(todoState.items) || todoState.items.length === 0) return false;
  // A plan has been laid out for this turn — long output is likely.
  // We elevate even when status === "completed" because the finalize
  // call composing the answer fires immediately after the last advance.
  return todoState.status === "active" || todoState.status === "completed";
}

function isLongResearchInPlay(runState) {
  if (!runState || typeof runState !== "object") return false;
  // AGRUN-313 H2 — the legacy researchActivation mode flag was removed; evidence-convergence
  // is detected via the active research-report-loop gate signal (capability-driven upstream).
  const loop = runState.researchReportLoop && typeof runState.researchReportLoop === "object"
    ? runState.researchReportLoop
    : null;
  const gateSignal = loop && loop.gateSignal && typeof loop.gateSignal === "object"
    ? loop.gateSignal
    : null;
  const packet = gateSignal && gateSignal.acceptancePacket && typeof gateSignal.acceptancePacket === "object"
    ? gateSignal.acceptancePacket
    : null;
  const requested = packet && packet.requestedLength && typeof packet.requestedLength === "object"
    ? packet.requestedLength
    : null;
  const requestedValue = readPositiveInteger$d(requested && requested.value);
  return Boolean(requestedValue && requestedValue >= LONG_RESEARCH_MIN_LENGTH);
}

function readPositiveInteger$d(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0) return null;
  return Math.floor(value);
}

const PROVIDER_TIMEOUT_DEFAULTS = Object.freeze({
  PLANNER_AUTOPILOT_TIMEOUT_MS,
  FINALIZE_AUTOPILOT_TIMEOUT_MS,
  LONG_RESEARCH_MIN_LENGTH,
  ADAPTIVE_TIMEOUT_FACTOR,
  ADAPTIVE_TIMEOUT_CAP_MS
});

export { PROVIDER_TIMEOUT_DEFAULTS, deriveProviderTimeoutMs };
