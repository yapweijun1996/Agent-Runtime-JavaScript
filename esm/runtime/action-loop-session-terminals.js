import './tool-schema.js';
import './action-pattern-convergence.js';
import './runtime-event-classifier.js';
import { analyzeFinalResponseQuality, noteFinalResponseQualityIssues } from './final-response-quality.js';
import { handlePlannerFinal, handleDirectFinal } from './action-loop-terminal.js';
import { executeRuntimeFinalize } from './runtime-finalize.js';
import { prepareDirectFinalResult } from './direct-final-result.js';
import { callHostHookWithTimeout } from './host-hook-timeout.js';
import { readString } from './semantic-json.js';

// ADR-0023 — Harness-as-tool-provider. The runtime must not re-prompt the LLM
// with runtime-authored repair instructions or synthesize the next research
// action.
//
// ADR-0026 — Zero residual push-mode. The last two fail-safe pushes
// (`maybeEnforceConsecutiveFailureGuard` and `maybeApplySingleToolFastPath`)
// were deleted. Their replacement is a read-only signal:
//   - Consecutive same-action failures surface as
//     `runState.actionFailureSignal` and `loopState.actionFailureSignal`.
//     AI decides whether to switch tactics, finalize, or keep retrying.
//   - First-tool-success no longer skips the next planner cycle. AI plans
//     cycle 2 normally and either calls `finalize` (yields
//     `planner_finalize`) or takes another action.
//
// 2026-06-09 — finalize-contract hook seam removed. Runtime now honors the
// AI's final/finalize decision directly; it must not force another evidence
// cycle based on missing, limited, or conflicting readiness markers.
//
// Quality issues still surface as a SIGNAL via
// `noteFinalResponseQualityIssues` → runState.finalResponseQuality.lastIssues
// → loopState.qualityContext (next cycle, if any). Hosts that want the
// legacy veto behavior wire it via the `onBeforeFinalize` host hook
// directly — the deleted helpers (maybeCreateTodoAutopilotVeto, etc.) are
// still exported from their own modules.

async function handlePlannerFinalDecision(session, cycleRecord, decision, plannerResult) {
  const veto = await consultBeforeFinalizeHook(session, "planner_final");
  if (veto) return veto;
  capturePlannerFinalText(session, decision);
  noteQualityIssuesAsSignal(session, decision, "planner_final");
  return {
    action: "done",
    result: handlePlannerFinal({
      cycleRecord,
      decision,
      memoryEntriesAdded: session.memoryEntriesAdded,
      normalizedInput: session.normalizedInput,
      pushStep: session.pushStep,
      rawInput: session.rawInput,
      request: session.request,
      response: plannerResult.response,
      runState: session.runState,
      runtimeState: session.runtimeState,
      steps: session.steps
    })
  };
}

async function handlePlannerFinalizeDecision(session, cycleRecord, decision) {
  const veto = await consultBeforeFinalizeHook(session, "planner_finalize");
  if (veto) return veto;
  noteQualityIssuesAsSignal(session, decision, "planner_finalize");
  return {
    action: "done",
    result: await executeRuntimeFinalize({
      agentRole: session.runtimeConfig.agentRole,
      runtimeConfig: session.runtimeConfig,
      cycleRecord,
      decision,
      memoryEntriesAdded: session.memoryEntriesAdded,
      normalizedInput: session.normalizedInput,
      onStreamEvent: session.onStreamEvent,
      onToken: session.onToken,
      pushStep: session.pushStep,
      rawInput: session.rawInput,
      request: session.request,
      runState: session.runState,
      runtimeState: session.runtimeState,
      steps: session.steps,
      // ADR-0025 — AI emitted finalize decision; this is AI-driven, not runtime push.
      terminalSource: "planner_finalize"
    })
  };
}

// AGRUN-457 — activate the `onBeforeFinalize` host hook seam. The 2026-06-09
// seam removal (above) points hosts at this hook for veto behavior, but the
// hook was plumbed (runtime.js → session) and never invoked. The contract is
// the one already published in agrun_docs/public-runtime-api.md:
//   async (runState, { source }) => { continue: true, observation? } | null
// `{ continue: true }` converts the terminal into a continue; the observation
// rides actionHistory AND runState.observation so the AI sees WHY on the next
// cycle and re-decides (the runtime itself still never authors veto policy;
// the host does). Any other return value, and any hook throw, proceeds with
// the AI's decision unchanged. Wired sources: `planner_finalize`,
// `planner_final` (here), `plan_finalize` / plan-path `direct_final`
// (action-loop-plan.js via continueAfterPlanObservation), and skill-tool
// `direct_final` (maybeHandleDirectFinalAfterSkillTool below).
//
// `askBeforeFinalizeHook` is the shared low-level consult: it calls the hook,
// guards throws, and pushes the uniform `finalize-vetoed-by-host` step.
// Loop-state bookkeeping (actionHistory / runState.observation / phase
// closure) stays with each call site, because the plan path must route
// through `continueAfterPlanObservation` for correct act-phase closure.
async function askBeforeFinalizeHook(session, terminalSource) {
  if (typeof session.onBeforeFinalize !== "function") return null;
  // Raced — a hung host hook degrades to "no veto", never freezes the loop.
  const hook = await callHostHookWithTimeout(
    () => session.onBeforeFinalize(session.runState, { source: terminalSource }),
    {
      hookName: "onBeforeFinalize",
      timeoutMs: session.runtimeConfig && session.runtimeConfig.hostHookTimeoutMs
    }
  );
  if (!hook.ok) {
    session.debug.log(`onBeforeFinalize hook ${hook.timedOut ? "timed out" : "threw"}`, {
      error: hook.message
    });
    return null;
  }
  const verdict = hook.value;
  if (!verdict || typeof verdict !== "object" || verdict.continue !== true) return null;
  const observation = readString(verdict.observation)
    || "host vetoed the finalize decision; continue working the task";
  session.pushStep("finalize-vetoed-by-host", {
    cycle: session.runState.cycleCount,
    observation,
    source: terminalSource
  });
  return observation;
}

async function consultBeforeFinalizeHook(session, terminalSource) {
  const observation = await askBeforeFinalizeHook(session, terminalSource);
  if (!observation) return null;
  session.actionHistory.push({
    kind: "finalize_vetoed_by_host",
    summary: observation
  });
  session.runState.observation = {
    kind: "hint",
    message: observation
  };
  return { action: "continue" };
}

function noteQualityIssuesAsSignal(session, decision, sourceLabel) {
  noteFinalResponseQualityIssues(session.runState, { decision, source: sourceLabel });
  if (
    session.runState.finalResponseQuality
    && Array.isArray(session.runState.finalResponseQuality.lastIssues)
    && session.runState.finalResponseQuality.lastIssues.length > 0
  ) {
    session.pushStep("final-response-quality-noted", {
      issues: session.runState.finalResponseQuality.lastIssues,
      noteCount: session.runState.finalResponseQuality.vetoCount,
      source: sourceLabel
    });
  }
}

function capturePlannerFinalText(session, decision) {
  const runState = session && session.runState;
  if (!runState) return;
  const answer = decision && typeof decision.answer === "string" ? decision.answer.trim() : "";
  if (answer.length < 80) return;
  const quality = analyzeFinalResponseQuality(answer, {
    prompt: session.request && session.request.prompt,
    researchEvidenceGraph: runState.researchEvidenceGraph,
    researchReportLoop: runState.researchReportLoop,
    researchState: runState.researchState,
    researchWorkspace: runState.researchWorkspace,
    virtualWorkspace: runState.virtualWorkspace
  });
  if (!quality || !quality.ok) return;
  runState.lastPlannerFinalText = answer;
  session.pushStep("planner-final-text-captured", {
    cycle: runState.cycleCount,
    length: answer.length,
    source: "planner_final"
  });
}

async function maybeHandleDirectFinalAfterSkillTool(session, cycleRecord, actionName) {
  if (actionName !== "execute_skill_tool") return null;
  const directFinal = prepareDirectFinalResult(session.runState.toolContext.lastResult);
  if (directFinal.kind === "ready") {
    // AGRUN-457 — `direct_final` source. The skill tool's own action
    // bookkeeping already completed; a veto just declines the terminal
    // promotion, records WHY, and lets the loop continue normally.
    const vetoObservation = await askBeforeFinalizeHook(session, "direct_final");
    if (vetoObservation) {
      session.actionHistory.push({
        kind: "finalize_vetoed_by_host",
        summary: vetoObservation
      });
      session.runState.observation = {
        kind: "hint",
        message: vetoObservation
      };
      return null;
    }
    return handleDirectFinal({
      cycleRecord,
      directFinal,
      memoryEntriesAdded: session.memoryEntriesAdded,
      normalizedInput: session.normalizedInput,
      onToken: session.onToken,
      pushStep: session.pushStep,
      rawInput: session.rawInput,
      request: session.request,
      runState: session.runState,
      runtimeState: session.runtimeState,
      steps: session.steps,
      toolResult: session.runState.toolContext.lastResult
    });
  }
  if (directFinal.kind === "invalid") {
    session.debug.log("direct final skipped", {
      reason: directFinal.reason
    });
    session.pushStep("direct-final-skipped", {
      actionName,
      cycle: session.runState.cycleCount,
      reason: directFinal.reason
    });
  }
  return null;
}

export { askBeforeFinalizeHook, handlePlannerFinalDecision, handlePlannerFinalizeDecision, maybeHandleDirectFinalAfterSkillTool };
