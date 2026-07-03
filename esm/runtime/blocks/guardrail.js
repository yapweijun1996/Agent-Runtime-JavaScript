import { evaluateActionGuardrailBefore, createActionGuardrailSyntheticResult } from '../action-guardrail-controller.js';

// Action-guardrail preflight block, extracted from action-loop-action.js
// (AGRUN-450 slice 4). Wraps the host-configurable action guardrail: if the
// guardrail decides to block (anything other than allow/warn), this returns a
// synthetic result that short-circuits the action. Fully delegated — no local
// helpers, only the guardrail-controller imports.


function maybeBlockActionGuardrail(options) {
  const runtimeConfig = options && options.runtimeConfig;
  const guardrailConfig = runtimeConfig && runtimeConfig.actionGuardrail;
  const decision = evaluateActionGuardrailBefore(
    options && options.runState && options.runState.actionGuardrail,
    options && options.action,
    options && options.actionArgs,
    guardrailConfig
  );
  if (!decision || decision.action === "allow" || decision.action === "warn") return null;
  const result = createActionGuardrailSyntheticResult(decision);
  if (typeof (options && options.pushStep) === "function") {
    options.pushStep("action-guardrail-blocked", {
      actionName: options.actionName,
      code: decision.code,
      count: decision.count,
      guardrailAction: decision.action
    });
  }
  return { message: decision.message, result };
}

export { maybeBlockActionGuardrail };
