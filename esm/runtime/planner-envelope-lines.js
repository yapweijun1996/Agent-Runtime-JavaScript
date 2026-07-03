import { resolvePlannerMode } from './provider-capabilities.js';
import { EXECUTE_SKILL_TOOL_ACTION } from './action-names.js';
import { formatStandalonePlanActionNames } from './action-plan-contract.js';
import { resolveTerminalAvailability } from './terminal-repair/availability.js';
import { readString } from './semantic-json.js';

function buildEnvelopeLines(availableActions, options) {
  const actionDefinitions = Array.isArray(availableActions) ? availableActions : [];
  const terminalPolicy = readEnvelopeTerminalPolicy(actionDefinitions, options);
  const compactExamples = options && options.compactExamples === true;
  const envelopeLines = ["Valid envelopes:"];

  if (compactExamples) {
    envelopeLines.push('{"type":"action","name":"ACTION_NAME","args":{},"reasoning":"..."}');
    if (actionDefinitions.some((action) => action.decisionType === "clarify")) {
      envelopeLines.push('{"type":"clarify","question":"...","reasoning":"..."}');
    }
    const actionArgsReference = buildCompactActionArgsReference(actionDefinitions);
    if (actionArgsReference) {
      envelopeLines.push(actionArgsReference);
    }
  } else {
    for (const action of actionDefinitions) {
      if (action.decisionType === "clarify") {
        envelopeLines.push('{"type":"clarify","question":"...","reasoning":"..."}');
        continue;
      }

      envelopeLines.push(JSON.stringify({
        args: action.argsExample || {},
        name: action.name,
        reasoning: "...",
        type: "action"
      }));

      // Append extra envelope examples (e.g. user-configured toolCallExamples
      // for execute_skill_tool) so the model sees multiple real-world formats.
      if (Array.isArray(action.extraExamples)) {
        for (const ex of action.extraExamples) {
          envelopeLines.push(JSON.stringify({
            args: { skillName: ex.skillName, toolName: ex.toolName, args: ex.args || {} },
            name: action.name,
            reasoning: "...",
            type: "action"
          }));
        }
      }
    }
  }

  if (actionDefinitions.some((action) => action.name === EXECUTE_SKILL_TOOL_ACTION)) {
    const standaloneActionNames = formatStandalonePlanActionNames(actionDefinitions);
    envelopeLines.push(`Plan envelope actions must be independent non-mutating tool calls that do not require approval (actionPolicy=allow). Actions marked standalone-only by action metadata must not appear inside plan.actions: ${standaloneActionNames}. Approval-gated actions must also be standalone.`);
    envelopeLines.push(compactExamples
      ? '{"type":"plan","actions":[{"type":"action","name":"ACTION_NAME","args":{},"reasoning":"..."}],"partial_ok":false,"reasoning":"..."}'
      : JSON.stringify({
        actions: [
          {
            args: {
              args: {},
              skillName: "skill-name",
              toolName: "first_tool"
            },
            name: EXECUTE_SKILL_TOOL_ACTION,
            reasoning: "...",
            section: {
              prompt: "Write this result as a complete markdown section.",
              title: "## First Section"
            },
            type: "action"
          },
          {
            args: {
              args: {},
              skillName: "skill-name",
              toolName: "second_tool"
            },
            name: EXECUTE_SKILL_TOOL_ACTION,
            reasoning: "...",
            section: {
              prompt: "Write this result as a complete markdown section.",
              title: "## Second Section"
            },
            type: "action"
          }
        ],
        partial_ok: false,
        reasoning: "Run independent tool actions in parallel.",
        stitch: {
          drill_hints: [
            {
              label: "Open details",
              match_header: "Customer",
              prompt: "Show details for {value}"
            }
          ],
          followups: ["Compare prior period"],
          intro_prompt: "Write a short executive summary using all section evidence.",
          outro_prompt: "Write data-backed recommendations.",
          provenance: "_Source: planned tool results_",
          result_budget: { per_action: 8000 }
        },
        result_budget: {
          history_entry: 8000,
          last_result: 10000
        },
        synthesize_per_action: true,
        synthesize_instruction: "Synthesize the planned tool results into the requested answer.",
        type: "plan"
      }));
  }

  if (terminalPolicy.allowFinalize) {
    envelopeLines.push(compactExamples
      ? '{"type":"finalize","instruction":"...","reasoning":"...","finalReadiness":{"decision":"ready","evidenceMode":"read_sources","limitations":"","requirementsAssessment":{"requirementSatisfied":true,"summary":"..."}}}'
      : '{"type":"finalize","instruction":"...","reasoning":"...","finalReadiness":{"decision":"ready","evidenceMode":"read_sources","limitations":"","requirementsAssessment":{"userRequirementSummary":"The user requested an answer with concrete output requirements.","requirementSatisfied":true,"lengthSatisfied":true,"observedLengthUnit":"chars","successfulReadUrlCount":3,"evidenceSatisfied":true,"checkedReadinessAgainstUserRequest":true,"checkedWorkspaceStats":true,"checkedReadUrlEvidence":true,"remainingGaps":[],"summary":"I judge the answer meets the user request using observed workspace stats and read sources."}}}');
    envelopeLines.push(compactExamples
      ? '{"type":"finalize","instruction":"...","reasoning":"...","finalReadiness":{"decision":"limited","evidenceMode":"search_summary_only","limitations":"...","requirementsAssessment":{"requirementSatisfied":false,"summary":"..."}}}'
      : '{"type":"finalize","instruction":"...","reasoning":"...","finalReadiness":{"decision":"limited","evidenceMode":"search_summary_only","limitations":"Successful read_url evidence is unavailable; final answer must disclose this limitation.","requirementsAssessment":{"userRequirementSummary":"The user requested an answer with concrete output requirements.","requirementSatisfied":false,"lengthSatisfied":false,"observedLengthUnit":"chars","successfulReadUrlCount":0,"evidenceSatisfied":false,"checkedReadinessAgainstUserRequest":true,"checkedWorkspaceStats":true,"checkedReadUrlEvidence":true,"remainingGaps":["read_url evidence unavailable","draft below requested requirement"],"summary":"I judge the answer is limited and will disclose the limitation."}}}');
  } else {
    envelopeLines.push(`Terminal finalize envelope is unavailable now: ${terminalPolicy.reason}. Choose a tool action, especially workspace_publish_candidate when a workspace candidate exists.`);
  }
  envelopeLines.push('For type:"plan", run the listed tool actions and then continue to the next decision cycle. Do not put finalReadiness on plan; use type:"finalize" with finalReadiness only when YOU are ready to answer or stop with limitations.');
  envelopeLines.push("Use the final envelope only for simple no-tool answers. If a loaded skill workflow, read_url evidence, virtual workspace drafting, or readiness contract is active, use finalize with finalReadiness or continue tool work.");
  envelopeLines.push('{"type":"final","answer":"...","citations":["..."],"reasoning":"..."}');
  return envelopeLines;
}

function buildCompactActionArgsReference(actionDefinitions) {
  const entries = actionDefinitions
    .filter((action) => action && action.decisionType !== "clarify")
    .map((action) => {
      const name = readString(action.name);
      if (!name) return null;
      return `${name} args=${JSON.stringify(action.argsExample || {})}`;
    })
    .filter(Boolean);
  return entries.length > 0 ? `Action args examples: ${entries.join("; ")}` : "";
}

function readEnvelopeTerminalPolicy(availableActions, options) {
  const actionDefinitions = Array.isArray(availableActions) ? availableActions : [];
  const opts = options && typeof options === "object" ? options : {};
  const modeSelection = readEnvelopeModeSelection(opts);
  // AGRUN-551 — disable finalize to force the publish path ONLY when publish is
  // actually executable. If workspace_publish_candidate is gated (publishCandidate
  // gate active with no evidence-convergence / publish-readiness opt-in and no
  // terminal-repair override), disabling finalize would leave the model with NO
  // terminal at all — it cannot publish (gated) and cannot finalize — so it loops
  // on invalid terminals (publish_candidate_gated + finalize_not_allowed) to the
  // deadline and returns EMPTY (deepseek-v4-flash high, live 2026-06-25 repro-1).
  // When publish is gated, keep finalize available so the model always has one
  // terminal path; the runtime finalizer delivers the drafted answer.
  //
  // AGRUN-559 — that rule now lives in resolveTerminalAvailability, the SSOT
  // fact object every terminal door consults, so this prompt-side policy can
  // never again disagree with the dispatch-side publish gate (the AGRUN-551
  // bug shape: two gates reading different input bags).
  const availability = resolveTerminalAvailability(opts.runState, {
    availableActions: actionDefinitions,
    runtimeConfig: opts.runtimeConfig,
    activeAgentSkill: opts.activeAgentSkill,
    lastReadAgentSkill: opts.lastReadAgentSkill
  });
  if (!availability.finalizeOpen) {
    return Object.freeze({
      allowFinalize: false,
      effectivePlannerMode: modeSelection.effectiveMode,
      reason: availability.finalizeClosedReason
    });
  }

  return Object.freeze({
    allowFinalize: true,
    effectivePlannerMode: modeSelection.effectiveMode,
    reason: "runtime_finalize_allowed"
  });
}

function readEnvelopeModeSelection(opts) {
  const effectivePlannerMode = readString(opts.effectivePlannerMode);
  if (effectivePlannerMode === "native_tools" || effectivePlannerMode === "envelope") {
    return Object.freeze({
      configuredMode: readString(opts.plannerMode) || "auto",
      effectiveMode: effectivePlannerMode,
      reason: readString(opts.plannerModeReason) || "caller_effective_mode"
    });
  }

  // resolvePlannerMode is a pure function of configuredMode only (explicit ->
  // that mode; auto -> envelope). It does NOT branch on actions/model/provider —
  // those were a model-name heuristic removed in AGRUN-294I/ADR-0033. Passing
  // them here was dead API surface (AGRUN-416).
  return resolvePlannerMode({
    configuredMode: opts.plannerMode
  });
}

export { buildEnvelopeLines, readEnvelopeTerminalPolicy };
