import { fingerprintAction, stableStringify, djb2Hash } from './action-fingerprint.js';

const DEFAULT_EXACT_FAILURE_BLOCK_AFTER = 3;
const DEFAULT_SAME_ACTION_FAILURE_WARN_AFTER = 2;
const DEFAULT_SAME_ACTION_FAILURE_HALT_AFTER = 5;
const DEFAULT_NO_PROGRESS_WARN_AFTER = 2;
const DEFAULT_NO_PROGRESS_BLOCK_AFTER = 4;

function normalizeActionGuardrailConfig(value) {
  if (value == null || value === false) {
    return { enabled: false };
  }
  const source = value === true ? {} : (value && typeof value === "object" && !Array.isArray(value) ? value : {});
  return {
    enabled: source.enabled !== false,
    hardStop: source.hardStop !== false,
    exactFailureBlockAfter: readPositiveInteger$l(source.exactFailureBlockAfter, DEFAULT_EXACT_FAILURE_BLOCK_AFTER),
    sameActionFailureWarnAfter: readPositiveInteger$l(source.sameActionFailureWarnAfter, DEFAULT_SAME_ACTION_FAILURE_WARN_AFTER),
    sameActionFailureHaltAfter: readPositiveInteger$l(source.sameActionFailureHaltAfter, DEFAULT_SAME_ACTION_FAILURE_HALT_AFTER),
    noProgressWarnAfter: readPositiveInteger$l(source.noProgressWarnAfter, DEFAULT_NO_PROGRESS_WARN_AFTER),
    noProgressBlockAfter: readPositiveInteger$l(source.noProgressBlockAfter, DEFAULT_NO_PROGRESS_BLOCK_AFTER)
  };
}

function createActionGuardrailState(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    exactFailureCounts: normalizeCountMap(source.exactFailureCounts),
    latestDecision: normalizeDecision(source.latestDecision),
    noProgress: normalizeNoProgress(source.noProgress),
    sameActionFailureCounts: normalizeCountMap(source.sameActionFailureCounts),
    version: 1
  };
}

function evaluateActionGuardrailBefore(stateValue, action, args, configValue) {
  const config = normalizeActionGuardrailConfig(configValue);
  const state = createActionGuardrailState(stateValue);
  if (!config.enabled || !config.hardStop) return createAllowDecision(action);
  const signature = createActionSignature(action, args);
  const exactCount = state.exactFailureCounts[signature] || 0;
  if (exactCount >= config.exactFailureBlockAfter) {
    return createDecision$2("block", "exact_failure_block", action, exactCount, signature);
  }
  const noProgress = state.noProgress[signature];
  if (noProgress && noProgress.count >= config.noProgressBlockAfter) {
    return createDecision$2("block", "no_progress_block", action, noProgress.count, signature);
  }
  return createAllowDecision(action);
}

// Session-level wrapper shared by BOTH dispatch paths (single action in
// action-loop-action.js, plan batch in action-loop-plan-actions.js): refresh
// the guardrail state on runState, emit the step on a non-allow decision.
// Moved here from action-loop-action.js so the plan path gets the same
// counters (cross-cutting-dispatch-matrix-2026-06-10.md §3).
function refreshActionGuardrail(options) {
  const runtimeConfig = options && options.runtimeConfig;
  const refreshed = refreshActionGuardrailAfter(
    options && options.runState && options.runState.actionGuardrail,
    options && options.action,
    options && options.actionArgs,
    options && options.result,
    runtimeConfig && runtimeConfig.actionGuardrail
  );
  if (options && options.runState) {
    options.runState.actionGuardrail = refreshed.state;
  }
  const decision = refreshed.decision;
  if (decision && decision.action !== "allow" && typeof (options && options.pushStep) === "function") {
    options.pushStep("action-guardrail-refreshed", {
      actionName: options.actionName,
      code: decision.code,
      count: decision.count,
      guardrailAction: decision.action
    });
  }
  return refreshed;
}

function refreshActionGuardrailAfter(stateValue, action, args, result, configValue) {
  const config = normalizeActionGuardrailConfig(configValue);
  const state = createActionGuardrailState(stateValue);
  if (!config.enabled) {
    return { state, decision: createAllowDecision(action) };
  }

  const signature = createActionSignature(action, args);
  const failed = isFailedActionResult(result);
  let decision = createAllowDecision(action);

  if (failed) {
    const exactCount = (state.exactFailureCounts[signature] || 0) + 1;
    const sameCount = (state.sameActionFailureCounts[action.name] || 0) + 1;
    state.exactFailureCounts[signature] = exactCount;
    state.sameActionFailureCounts[action.name] = sameCount;
    if (config.hardStop && sameCount >= config.sameActionFailureHaltAfter) {
      decision = createDecision$2("halt", "same_action_failure_halt", action, sameCount, signature);
    } else if (sameCount >= config.sameActionFailureWarnAfter) {
      decision = createDecision$2("warn", "same_action_failure_warn", action, sameCount, signature);
    }
  } else {
    delete state.exactFailureCounts[signature];
    delete state.sameActionFailureCounts[action.name];
    if (isNoProgressTrackable(action)) {
      const outputHash = createOutputHash(result && result.output);
      const previous = state.noProgress[signature];
      const count = previous && previous.outputHash === outputHash ? previous.count + 1 : 1;
      state.noProgress[signature] = { count, outputHash };
      if (config.hardStop && count >= config.noProgressBlockAfter) {
        decision = createDecision$2("block", "no_progress_block", action, count, signature);
      } else if (count >= config.noProgressWarnAfter) {
        decision = createDecision$2("warn", "no_progress_warn", action, count, signature);
      }
    } else {
      delete state.noProgress[signature];
    }
  }

  state.latestDecision = decision.action === "allow" ? null : decision;
  return { state, decision };
}

function createActionGuardrailSyntheticResult(decision) {
  return {
    control: "continue",
    output: {
      guardrail: decision,
      kind: "action_guardrail_block",
      ok: false,
      reason: decision.code,
      status: "blocked"
    },
    summary: `${decision.actionName || "action"} blocked by action guardrail: ${decision.code}`
  };
}

function isNoProgressTrackable(action) {
  const permission = action && action.permission && typeof action.permission === "object" ? action.permission : {};
  return permission.isReadOnly === true || permission.isConcurrencySafe === true;
}

function isFailedActionResult(result) {
  if (!result || typeof result !== "object") return true;
  const output = result.output && typeof result.output === "object" ? result.output : {};
  if (output.ok === false) return true;
  return readString$1K(output.status) === "failed" || readString$1K(output.status) === "blocked";
}

function createActionSignature(action, args) {
  return fingerprintAction({
    args: args && typeof args === "object" && !Array.isArray(args) ? args : {},
    name: action && action.name,
    type: "action"
  }) || stableStringify({ name: action && action.name, args });
}

function createOutputHash(value) {
  return String(djb2Hash(stableStringify(value == null ? null : value)));
}

function createAllowDecision(action) {
  return createDecision$2("allow", "allow", action, 0, null);
}

function createDecision$2(action, code, actionValue, count, signature) {
  return {
    action,
    actionName: readString$1K(actionValue && actionValue.name) || null,
    code,
    count,
    message: createMessage(action, code, actionValue, count),
    signature
  };
}

function createMessage(action, code, actionValue, count) {
  const name = readString$1K(actionValue && actionValue.name) || "action";
  if (code === "exact_failure_block") return `${name} repeated the same failing arguments ${count} time(s). Choose a different approach.`;
  if (code === "same_action_failure_halt") return `${name} failed ${count} time(s). Stop retrying this action path.`;
  if (code === "same_action_failure_warn") return `${name} has repeated failures. Inspect the failure and change strategy.`;
  if (code === "no_progress_block") return `${name} returned the same no-progress result ${count} time(s). Choose a different action or arguments.`;
  if (code === "no_progress_warn") return `${name} is returning repeated results. Change arguments if more progress is needed.`;
  return "allow";
}

function normalizeDecision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    action: readString$1K(value.action) || "allow",
    actionName: readString$1K(value.actionName) || null,
    code: readString$1K(value.code) || "allow",
    count: readPositiveInteger$l(value.count, 0),
    message: readString$1K(value.message),
    signature: readString$1K(value.signature) || null
  };
}

function normalizeCountMap(value) {
  const output = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return output;
  for (const [key, count] of Object.entries(value)) {
    const normalizedKey = readString$1K(key);
    if (!normalizedKey) continue;
    output[normalizedKey] = readPositiveInteger$l(count, 0);
  }
  return output;
}

function normalizeNoProgress(value) {
  const output = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return output;
  for (const [key, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object") continue;
    const normalizedKey = readString$1K(key);
    const outputHash = readString$1K(entry.outputHash);
    if (!normalizedKey || !outputHash) continue;
    output[normalizedKey] = {
      count: readPositiveInteger$l(entry.count, 0),
      outputHash
    };
  }
  return output;
}

function readPositiveInteger$l(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function readString$1K(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { createActionGuardrailState, createActionGuardrailSyntheticResult, evaluateActionGuardrailBefore, normalizeActionGuardrailConfig, refreshActionGuardrail, refreshActionGuardrailAfter };
