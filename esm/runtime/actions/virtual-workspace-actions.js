import { FINALIZE_CANDIDATE_ACTION, PUBLISH_DIRECT_ACTION, CANDIDATE_QUALITY_BLOCKED_REASON } from '../kernel-terminal-actions.js';
import { buildPublishPrescription } from '../publish-prescription.js';
import { validateWorkspacePath, listWorkspaceFiles, readWorkspaceFile, recordWorkspaceRead, acquireWorkspaceMutex, writeWorkspaceFile, publishWorkspaceEvent, replaceWorkspaceFile, proposeWorkspacePatch, applyWorkspacePatch, insertAfterWorkspaceSection, removeWorkspaceFile, moveWorkspaceFile, finalizeWorkspaceCandidate, inspectWorkspacePublishProtocol, readWorkspaceFinalCandidate, recordWorkspaceCandidateReview, recordWorkspacePublishCandidateLifecycle, ensureVirtualWorkspace } from '../virtual-workspace.js';
import { STANDALONE_PLAN_ACTION } from '../action-plan-contract.js';
import { normalizeFinalReadiness, createFinalReadinessAssessment, countSuccessfulEvidenceArtifacts, countSuccessfulReadUrlArtifacts } from '../final-readiness.js';
import { formatEvidenceRecoveryActions } from '../evidence-policy.js';
import { isResearchQualityGateRequired } from '../convergence-activation.js';
import { inspectLimitedRecoveryReadiness } from '../requirement-recovery-evaluator.js';
import { readFinalSourcePrompt } from '../final-source-prompt.js';
import { appendSourcesSection, filterSourcesByEvidence, collectFinalResponseSources, collectResearchEvidenceUrls, isDirectEvidenceUrl } from '../final-response-sources.js';
import { isReadableEvidenceSource } from '../read-source-quality.js';
import { isValidTerminalRepairPublishArgs, isBudgetConstrainedForLimitedPublish } from '../terminal-repair-state.js';
import { applyTerminalFinalContract, extractRequestedLengthContract, readTerminalContractText, readStatsKeyForUnit } from '../terminal-final-contract.js';
import { buildCitationCoverageAudit, normalizeCandidateQualitySignal, buildCandidateQualitySignal } from '../candidate-quality-signal.js';

const workspaceListAction = Object.freeze({
  description: "List virtual workspace draft files for complex responses. This never reads or writes real files.",
  name: "workspace_list",
  planner: {
    aliases: ["workspace_files", "list_workspace"],
    argsExample: {},
    argsSchema: {},
    decisionType: "action",
    guidance: "Use workspace_list to inspect which virtual draft artifacts exist before relying on workspace content."
  },
  tier: 0,
  execute: executeWorkspaceListAction,
  outputSchema: {
    kinds: ["virtual_workspace_list"],
    controls: ["continue"]
  }
});

const workspaceReadAction = Object.freeze({
  description: "Read one virtual workspace draft file. This is browser-safe and never reads real files.",
  name: "workspace_read",
  planner: {
    aliases: ["read_workspace"],
    argsExample: { path: "draft.md" },
    argsSchema: {
      path: { type: "string", required: true }
    },
    decisionType: "action",
    guidance: "Use workspace_read to review the selected virtual workspace file before revising, finalizing, or publishing it."
  },
  tier: 0,
  execute: executeWorkspaceReadAction,
  preflight: preflightWorkspacePath,
  outputSchema: {
    kinds: ["virtual_workspace_read"],
    controls: ["continue"]
  }
});

const workspaceWriteAction = Object.freeze({
  description: "Write a user-visible draft artifact into the virtual workspace. This never writes real files.",
  name: "workspace_write",
  plan: STANDALONE_PLAN_ACTION,
  planner: {
    aliases: ["write_workspace", "draft_write"],
    argsExample: {
      content: "...",
      path: "draft.md",
      summary: "drafted response body"
    },
    argsSchema: {
      content: { type: "string", required: true },
      path: { type: "string", required: true },
      summary: { type: "string" }
    },
    decisionType: "action",
    guidance: "Use workspace_write to CREATE or fully REPLACE a virtual draft file. CAUTION: workspace_write REPLACES ALL existing content — calling it again on a path that already has substantial content erases that work. Use workspace_write only to start a new file or for a deliberate full rewrite. To expand or improve an existing draft, read it first, then make targeted edits: workspace_insert_after_section to deepen an existing section, workspace_replace to revise text. If a section is thin because you lack real material, gather evidence with the configured host actions before editing. Do not pad to reach a length."
  },
  tier: 0,
  execute: executeWorkspaceWriteAction,
  preflight: preflightWorkspacePath,
  outputSchema: {
    kinds: ["virtual_workspace_write"],
    controls: ["continue"]
  }
});

const workspaceReplaceAction = Object.freeze({
  description: "Replace text inside one virtual workspace draft file. By default requires a unique match; pass replace_all:true to replace every occurrence. This never mutates real files.",
  name: "workspace_replace",
  plan: STANDALONE_PLAN_ACTION,
  planner: {
    aliases: ["replace_workspace", "draft_replace"],
    argsExample: {
      find: "weak claim",
      path: "draft.md",
      replace: "qualified claim",
      summary: "qualified unsupported claim"
    },
    argsSchema: {
      find: { type: "string", required: true },
      path: { type: "string", required: true },
      replace: { type: "string", required: true },
      replace_all: { type: "boolean" },
      summary: { type: "string" }
    },
    decisionType: "action",
    guidance: "Use workspace_replace to improve a draft after critique without rewriting unrelated workspace files. The find text must be unique by default; if it matches multiple times you will get an ambiguous status with contextSnippets and matchCount so you can widen the find text or retry with replace_all:true. On status=not_found the result includes missHints with anchorMatches[*].surroundingText (verbatim file excerpts around the first/last line of your find), bracketLandmarks (real [..]/heading text when your find looked like a placeholder), and documentOutline (headings + first chars) as fallback — use those excerpts to rewrite find with text that exists verbatim in the file, rather than guessing again. If the same find string fails twice in one run the runtime escalates to status=repeated_find_vetoed (repeatedFindCount field shows the count); when you see that, stop guessing find and switch to workspace_propose_patch or workspace_insert_after_section."
  },
  tier: 0,
  execute: executeWorkspaceReplaceAction,
  preflight: preflightWorkspaceMutationRequiresRead,
  outputSchema: {
    kinds: ["virtual_workspace_replace"],
    controls: ["continue"]
  }
});

const workspaceProposePatchAction = Object.freeze({
  description: "Preview a structured patch against one virtual workspace file. For heading-only normalize_headings repair, applyIfValid:true previews and applies the validated patch in one action. Operation shapes: append{content}, insert_after_section{heading,content}, replace{find,replace,replace_all?}, normalize_headings{headings:[{\"lineNumber\":42,\"text\":\"## 4. Unique Heading\"}]}; replace does not accept full-document content.",
  name: "workspace_propose_patch",
  plan: STANDALONE_PLAN_ACTION,
  planner: {
    aliases: ["propose_workspace_patch", "workspace_patch_preview", "draft_propose_patch"],
    argsExample: {
      operations: [
        {
          type: "normalize_headings",
          headings: [
            { lineNumber: 42, text: "## 4. Anti-patterns in Harness Design" }
          ]
        }
      ],
      applyIfValid: true,
      path: "final_candidate.md",
      summary: "preview heading normalization patch"
    },
    argsSchema: {
      applyIfValid: { type: "boolean" },
      operations: { type: "array", required: true },
      path: { type: "string", required: true },
      summary: { type: "string" }
    },
    decisionType: "action",
    guidance: "Use workspace_propose_patch before risky candidate repair. Valid operations are exactly: {type:\"append\",content:\"...\"}, {type:\"insert_after_section\",heading:\"Existing Heading\",content:\"...\"}, {type:\"replace\",find:\"exact current text\",replace:\"new text\",replace_all?:true}, or {type:\"normalize_headings\",headings:[{\"lineNumber\":42,\"text\":\"## 4. Unique Heading\"}]}. Use normalize_headings alone first for duplicate headings/section numbers shown in duplicate_heading_context, duplicate_section_number_context, or section_number_repair_context; runtime changes only those Markdown heading lines and validates structure. For heading-only normalize_headings repair, set applyIfValid:true to avoid a separate workspace_apply_patch cycle; if the preview has blocking riskFlags it will not apply. If length is already satisfied and the visible issue is duplicate heading/section-number context, send exactly one normalize_headings operation. Do not mix normalize_headings with replace unless the exact current find text is visible in the prompt and heading-only repair cannot improve structure. The JSON key must be \"lineNumber\" with a numeric value, not \"lineNumber:42\". Do not send {type:\"replace\",content:\"full document\"}; replace needs find+replace and will be blocked without a non-empty find. If riskFlags include no_growth, not_found, ambiguous, or structure_maybe_worse, revise the patch or use workspace_insert_after_section/workspace_replace only when those actions are currently allowed instead of finalizing."
  },
  tier: 0,
  execute: executeWorkspaceProposePatchAction,
  preflight: preflightWorkspacePath,
  outputSchema: {
    kinds: ["virtual_workspace_propose_patch"],
    controls: ["continue"]
  }
});

const workspaceApplyPatchAction = Object.freeze({
  description: "Apply the latest valid workspace_propose_patch preview using patchId and baseVersion guards.",
  name: "workspace_apply_patch",
  plan: STANDALONE_PLAN_ACTION,
  planner: {
    aliases: ["apply_workspace_patch", "workspace_patch_apply"],
    argsExample: {
      patchId: "patch-1234567890-7",
      summary: "apply previewed expansion"
    },
    argsSchema: {
      patchId: { type: "string" },
      summary: { type: "string" }
    },
    decisionType: "action",
    guidance: "Use workspace_apply_patch only after workspace_propose_patch returned status=preview_ready with positive deltaWords and no blocking riskFlags. It applies only the latest valid pending patch; patchId mismatch, stale baseVersion, invalid preview, no_growth, not_found, ambiguous, or structure_maybe_worse are observable errors."
  },
  tier: 0,
  execute: executeWorkspaceApplyPatchAction,
  outputSchema: {
    kinds: ["virtual_workspace_apply_patch"],
    controls: ["continue"]
  }
});

const workspaceInsertAfterSectionAction = Object.freeze({
  description: "Insert user-visible text after a Markdown section in a virtual workspace draft file.",
  name: "workspace_insert_after_section",
  plan: STANDALONE_PLAN_ACTION,
  planner: {
    aliases: ["workspace_insert_after", "insert_after_section", "draft_insert_after_section"],
    argsExample: {
      content: "Expanded operational details...",
      heading: "Testing and Recovery Loops",
      path: "final_candidate.md",
      summary: "expanded testing section"
    },
    argsSchema: {
      content: { type: "string", required: true },
      heading: { type: "string", required: true },
      path: { type: "string", required: true },
      separator: { type: "string" },
      summary: { type: "string" }
    },
    decisionType: "action",
    guidance: "Use workspace_insert_after_section to deepen a specific existing Markdown section with real, source-grounded content. If the section is thin because you lack material, web_search/read_url first, then insert. If the heading is not found you will get heading_not_found with availableHeadings — pick an existing section to expand; do not invent a renamed duplicate section to add length."
  },
  tier: 0,
  execute: executeWorkspaceInsertAfterSectionAction,
  preflight: preflightWorkspaceMutationRequiresRead,
  outputSchema: {
    kinds: ["virtual_workspace_insert_after_section"],
    controls: ["continue"]
  }
});

const workspaceRemoveAction = Object.freeze({
  description: "Clear a virtual workspace draft file when its content is no longer needed. This never deletes real files.",
  name: "workspace_remove",
  plan: STANDALONE_PLAN_ACTION,
  planner: {
    aliases: ["remove_workspace", "delete_workspace", "workspace_delete"],
    argsExample: {
      path: "draft.md",
      summary: "discarded stale draft"
    },
    argsSchema: {
      path: { type: "string", required: true },
      summary: { type: "string" }
    },
    decisionType: "action",
    guidance: "Use workspace_remove to clear a draft file you no longer need (e.g. obsolete outline before a fresh draft). The file slot remains so you can re-write it later."
  },
  tier: 0,
  execute: executeWorkspaceRemoveAction,
  preflight: preflightWorkspacePath,
  outputSchema: {
    kinds: ["virtual_workspace_remove"],
    controls: ["continue"]
  }
});

const workspaceMoveAction = Object.freeze({
  description: "Rename a virtual workspace file in one step instead of workspace_read → workspace_write → workspace_remove. This never moves real files.",
  name: "workspace_move",
  plan: STANDALONE_PLAN_ACTION,
  planner: {
    aliases: ["move_workspace", "workspace_rename"],
    argsExample: {
      from: "draft.md",
      to: "final_candidate.md",
      summary: "promote draft to final candidate"
    },
    argsSchema: {
      from: { type: "string", required: true },
      overwrite: { type: "boolean" },
      summary: { type: "string" },
      to: { type: "string", required: true }
    },
    decisionType: "action",
    guidance: "Use workspace_move to rename a virtual draft file in one cycle instead of three steps (workspace_read → workspace_write → workspace_remove). The destination must be empty unless overwrite:true is set. Observable failures: source_not_found (source path is empty), target_exists (destination has content and overwrite not set), same_path (source and destination are identical)."
  },
  tier: 0,
  execute: executeWorkspaceMoveAction,
  preflight(context, args) {
    if (args && args.from != null) validateWorkspacePath(args.from);
    if (args && args.to != null) validateWorkspacePath(args.to);
  },
  outputSchema: {
    kinds: ["virtual_workspace_move"],
    controls: ["continue"]
  }
});

const workspaceMultiEditAction = Object.freeze({
  description: "Apply multiple replace or insert_after_section operations across one or more virtual workspace files in a single OODAE cycle.",
  name: "workspace_multi_edit",
  plan: STANDALONE_PLAN_ACTION,
  planner: {
    aliases: ["workspace_batch_edit", "multi_edit_workspace"],
    argsExample: {
      atomic: false,
      operations: [
        { action: "replace", path: "draft.md", find: "old phrase", replace: "improved phrase" },
        { action: "insert_after_section", path: "draft.md", heading: "Summary", content: "Additional context paragraph." }
      ],
      summary: "fix two sections in draft"
    },
    argsSchema: {
      atomic: { type: "boolean" },
      operations: {
        type: "array",
        required: true,
        items: {
          type: "object",
          properties: {
            action: { type: "string", required: true },
            content: { type: "string" },
            find: { type: "string" },
            heading: { type: "string" },
            path: { type: "string", required: true },
            replace: { type: "string" },
            replace_all: { type: "boolean" }
          }
        }
      },
      summary: { type: "string" }
    },
    decisionType: "action",
    guidance: "Use workspace_multi_edit to batch multiple replace or insert_after_section operations in a single OODAE cycle. Each operation must include action (replace or insert_after_section), path, and operation-specific fields. With atomic:true (default false), the first failure rolls back all changes and returns status=aborted. Without atomic, partial success is allowed and each result entry shows its individual status. The file must have been workspace_read before the first mutation on that file in this batch — the same read-before-mutate rule as workspace_replace and workspace_insert_after_section."
  },
  tier: 0,
  execute: executeWorkspaceMultiEditAction,
  outputSchema: {
    kinds: ["virtual_workspace_multi_edit"],
    controls: ["continue"]
  }
});

const workspaceFinalizeCandidateAction = Object.freeze({
  description: "Mark a virtual workspace file as the final answer candidate for AI-owned finalization context.",
  name: FINALIZE_CANDIDATE_ACTION,
  plan: STANDALONE_PLAN_ACTION,
  planner: {
    aliases: ["finalize_workspace_candidate", "workspace_ready"],
    argsExample: {
      path: "final_candidate.md",
      summary: "final response candidate ready"
    },
    argsSchema: {
      path: { type: "string" },
      summary: { type: "string" }
    },
    decisionType: "action",
    guidance: "Call workspace_finalize_candidate after the selected workspace file contains the user-facing final candidate. Then read it back with workspace_read, sync any active TodoState with the work actually completed, and choose workspace_publish_candidate when that candidate is the final answer."
  },
  tier: 0,
  execute: executeWorkspaceFinalizeCandidateAction,
  preflight(context, args) {
    if (args && args.path != null) {
      preflightWorkspacePath(context, args);
    }
  },
  outputSchema: {
    kinds: ["virtual_workspace_finalize_candidate"],
    controls: ["continue"]
  }
});

const workspaceReviewCandidateAction = Object.freeze({
  description: "Record the AI's self-review of a virtual workspace final candidate after reading it. This never edits candidate content.",
  name: "workspace_review_candidate",
  plan: STANDALONE_PLAN_ACTION,
  planner: {
    aliases: ["review_workspace_candidate", "candidate_self_review", "workspace_self_review"],
    argsExample: {
      issues: [],
      path: "final_candidate.md",
      readyToPublish: true,
      repairPlan: "No blocking gaps after reading the latest candidate.",
      requirementsChecklist: [
        {
          id: "length",
          kind: "objective",
          requirement: "Meet the requested length",
          status: "met",
          evidence: "workspace_read textStats matches the requested target"
        },
        {
          id: "format",
          kind: "objective",
          requirement: "Use the format requested by the user",
          status: "met",
          evidence: "workspace_read shows the requested sections are present"
        }
      ],
      summary: "reviewed final candidate against user request, evidence, structure, and citations"
    },
    argsSchema: {
      finalSectionTitle: { type: "string" },
      issues: { type: "array" },
      path: { type: "string", required: true },
      readyToPublish: { type: "boolean" },
      repairPlan: { type: "string" },
      requirementsChecklist: { type: "array" },
      summary: { type: "string", required: true }
    },
    decisionType: "action",
    guidance: "Use workspace_review_candidate after workspace_read of the selected final candidate and before workspace_publish_candidate for long-form/research answers. This is your AI-authored self-review checkpoint: break the user's request into requirementsChecklist items, mark each item met/partial/unmet, report issues you saw, name finalSectionTitle only if the user or your structure declares a final section, and set readyToPublish only after checking the latest candidate text, citations, structure, and requested depth. Mark requirements as objective when the latest workspace_read text can prove them, such as requested length, required sections/headings, required files, cited URL count, or stated data fields. Use subjective only for editorial judgment such as clarity, tone, or depth. Do not invent admin artifacts as requirements unless the user, host, or task policy explicitly asked for them. The runtime records your checklist/review and separately exposes candidateQualitySignal facts; it does not rewrite content for you."
  },
  tier: 0,
  execute: executeWorkspaceReviewCandidateAction,
  preflight: preflightWorkspacePath,
  outputSchema: {
    kinds: ["virtual_workspace_review_candidate"],
    controls: ["continue"]
  }
});

const workspacePublishCandidateAction = Object.freeze({
  description: "Publish the selected virtual workspace final candidate directly as the final user answer without calling the finalizer LLM.",
  name: PUBLISH_DIRECT_ACTION,
  // AGRUN-313 2.1 (litmus burn-down) — the action self-declares its terminal
  // semantics so the generic kernel can route on the capability instead of
  // special-casing this action's NAME. Read at the dispatch site
  // (executeAction) and stamped on runState as terminalActionPublishDirect.
  publishDirect: true,
  plan: STANDALONE_PLAN_ACTION,
  planner: {
    aliases: ["publish_workspace_candidate", "workspace_publish", "publish_final_candidate"],
    // ADR-0033 Tier A.10 (X1.5.b fix, 2026-05-20 evening) — argsExample shows a
    // CONCRETE limited-contract publish whose remainingGaps entries are real
    // sentences a model can copy verbatim. Earlier X1.5 example used template
    // strings ("replace this with..."); empirical data (X1 fix live test)
    // showed lite-tier flash-lite parsed those as instructions to remove and
    // emitted remainingGaps:[] (empty array), failing publish validation. The
    // example below contains plain English sentences mirroring what
    // requiredArgsExample renders from real run state, so the model can copy
    // the shape AND the substance.
    argsExample: {
      finalReadiness: {
        decision: "limited",
        evidenceMode: "configured_evidence",
        limitations: "Evidence minimum unmet and length below target; publishing what is grounded so far.",
        requirementsAssessment: {
          checkedReadinessAgainstUserRequest: true,
          checkedEvidence: true,
          checkedReadUrlEvidence: true,
          checkedWorkspaceStats: true,
          evidenceSatisfied: false,
          lengthSatisfied: false,
          observedLength: 1048,
          observedLengthUnit: "words",
          remainingGaps: [
            "Length is still short: observed 1048 / requested 3000 words.",
            "Source minimum unmet: 2 of 3 successful read_url required for clean ready.",
            "Structure repair pending: duplicate headings and section numbers detected in final_candidate.md."
          ],
          requestedLength: 3000,
          requirementSatisfied: false,
          successfulEvidenceCount: 2,
          successfulReadUrlCount: 2,
          userRequirementSummary: "user-facing answer with the requested depth"
        }
      },
      path: "final_candidate.md"
    },
    argsSchema: {
      finalReadiness: {
        type: "object",
        required: true,
        properties: {
          decision: {
            type: "string",
            description: "Use ready only when all observable requirements are satisfied; use limited when source, length, or requirement gaps remain."
          },
          evidenceMode: { type: "string" },
          limitations: { type: "string" },
          requirementsAssessment: {
            type: "object",
            properties: {
              checkedReadinessAgainstUserRequest: { type: "boolean" },
              checkedEvidence: { type: "boolean" },
              checkedReadUrlEvidence: { type: "boolean" },
              checkedWorkspaceStats: { type: "boolean" },
              evidenceSatisfied: { type: "boolean" },
              lengthSatisfied: { type: "boolean" },
              observedLength: { type: "number" },
              observedLengthUnit: { type: "string" },
              remainingGaps: { type: "array", items: { type: "string" } },
              requestedLength: { type: "number" },
              requirementSatisfied: { type: "boolean" },
              successfulEvidenceCount: { type: "number" },
              successfulReadUrlCount: { type: "number" },
              summary: { type: "string" },
              userRequirementSummary: { type: "string" }
            },
            required: [
              "checkedWorkspaceStats",
              "evidenceSatisfied",
              "lengthSatisfied",
              "observedLength",
              "observedLengthUnit",
              "remainingGaps",
              "requirementSatisfied"
            ]
          }
        },
        required: ["decision", "requirementsAssessment"]
      },
      path: { type: "string" }
    },
    decisionType: "action",
    guidance: "Use workspace_publish_candidate after workspace_finalize_candidate, workspace_read, and for long-form/research answers workspace_review_candidate on the selected candidate. Always include finalReadiness with requirementsAssessment based on the latest workspace_read stats, configured evidence facts, requested length, and any concrete remainingGaps. For web-research hosts, successfulReadUrlCount is accepted as a legacy evidence field; host-specific tools can use successfulEvidenceCount. If TerminalRepairState exposes a validPublishContract, do not send a plain or ready publish; either perform the allowed recovery action or publish with decision='limited' and false flags for the failed observable dimensions named in that contract. This terminal action publishes the candidate content directly; do not use finalize if you want to avoid LLM re-summarization. If a TodoState plan exists, update completed/blocked/abandoned phases before this terminal action because runtime only observes stale TodoState and will not mark items done."
  },
  tier: 0,
  execute: executeWorkspacePublishCandidateAction,
  preflight(context, args) {
    if (args && args.path != null) {
      preflightWorkspacePath(context, args);
    }
  },
  outputSchema: {
    kinds: ["final_response", "virtual_workspace_publish_blocked"],
    controls: ["complete", "continue"]
  }
});

async function executeWorkspaceListAction(context) {
  const workspace = ensureWorkspace(context);
  return {
    control: "continue",
    output: {
      candidateLifecycle: workspace.candidateLifecycle || null,
      candidatePathMismatchSignal: context.runState && context.runState.candidatePathMismatchSignal || workspace.candidatePathMismatchSignal || null,
      enabled: workspace.enabled === true,
      files: listWorkspaceFiles(workspace),
      kind: "virtual_workspace_list",
      mode: workspace.mode,
      quality: workspace.quality
    },
    summary: `workspace_list(files=${Object.keys(workspace.files || {}).length})`
  };
}

async function executeWorkspaceReadAction(context, args) {
  const workspace = ensureWorkspace(context);
  const file = readWorkspaceFile(workspace, args && args.path);
  recordWorkspaceRead(context.runState, file.path, {
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
    prompt: context.request && context.request.prompt,
    summary: `reviewed ${file.path} (${formatTextStats(file.textStats)})`
  });
  return {
    control: "continue",
    output: {
      candidateLifecycle: context.runState.virtualWorkspace && context.runState.virtualWorkspace.candidateLifecycle || null,
      candidatePathMismatchSignal: context.runState.candidatePathMismatchSignal || null,
      file,
      kind: "virtual_workspace_read",
      lengthProgress: summarizeLengthProgress(context, file)
    },
    summary: summarizeWorkspaceRead(file, context)
  };
}

async function executeWorkspaceWriteAction(context, args) {
  const workspace = ensureWorkspace(context);
  const beforeFile = readWorkspaceFile(workspace, args && args.path);
  const readError = checkWorkspaceReadRequirement(workspace, args && args.path);
  if (readError) {
    return {
      control: "continue",
      output: {
        candidateLifecycle: workspace.candidateLifecycle || null,
        candidatePathMismatchSignal: context.runState && context.runState.candidatePathMismatchSignal || null,
        file: summarizeFile(beforeFile),
        kind: "virtual_workspace_write",
        lengthProgress: null,
        message: readError,
        mutationStats: null,
        quality: workspace.quality,
        shrinkRisk: null,
        status: "read_required"
      },
      summary: `workspace_write(${beforeFile.path || "?"}, status=read_required)`
    };
  }
  const release = await acquireWorkspaceMutex(context.runState, args && args.path);
  try {
    const file = writeWorkspaceFile(context.runState, args && args.path, args && args.content, {
      config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
      maxFileChars: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxFileChars,
      maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
      prompt: context.request && context.request.prompt,
      summary: args && args.summary
    });
    publishWorkspaceEvent(context.runState, { type: "workspace_write", path: file && file.path, status: file && file.status || "ok" });
    return {
      control: "continue",
      output: {
        candidateLifecycle: context.runState.virtualWorkspace && context.runState.virtualWorkspace.candidateLifecycle || null,
        candidatePathMismatchSignal: context.runState.candidatePathMismatchSignal || null,
        file: summarizeFile(file),
        kind: "virtual_workspace_write",
        lengthProgress: summarizeLengthProgress(context, file),
        message: file && file.message || null,
        mutationStats: summarizeMutationStats(beforeFile, file, args && args.content),
        quality: context.runState.virtualWorkspace.quality,
        shrinkRisk: file && file.shrinkRisk || null,
        status: file && file.status || "ok"
      },
      summary: summarizeWorkspaceMutation("workspace_write", file, context)
    };
  } finally {
    release();
  }
}

function buildReplaceVetoedSuggestion(missHints, repeatedFindCount) {
  const base = `This find string has failed ${repeatedFindCount} times in this run — workspace_replace will keep returning not_found. Stop retrying workspace_replace with the same or similar find. `;
  if (missHints && Array.isArray(missHints.anchorMatches) && missHints.anchorMatches.length > 0) {
    return base + "Either re-issue workspace_replace with verbatim text copied from missHints.anchorMatches[*].surroundingText, or switch to workspace_propose_patch with a {type:'replace',find:'<text from surroundingText>',replace:'...'} operation.";
  }
  return base + "Switch to workspace_propose_patch with a {type:'replace',find:'<verbatim text from missHints>',replace:'...'} operation, or use workspace_insert_after_section to add new content under an existing heading.";
}

function buildReplaceNotFoundSuggestion(missHints) {
  if (missHints && Array.isArray(missHints.anchorMatches) && missHints.anchorMatches.length > 0) {
    return "Your find string was not found. Compare it against missHints.anchorMatches[*].surroundingText (verbatim file excerpts) and re-issue workspace_replace with text copied from there.";
  }
  if (missHints && Array.isArray(missHints.bracketLandmarks) && missHints.bracketLandmarks.length > 0) {
    return "Your find string contains bracket text that does not exist in the file. missHints.bracketLandmarks lists the real bracket/heading patterns — pick one and re-issue workspace_replace, or switch to workspace_propose_patch.";
  }
  if (missHints && missHints.documentOutline) {
    return "Your find string was not found and no anchor lines matched. missHints.documentOutline shows the file's real headings and first 240 chars — use them to compose a verbatim find, or call workspace_read for the full file.";
  }
  return "Run workspace_read to refresh your view of the file, then retry workspace_replace with text that appears verbatim in the latest content.";
}

async function executeWorkspaceReplaceAction(context, args) {
  const workspace = ensureWorkspace(context);
  const beforeFile = readWorkspaceFile(workspace, args && args.path);
  const readError = checkWorkspaceReadRequirement(workspace, args && args.path);
  if (readError) {
    return {
      control: "continue",
      output: {
        changed: false,
        contextSnippets: [],
        file: summarizeFile(beforeFile),
        fuzzyAttempted: [],
        fuzzyMatch: null,
        kind: "virtual_workspace_replace",
        lengthProgress: null,
        matchCount: null,
        missHints: null,
        mutationStats: null,
        quality: workspace.quality,
        repeatedFindCount: null,
        replacedAll: false,
        status: "read_required",
        suggestion: readError,
        error: null,
        message: readError
      },
      summary: `workspace_replace(${beforeFile.path || "?"}, status=read_required)`
    };
  }
  const release = await acquireWorkspaceMutex(context.runState, args && args.path);
  try {
    const result = replaceWorkspaceFile(context.runState, args && args.path, args && args.find, args && args.replace, {
      config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
      maxFileChars: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxFileChars,
      maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
      prompt: context.request && context.request.prompt,
      replaceAll: args && args.replace_all === true,
      summary: args && args.summary
    });
    const status = readString$N(result.status) || (result.changed ? "ok" : "not_found");
    publishWorkspaceEvent(context.runState, { type: "workspace_replace", path: result.file && result.file.path, status });
    const summaryParts = [`workspace_replace(${result.file.path}, status=${status}`];
    if (typeof result.matchCount === "number") summaryParts.push(`matches=${result.matchCount}`);
    if (result.fuzzyMatch) summaryParts.push(`fuzzy=${result.fuzzyMatch}`);
    return {
      control: "continue",
      output: {
        changed: result.changed,
        contextSnippets: Array.isArray(result.contextSnippets) ? result.contextSnippets : [],
        file: summarizeFile(result.file),
        fuzzyAttempted: Array.isArray(result.fuzzyAttempted) ? result.fuzzyAttempted : [],
        fuzzyMatch: result.fuzzyMatch || null,
        kind: "virtual_workspace_replace",
        lengthProgress: summarizeLengthProgress(context, result.file),
        matchCount: typeof result.matchCount === "number" ? result.matchCount : null,
        missHints: result.missHints || null,
        mutationStats: summarizeMutationStats(beforeFile, result.file, args && args.replace),
        quality: context.runState.virtualWorkspace.quality,
        repeatedFindCount: typeof result.repeatedFindCount === "number" ? result.repeatedFindCount : null,
        replacedAll: result.replacedAll === true,
        status,
        suggestion: status === "ambiguous"
          ? "Widen the find text with surrounding context until it is unique, or call workspace_replace again with replace_all:true to replace every occurrence."
          : status === "repeated_find_vetoed"
            ? buildReplaceVetoedSuggestion(result.missHints, result.repeatedFindCount)
            : status === "not_found"
              ? buildReplaceNotFoundSuggestion(result.missHints)
              : status === "invalid_args"
                ? "Provide a non-empty find string and a valid workspace path (no absolute, no '..', no backslash), then retry."
                : null,
        error: result.error || null,
        message: result.message || null
      },
      summary: `${summaryParts.join(", ")})`
    };
  } finally {
    release();
  }
}

async function executeWorkspaceProposePatchAction(context, args) {
  const beforeFile = readWorkspaceFile(ensureWorkspace(context), args && args.path);
  const result = proposeWorkspacePatch(context.runState, args && args.path, args && args.operations, {
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    maxFileChars: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxFileChars,
    prompt: context.request && context.request.prompt,
    summary: args && args.summary
  });
  const autoApply = args && args.applyIfValid === true;
  const autoApplyEligible = autoApply && canAutoApplyWorkspacePatch(result);
  const applied = autoApplyEligible && result.valid === true
    ? applyWorkspacePatch(context.runState, result.patchId, {
        config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
        maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
        prompt: context.request && context.request.prompt,
        summary: args && args.summary
      })
    : null;
  const appliedFile = applied && applied.file && typeof applied.file === "object" ? applied.file : null;
  return {
    control: "continue",
    output: {
      applied: Boolean(applied && applied.changed === true),
      applyStatus: applied ? applied.status : autoApply
        ? autoApplyEligible
          ? "not_applied"
          : "skipped_requires_heading_only_patch"
        : null,
      afterWords: result.afterWords,
      baseVersion: result.baseVersion,
      beforeWords: result.beforeWords,
      changed: result.changed,
      deltaWords: result.deltaWords,
      file: summarizeFile(beforeFile),
      kind: "virtual_workspace_propose_patch",
      operations: Array.isArray(result.operations) ? result.operations : [],
      patchId: result.patchId,
      path: result.path,
      previewSummary: result.previewSummary,
      riskFlags: Array.isArray(result.riskFlags) ? result.riskFlags : [],
      file: appliedFile ? summarizeFile(appliedFile) : summarizeFile(beforeFile),
      lengthProgress: appliedFile ? summarizeLengthProgress(context, appliedFile) : null,
      quality: context.runState.virtualWorkspace && context.runState.virtualWorkspace.quality,
      status: applied && applied.changed === true ? "applied" : result.status,
      structureAfter: result.structureAfter || null,
      structureBefore: result.structureBefore || null,
      suggestion: suggestWorkspacePatchNextStep(result, { applied, autoApply, autoApplyEligible }),
      valid: result.valid === true
    },
    summary: `workspace_propose_patch(${result.path || "<invalid>"}, status=${applied && applied.changed === true ? "applied" : result.status}, deltaWords=${result.deltaWords}, riskFlags=${Array.isArray(result.riskFlags) && result.riskFlags.length ? result.riskFlags.join("|") : "none"})`
  };
}

function canAutoApplyWorkspacePatch(result) {
  const operations = Array.isArray(result && result.operations) ? result.operations : [];
  return operations.length > 0 && operations.every((operation) => operation && operation.type === "normalize_headings");
}

function suggestWorkspacePatchNextStep(result, options = {}) {
  if (options.applied && options.applied.changed === true) {
    return "Heading-only patch was validated and applied in this action. Continue from the updated workspace content; do not call workspace_apply_patch for this patchId.";
  }
  if (options.autoApply === true && options.autoApplyEligible !== true) {
    return "applyIfValid only auto-applies heading-only normalize_headings patches. This preview was not auto-applied; inspect the preview and call workspace_apply_patch only if appropriate.";
  }
  const status = result && result.status;
  const operations = Array.isArray(result && result.operations) ? result.operations : [];
  const riskFlags = Array.isArray(result && result.riskFlags) ? result.riskFlags : [];
  const hasInvalidReplaceShape = operations.some((operation) => (
    operation &&
    operation.type === "replace" &&
    (operation.findChars || 0) === 0
  ));
  if (hasInvalidReplaceShape) {
    return "Patch replace operations require non-empty find and replace fields. Do not use replace+content for full rewrites; use append/insert_after_section, or quote exact current text in find and new text in replace.";
  }
  if (riskFlags.includes("ambiguous")) {
    return "A replace or heading match is ambiguous. Use a longer exact find string, pass replace_all:true only when every match should change, or use append/insert_after_section.";
  }
  if (riskFlags.includes("not_found")) {
    return "Patch target was not found. Use text visible in the latest workspace projection/read, or switch to append/insert_after_section.";
  }
  if (riskFlags.includes("no_growth")) {
    return "Patch did not grow the candidate or improve structure. Add substantial user-facing content with append/insert_after_section when allowed, or use normalize_headings with lineNumber entries from duplicate_heading_context to repair duplicate headings.";
  }
  if (riskFlags.includes("structure_maybe_worse")) {
    return "Patch may worsen structure. Avoid duplicate headings/section numbers; use append/insert under an existing unique heading or publish limited with concrete structure gaps.";
  }
  if (status === "preview_ready") {
    return "Preview is valid: call workspace_apply_patch with this patchId before finalizing or publishing.";
  }
  return "Revise the patch using valid operation shapes, or use workspace_insert_after_section/workspace_replace when exact replacement is fragile.";
}

async function executeWorkspaceApplyPatchAction(context, args) {
  const result = applyWorkspacePatch(context.runState, args && args.patchId, {
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
    prompt: context.request && context.request.prompt,
    summary: args && args.summary
  });
  const file = result.file && typeof result.file === "object" ? result.file : null;
  publishWorkspaceEvent(context.runState, { type: "workspace_apply_patch", path: file && file.path || null, status: result.status });
  return {
    control: "continue",
    output: {
      baseVersion: result.baseVersion,
      changed: result.changed === true,
      currentVersion: result.currentVersion,
      error: result.error || null,
      expectedPatchId: result.expectedPatchId || null,
      file: file ? summarizeFile(file) : null,
      kind: "virtual_workspace_apply_patch",
      lengthProgress: file ? summarizeLengthProgress(context, file) : null,
      message: result.message || null,
      patchId: result.patchId || null,
      quality: context.runState.virtualWorkspace && context.runState.virtualWorkspace.quality,
      riskFlags: Array.isArray(result.riskFlags) ? result.riskFlags : [],
      status: result.status
    },
    summary: `workspace_apply_patch(${result.patchId || "<none>"}, status=${result.status}, changed=${result.changed ? "yes" : "no"})`
  };
}

async function executeWorkspaceInsertAfterSectionAction(context, args) {
  const beforeFile = readWorkspaceFile(ensureWorkspace(context), args && args.path);
  const result = insertAfterWorkspaceSection(context.runState, args && args.path, args && args.heading, args && args.content, {
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    maxFileChars: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxFileChars,
    maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
    prompt: context.request && context.request.prompt,
    separator: args && args.separator,
    summary: args && args.summary
  });
  const status = readString$N(result.status) || (result.changed ? "ok" : "heading_not_found");
  const availableHeadings = Array.isArray(result.availableHeadings) ? result.availableHeadings : [];
  publishWorkspaceEvent(context.runState, { type: "workspace_insert_after_section", path: args && args.path || null, status });
  return {
    control: "continue",
    output: {
      availableHeadings,
      changed: result.changed,
      file: summarizeFile(result.file),
      heading: result.heading,
      kind: "virtual_workspace_insert_after_section",
      lengthProgress: summarizeLengthProgress(context, result.file),
      mutationStats: summarizeMutationStats(beforeFile, result.file, args && args.content),
      quality: context.runState.virtualWorkspace.quality,
      requestedHeading: result.requestedHeading || result.heading,
      status,
      structureRisk: result.structureRisk || null,
      suggestion: status === "heading_not_found"
        ? availableHeadings.length > 0
          ? `Heading "${result.requestedHeading || result.heading}" not found. Available headings: ${availableHeadings.map((entry) => entry.text).join(" | ")}. Pick one of these (case/punctuation will be normalized) to expand an existing section.`
          : `Heading "${result.requestedHeading || result.heading}" not found and the file has no Markdown headings yet. Write the file with workspace_write first so it has section headings to anchor to.`
        : status === "invalid_args"
          ? "Provide a non-empty heading and a valid workspace path (no absolute, no '..', no backslash), then retry."
          : result.structureRisk === "structure_maybe_worse"
            ? "Insertion succeeded but worsened final candidate structure. Continue length growth if needed, then use workspace_propose_patch normalize_headings with section_number_repair_context before publishing ready."
            : null,
      structureAfter: result.structureAfter || null,
      structureBefore: result.structureBefore || null,
      error: result.error || null,
      message: result.message || null
    },
    summary: `${summarizeWorkspaceMutation("workspace_insert_after_section", result.file, context)}, status=${status}, availableHeadings=${availableHeadings.length}`
  };
}

async function executeWorkspaceRemoveAction(context, args) {
  const result = removeWorkspaceFile(context.runState, args && args.path, {
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
    prompt: context.request && context.request.prompt,
    summary: args && args.summary
  });
  publishWorkspaceEvent(context.runState, { type: "workspace_remove", path: result.file && result.file.path || null, status: result.removed ? "ok" : "not_found" });
  return {
    control: "continue",
    output: {
      file: summarizeFile(result.file),
      kind: "virtual_workspace_remove",
      quality: context.runState.virtualWorkspace.quality,
      removed: result.removed
    },
    summary: `workspace_remove(${result.file.path}, removed=${result.removed ? "yes" : "no"})`
  };
}

async function executeWorkspaceMoveAction(context, args) {
  const result = moveWorkspaceFile(context.runState, args && args.from, args && args.to, {
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
    overwrite: args && args.overwrite === true,
    prompt: context.request && context.request.prompt,
    summary: args && args.summary
  });
  publishWorkspaceEvent(context.runState, { type: "workspace_move", path: result.toFile && result.toFile.path || readString$N(args && args.to) || null, status: result.status });
  return {
    control: "continue",
    output: {
      error: result.error || null,
      fromFile: result.fromFile ? summarizeFile(result.fromFile) : null,
      kind: "virtual_workspace_move",
      message: result.message || null,
      moved: result.moved === true,
      quality: context.runState.virtualWorkspace && context.runState.virtualWorkspace.quality,
      status: result.status,
      toFile: result.toFile ? summarizeFile(result.toFile) : null
    },
    summary: `workspace_move(${readString$N(args && args.from)} → ${readString$N(args && args.to)}, status=${result.status})`
  };
}

async function executeWorkspaceMultiEditAction(context, args) {
  const workspace = ensureWorkspace(context);
  const operations = Array.isArray(args && args.operations) ? args.operations : [];
  const atomic = (args && args.atomic) === true;
  const summary = readString$N(args && args.summary);
  const touchedPaths = Array.from(new Set(
    operations.map((op) => readString$N(op && op.path)).filter(Boolean)
  ));
  const beforeStats = summarizeWorkspacePathsStats(workspace, touchedPaths);

  if (operations.length === 0) {
    return {
      control: "continue",
      output: {
        atomic,
        failedCount: 0,
        kind: "virtual_workspace_multi_edit",
        message: "workspace_multi_edit requires at least one operation",
        operationCount: 0,
        results: [],
        status: "no_operations",
        succeededCount: 0
      },
      summary: "workspace_multi_edit(ops=0, status=no_operations)"
    };
  }

  // Snapshot is keyed by path and captured from runState so restore always
  // targets the current runState.virtualWorkspace (ensureVirtualWorkspace
  // replaces the reference on each primitive call, making a stale local
  // `workspace` variable unsafe for rollback).
  const snapshot = atomic ? captureMultiEditSnapshot(context.runState, operations) : null;
  const results = [];
  let aborted = false;

  for (let i = 0; i < operations.length; i++) {
    if (aborted) {
      results.push({ index: i, status: "aborted", message: "atomic batch aborted due to earlier failure" });
      continue;
    }
    const op = operations[i];
    if (!op || typeof op !== "object") {
      const entry = { index: i, status: "invalid_args", message: "operation must be an object" };
      results.push(entry);
      if (atomic) { aborted = true; restoreMultiEditSnapshot(context.runState, snapshot); }
      continue;
    }
    const action = readString$N(op.action || op.type);
    const opPath = readString$N(op.path);
    if (!opPath) {
      const entry = { index: i, status: "invalid_args", message: "operation requires path" };
      results.push(entry);
      if (atomic) { aborted = true; restoreMultiEditSnapshot(context.runState, snapshot); }
      continue;
    }
    // Always check against the current workspace — primitive functions replace
    // runState.virtualWorkspace with a new normalized object on each call, so
    // re-dereference here instead of using the initial `workspace` local.
    const currentWorkspace = context.runState.virtualWorkspace;
    const readError = checkMultiEditReadRequirement(currentWorkspace, opPath);
    if (readError) {
      const entry = { index: i, status: "read_required", path: opPath, message: readError };
      results.push(entry);
      if (atomic) { aborted = true; restoreMultiEditSnapshot(context.runState, snapshot); }
      continue;
    }
    if (action === "replace") {
      const opResult = replaceWorkspaceFile(context.runState, opPath, op.find, op.replace, {
        config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
        maxFileChars: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxFileChars,
        maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
        prompt: context.request && context.request.prompt,
        replaceAll: op.replace_all === true,
        summary: summary || `multi_edit[${i}] replace in ${opPath}`
      });
      const opStatus = readString$N(opResult.status) || (opResult.changed ? "ok" : "not_found");
      const entry = { index: i, status: opStatus, path: opPath, file: opResult.file ? summarizeFile(opResult.file) : null, contextSnippets: Array.isArray(opResult.contextSnippets) ? opResult.contextSnippets : [] };
      if (typeof opResult.matchCount === "number") entry.matchCount = opResult.matchCount;
      results.push(entry);
      if (opStatus !== "ok" && atomic) { aborted = true; restoreMultiEditSnapshot(context.runState, snapshot); }
    } else if (action === "insert_after_section") {
      const opResult = insertAfterWorkspaceSection(context.runState, opPath, op.heading, op.content, {
        config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
        maxFileChars: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxFileChars,
        maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
        prompt: context.request && context.request.prompt,
        separator: op.separator,
        summary: summary || `multi_edit[${i}] insert_after_section in ${opPath}`
      });
      const opStatus = readString$N(opResult.status) || (opResult.changed ? "ok" : "heading_not_found");
      const entry = { index: i, status: opStatus, path: opPath, file: opResult.file ? summarizeFile(opResult.file) : null, availableHeadings: Array.isArray(opResult.availableHeadings) ? opResult.availableHeadings : [] };
      results.push(entry);
      if (opStatus !== "ok" && atomic) { aborted = true; restoreMultiEditSnapshot(context.runState, snapshot); }
    } else {
      const entry = { index: i, status: "invalid_args", path: opPath, message: `unknown action "${action}"; supported: replace, insert_after_section` };
      results.push(entry);
      if (atomic) { aborted = true; restoreMultiEditSnapshot(context.runState, snapshot); }
    }
  }

  const failedCount = results.filter((r) => r.status !== "ok" && r.status !== "aborted").length;
  const succeededCount = results.filter((r) => r.status === "ok").length;
  const overallStatus = aborted ? "aborted" : failedCount === 0 ? "ok" : "partial";
  const afterStats = summarizeWorkspacePathsStats(context.runState && context.runState.virtualWorkspace, touchedPaths);
  publishWorkspaceEvent(context.runState, { type: "workspace_multi_edit", path: touchedPaths.join(",") || null, status: overallStatus });
  return {
    control: "continue",
    output: {
      atomic,
      failedCount,
      kind: "virtual_workspace_multi_edit",
      mutationStats: summarizeAggregateMutationStats(beforeStats, afterStats),
      operationCount: operations.length,
      quality: context.runState.virtualWorkspace && context.runState.virtualWorkspace.quality,
      results,
      status: overallStatus,
      succeededCount
    },
    summary: `workspace_multi_edit(ops=${operations.length}, ok=${succeededCount}, failed=${failedCount}, status=${overallStatus})`
  };
}

function captureMultiEditSnapshot(runState, operations) {
  const workspace = runState && runState.virtualWorkspace;
  if (!workspace) return null;
  const snapshot = {};
  for (const op of operations) {
    const p = op && typeof op.path === "string" ? op.path.trim() : "";
    if (p && !(p in snapshot)) {
      const f = workspace.files && workspace.files[p];
      snapshot[p] = f ? { ...f } : null;
    }
  }
  return snapshot;
}

function restoreMultiEditSnapshot(runState, snapshot) {
  const workspace = runState && runState.virtualWorkspace;
  if (!workspace || !snapshot) return;
  for (const [p, file] of Object.entries(snapshot)) {
    if (file) {
      workspace.files[p] = { ...file };
    } else {
      delete workspace.files[p];
    }
  }
}

function checkWorkspaceReadRequirement(workspace, path) {
  const files = workspace.files && typeof workspace.files === "object" ? workspace.files : {};
  const file = files[path];
  const currentContent = file && typeof file.content === "string" ? file.content : "";
  if (!currentContent.trim()) return null;
  const lastRead = workspace.quality && workspace.quality.lastRead;
  if (!lastRead || lastRead.path !== path) {
    return `workspace mutation on ${path}: workspace_read this file first (${currentContent.length} chars of existing content).`;
  }
  const readAt = typeof lastRead.observedAt === "string" ? lastRead.observedAt.trim() : "";
  const updatedAt = typeof file.updatedAt === "string" ? file.updatedAt.trim() : "";
  if (readAt && updatedAt && readAt < updatedAt) {
    return `workspace mutation on ${path}: file changed since last workspace_read (read=${readAt}, updated=${updatedAt}); workspace_read it again.`;
  }
  return null;
}

function checkMultiEditReadRequirement(workspace, path) {
  return checkWorkspaceReadRequirement(workspace, path);
}

async function executeWorkspaceFinalizeCandidateAction(context, args) {
  const candidatePath = args && args.path || "final_candidate.md";
  const quality = finalizeWorkspaceCandidate(context.runState, args && args.path || "final_candidate.md", {
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
    prompt: context.request && context.request.prompt,
    summary: args && args.summary
  });
  const workspace = context && context.runState && context.runState.virtualWorkspace;
  // Source-gate steering (2026-06-10) — finalize is the moment the model
  // declares "done writing" but can still edit cheaply. State the
  // read-but-uncited diff here, while adding citations is one insert away.
  const candidateFile = workspace && workspace.files && workspace.files[candidatePath];
  const citationCoverage = buildCitationCoverageAudit(
    candidateFile && typeof candidateFile.content === "string" ? candidateFile.content : "",
    context.runState
  );
  const uncitedCount = citationCoverage.uncitedReadUrls.length;
  return {
    control: "continue",
    output: {
      candidateLifecycle: workspace && workspace.candidateLifecycle || null,
      candidatePathMismatchSignal: context.runState.candidatePathMismatchSignal || null,
      citationCoverage,
      kind: "virtual_workspace_finalize_candidate",
      message: citationCoverage.message,
      publishProtocol: inspectWorkspacePublishProtocol(workspace, candidatePath),
      quality
    },
    summary: `workspace_finalize_candidate(ready=${quality.finalCandidateReady ? "yes" : "no"}${uncitedCount > 0 ? `, read_but_uncited_sources=${uncitedCount}` : ""})`
  };
}

async function executeWorkspaceReviewCandidateAction(context, args) {
  const workspace = ensureWorkspace(context);
  const file = readWorkspaceFinalCandidate(workspace, args && args.path);
  const publishProtocol = inspectWorkspacePublishProtocol(workspace, file.path);
  const lastRead = workspace && workspace.quality && workspace.quality.lastRead;
  if (!lastRead || lastRead.path !== file.path || publishProtocol.readAfterLatestContentChange !== true) {
    const signal = buildAndStoreCandidateQualitySignal(context, workspace, file, null, {
      reviewRequired: true
    });
    return {
      control: "continue",
      output: {
        candidateQualitySignal: signal,
        file: summarizeFile(file),
        kind: "virtual_workspace_review_candidate",
        message: `workspace_review_candidate requires workspace_read of ${file.path} after the latest content change before self-review.`,
        publishProtocol,
        status: "read_required"
      },
      summary: `workspace_review_candidate(${file.path}, status=read_required)`
    };
  }
  const reviewWorkspace = recordWorkspaceCandidateReview(context.runState, file.path, {
    finalSectionTitle: args && args.finalSectionTitle,
    issues: args && args.issues,
    readyToPublish: args && args.readyToPublish === true,
    repairPlan: args && args.repairPlan,
    requirementsChecklist: args && args.requirementsChecklist,
    summary: args && args.summary
  }, {
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
    prompt: context.request && context.request.prompt,
    summary: args && args.summary
  });
  const reviewedFile = readWorkspaceFinalCandidate(reviewWorkspace, file.path);
  const signal = buildAndStoreCandidateQualitySignal(context, reviewWorkspace, reviewedFile, null, {
    reviewRequired: true
  });
  publishWorkspaceEvent(context.runState, { type: "workspace_review_candidate", path: file.path, status: "ok" });
  return {
    control: "continue",
    output: {
      candidateQualitySignal: signal,
      candidateReview: reviewWorkspace.quality && reviewWorkspace.quality.candidateReview || null,
      // Source-gate steering parity — the citation-verify live run showed a
      // model can reach publish via review WITHOUT ever calling finalize, so
      // the audit must sit on BOTH self-check moments.
      citationCoverage: buildCitationCoverageAudit(readString$N(reviewedFile.content), context.runState),
      file: summarizeFile(reviewedFile),
      kind: "virtual_workspace_review_candidate",
      publishProtocol: inspectWorkspacePublishProtocol(reviewWorkspace, file.path),
      status: "ok"
    },
    summary: `workspace_review_candidate(${file.path}, status=ok, blockingIssues=${signal.blockingIssueCodes.length})`
  };
}

async function executeWorkspacePublishCandidateAction(context, args) {
  const workspace = ensureWorkspace(context);
  const file = readWorkspaceFinalCandidate(workspace, args && args.path);
  const candidateText = readString$N(file.content);
  const publishProtocol = inspectWorkspacePublishProtocol(workspace, file.path);
  const candidatePathMismatchSignal = recordWorkspacePublishCandidateLifecycle(context.runState, file.path, {
    completed: false,
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    prompt: context.request && context.request.prompt
  });
  const finalReadiness = normalizeFinalReadiness(args && (args.finalReadiness || args.readiness));
  const researchPublishRequired = isResearchPublishReadinessRequired(context);
  // Empty content is a legitimate I/O guard, not a behavioral push:
  // there is literally nothing to publish. AI-first decisions about
  // WHEN to publish (finalize protocol, read-after-finalize, readiness
  // self-audit) are surfaced as read-only observations on the planner
  // prompt and on this action's terminal output, never as runtime
  // throws that erase prior cycles. See
  // agrun_docs/live-tests/workspace-readiness-ssot-2026-05-11.md for
  // the live e2e that documented the previous push-mode behavior.
  if (!candidateText) {
    return createWorkspacePublishBlockedResult({
      context,
      file,
      finalReadiness,
      message: `workspace_publish_candidate cannot publish ${file.path || "final candidate"} because it is empty. Draft user-facing content with workspace_write, or pass the non-empty draft path to workspace_finalize_candidate and workspace_publish_candidate before publishing.`,
      publishProtocol,
      readinessAudit: null,
      researchPublishRequired,
      status: "missing_candidate_content"
    });
  }
  const readinessAudit = inspectPublishReadiness(context, workspace, file, finalReadiness);
  const candidateQualitySignal = buildAndStoreCandidateQualitySignal(context, workspace, file, finalReadiness, {
    reviewRequired: researchPublishRequired
  });
  // AGRUN publish-loop escape: terminal-repair grants publishLoopEscapeGranted
  // once the run hits hard_veto with a real drafted candidate (the AI has
  // failed the brittle write->finalize->read->review->publish protocol past the
  // high-water mark). Rather than block forever and return the maxSteps "paused"
  // stub, publish the candidate ARTIFACT as-is: skip the protocol / readiness /
  // candidate-quality / todo-sync gates below (their unmet facts remain
  // observable on this output's publishProtocol + readinessAudit) so the full
  // report the AI already wrote is delivered with honest limitations. Narrow:
  // requires the hard_veto escape flag AND non-empty candidate content (checked
  // above), so it never fires on a convergeable publish.
  const publishLoopEscape = isPublishLoopEscapeGranted(context && context.runState);
  if (!publishLoopEscape && !publishProtocol.finalizedAfterLatestWrite) {
    return createWorkspacePublishBlockedResult({
      candidateQualitySignal,
      context,
      file,
      finalReadiness,
      message: `workspace_publish_candidate requires workspace_finalize_candidate after the latest write to ${file.path}. Call workspace_finalize_candidate, read the latest candidate textStats, sync TodoState, and publish again.`,
      publishProtocol,
      readinessAudit,
      researchPublishRequired,
      status: "missing_finalize_after_latest_write"
    });
  }
  if (!publishLoopEscape && !publishProtocol.readAfterLatestContentChange) {
    return createWorkspacePublishBlockedResult({
      candidateQualitySignal,
      context,
      file,
      finalReadiness,
      // Counted message is computed inside createWorkspacePublishBlockedResult
      // so the `(N-th attempt)` prefix is consistent with publishBlockHistory.
      message: `workspace_publish_candidate requires workspace_read of the latest candidate content for ${file.path} AFTER the most recent workspace_write/append/insert_after_section/replace. If you just revised the candidate, your next action should be workspace_read on the same path; then sync TodoState and publish.`,
      publishProtocol,
      readinessAudit,
      researchPublishRequired,
      status: "missing_latest_workspace_read"
    });
  }
  if (!publishLoopEscape && !readinessAudit.ok) {
    return createWorkspacePublishBlockedResult({
      candidateQualitySignal,
      context,
      file,
      finalReadiness,
      message: readinessAudit.message,
      publishProtocol,
      readinessAudit,
      researchPublishRequired,
      status: "readiness_audit_failed"
    });
  }
  const candidateQualityBlock = inspectCandidateQualityPublishReadiness(candidateQualitySignal, finalReadiness, {
    limitedPublishAllowed: canPublishLimitedWithTerminalRepair(context, finalReadiness, file.path)
  });
  if (!publishLoopEscape && !candidateQualityBlock.ok) {
    return createWorkspacePublishBlockedResult({
      candidateQualitySignal,
      context,
      file,
      finalReadiness,
      message: candidateQualityBlock.message,
      publishProtocol,
      readinessAudit,
      researchPublishRequired,
      status: candidateQualityBlock.status
    });
  }
  const todoSyncAudit = inspectPublishTodoStateSync(context, finalReadiness, file.path);
  if (!publishLoopEscape && !todoSyncAudit.ok) {
    return createWorkspacePublishBlockedResult({
      candidateQualitySignal,
      context,
      file,
      finalReadiness,
      message: todoSyncAudit.message,
      publishProtocol,
      readinessAudit,
      researchPublishRequired,
      status: todoSyncAudit.status
    });
  }
  // ADR-0051 — host-defined output guardrails run as the LAST check before
  // terminalizing. Validation-only: a host guardrail may BLOCK (returns a
  // re-plan observation to the AI) but never authors content. It remains
  // authoritative even during publishLoopEscape; the escape prevents infinite
  // protocol/readiness repair loops, not host policy bypass.
  const guardrailBlock = await runOutputGuardrails(context, {
    candidateQualitySignal,
    file,
    finalReadiness
  });
  if (guardrailBlock) {
    return createWorkspacePublishBlockedResult({
      candidateQualitySignal,
      context,
      file,
      finalReadiness,
      message: `Output guardrail "${guardrailBlock.name}" blocked publish: ${guardrailBlock.reason}`,
      outputGuardrailBlock: guardrailBlock,
      publishProtocol,
      readinessAudit,
      researchPublishRequired,
      status: "output_guardrail_blocked"
    });
  }
  const sourcePayload = collectWorkspacePublishSources(context);
  const candidateTextWithSources = appendSourcesSection(candidateText, sourcePayload.sources);
  const terminalContract = applyTerminalFinalContract({
    finalReadiness,
    pushStep: context.pushStep,
    request: context.request,
    runState: context.runState,
    source: PUBLISH_DIRECT_ACTION,
    text: candidateTextWithSources
  });
  const text = terminalContract.text;
  const publishedCandidatePathMismatchSignal = recordWorkspacePublishCandidateLifecycle(context.runState, file.path, {
    completed: true,
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    prompt: context.request && context.request.prompt
  }) || candidatePathMismatchSignal;
  if (finalReadiness) {
    context.runState.researchFinalizeContract = {
      aiDeclaredReady: true,
      finalReadiness,
      finalReadinessAssessment: createFinalReadinessAssessment({
        finalReadiness,
        request: context.request,
        runtimeConfig: context.runtimeConfig,
        runState: context.runState
      }),
      kind: "ai_first_research_contract_observation",
      publishProtocol,
      readinessAudit,
      required: researchPublishRequired,
      source: PUBLISH_DIRECT_ACTION,
      status: "observed",
      successfulReadUrlCount: finalReadiness.requirementsAssessment && typeof finalReadiness.requirementsAssessment.successfulReadUrlCount === "number"
        ? finalReadiness.requirementsAssessment.successfulReadUrlCount
        : null
    };
  }
  return {
    control: "complete",
    output: {
      candidateAuditTrail: collectCandidateAuditTrail(workspace, file.path),
      candidateQualitySignal,
      candidatePathMismatchSignal: publishedCandidatePathMismatchSignal,
      citations: sourcePayload.citations,
      finalReadiness,
      finalReadinessAssessment: finalReadiness
        ? createFinalReadinessAssessment({
          finalReadiness,
          request: context.request,
          runtimeConfig: context.runtimeConfig,
          runState: context.runState
        })
        : null,
      kind: "final_response",
      model: context.request && context.request.model || null,
      provider: context.request && context.request.provider || null,
      publishProtocol,
      readinessAudit,
      researchPublishReadinessRequired: researchPublishRequired,
      terminalContractAudit: terminalContract.audit,
      text,
      workspaceCandidate: {
        path: file.path,
        size: text.length,
        textStats: file.textStats,
        updatedAt: file.updatedAt || null,
        version: file.version
      }
    },
    summary: `workspace_publish_candidate(${file.path}, chars=${text.length}, finalize_after_write=${publishProtocol.finalizedAfterLatestWrite ? "yes" : "no"}, read_after_finalize=${publishProtocol.readAfterFinalize ? "yes" : "no"}, readiness_ok=${readinessAudit.ok ? "yes" : "no"}, suffix_normalized=${terminalContract.audit && terminalContract.audit.suffixAudit && terminalContract.audit.suffixAudit.normalized ? "yes" : "no"})`
  };
}

function buildAndStoreCandidateQualitySignal(context, workspace, file, finalReadiness, options = {}) {
  const signal = normalizeCandidateQualitySignal(buildCandidateQualitySignal({
    context,
    file,
    finalReadiness,
    reviewRequired: options.reviewRequired === true,
    runState: context && context.runState,
    runtimeConfig: context && context.runtimeConfig,
    workspace
  }));
  if (context && context.runState && typeof context.runState === "object") {
    context.runState.candidateQualitySignal = signal;
    const runWorkspace = context.runState.virtualWorkspace && typeof context.runState.virtualWorkspace === "object"
      ? context.runState.virtualWorkspace
      : null;
    if (runWorkspace && runWorkspace.quality && typeof runWorkspace.quality === "object") {
      runWorkspace.quality.candidateQualitySignal = signal;
    }
  }
  if (workspace && workspace.quality && typeof workspace.quality === "object") {
    workspace.quality.candidateQualitySignal = signal;
  }
  return signal;
}

function inspectCandidateQualityPublishReadiness(signal, finalReadiness, options = {}) {
  const quality = normalizeCandidateQualitySignal(signal);
  if (!quality || quality.hasBlockingIssues !== true) return { ok: true };
  const codes = Array.isArray(quality.blockingIssueCodes) ? quality.blockingIssueCodes : [];
  if (codes.includes("missing_latest_candidate_review")) {
    return {
      ok: false,
      status: "missing_latest_candidate_review",
      message: "workspace_publish_candidate requires workspace_review_candidate after the latest workspace_read/content change before publishing this long-form candidate."
    };
  }
  const hardContentCodes = codes.filter((code) => (
    code === "blocked_source_cited" ||
    code === "unread_cited_url" ||
    code === "content_after_final_section"
  ));
  if (hardContentCodes.length > 0) {
    if (
      options.limitedPublishAllowed === true &&
      finalReadiness &&
      finalReadiness.decision === "limited"
    ) {
      return { ok: true };
    }
    return {
      ok: false,
      status: CANDIDATE_QUALITY_BLOCKED_REASON,
      message: `workspace_publish_candidate blocked by candidateQualitySignal issues: ${hardContentCodes.join(", ")}. Read/review the candidate and repair the content or publish limited only after removing invalid citations/structure blockers.`
    };
  }
  // Citation minimum: "limited" is an HONEST escape only when the model could
  // not obtain the sources. If it already READ enough readable sources but cited
  // fewer than the minimum, "limited" is evasion, not honesty — block regardless
  // of decision and tell it to cite the sources it already has.
  if (codes.includes("missing_required_cited_urls")) {
    const audit = quality.citationAudit;
    const minUrls = readNumber$6(quality.requestedCitations && quality.requestedCitations.minUrlCount);
    const readableSources = audit ? readNumber$6(audit.readableEvidenceUrlCount) : 0;
    if (minUrls > 0 && readableSources >= minUrls) {
      return {
        ok: false,
        status: CANDIDATE_QUALITY_BLOCKED_REASON,
        message: `workspace_publish_candidate blocked: candidate cites too few URLs but you already read ${readableSources} readable source(s) (minimum ${minUrls}). Add inline citations to the sources you read before publishing — "limited" is not allowed when the sources are available.`
      };
    }
  }
  if (finalReadiness && finalReadiness.decision === "ready") {
    return {
      ok: false,
      status: CANDIDATE_QUALITY_BLOCKED_REASON,
      message: `workspace_publish_candidate ready publish blocked by candidateQualitySignal issues: ${codes.join(", ")}. Repair the candidate or publish limited with concrete remainingGaps when the blocker is an honest unmet requirement.`
    };
  }
  return { ok: true };
}

function collectWorkspacePublishSources(context) {
  const runState = context && context.runState;
  const request = context && context.request;
  const scopedEvidenceUrls = readWorkspacePublishScopedEvidenceUrls(runState);
  const sourceLimit = Array.isArray(scopedEvidenceUrls)
    ? Math.max(3, scopedEvidenceUrls.length)
    : undefined;
  const payload = filterSourcesByEvidence(
    collectFinalResponseSources(runState && runState.researchContext, sourceLimit, {
      prompt: readFinalSourcePrompt(runState, request)
    }),
    scopedEvidenceUrls
  );
  if (payload.sources.length > 0) return payload;
  return collectWorkspacePublishReadSourceFallback(runState, sourceLimit);
}

function collectWorkspacePublishReadSourceFallback(runState, limit) {
  const readSources = Array.isArray(runState && runState.researchContext && runState.researchContext.readSources)
    ? runState.researchContext.readSources
    : [];
  const max = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 3;
  const sources = [];
  const seenUrls = new Set();
  for (const item of readSources) {
    if (!isReadableEvidenceSource(item)) continue;
    const url = readString$N(item && item.url);
    if (!url || seenUrls.has(url) || !isDirectEvidenceUrl(url)) continue;
    seenUrls.add(url);
    sources.push({
      kind: "read_url",
      title: readString$N(item && item.title) || url,
      url
    });
    if (sources.length >= max) break;
  }
  return {
    citations: sources.map((item) => item.url),
    sources
  };
}

function readWorkspacePublishScopedEvidenceUrls(runState) {
  if (!runState || typeof runState !== "object") return null;
  const scopedUrls = Array.isArray(runState.scopedEvidenceUrls) ? runState.scopedEvidenceUrls : null;
  const researchUrls = collectResearchEvidenceUrls(runState.researchContext);

  if (scopedUrls && scopedUrls.length === 0 && !isResearchEvidenceLoopActive(runState)) {
    return researchUrls.length > 0 ? researchUrls : null;
  }
  if (!scopedUrls) {
    return researchUrls.length > 0 ? researchUrls : null;
  }
  return scopedUrls;
}

function isResearchEvidenceLoopActive(runState) {
  const loop = runState && runState.researchReportLoop && typeof runState.researchReportLoop === "object"
    ? runState.researchReportLoop
    : null;
  if (!loop) return false;
  const status = readString$N(loop.status);
  return loop.enabled === true || Boolean(readString$N(loop.finalMode)) || Boolean(status && status !== "idle");
}

function isPublishLoopEscapeGranted(runState) {
  const repair = runState && runState.terminalRepairState && typeof runState.terminalRepairState === "object"
    ? runState.terminalRepairState
    : null;
  return Boolean(repair && repair.publishLoopEscapeGranted === true);
}

function createWorkspacePublishBlockedResult(options) {
  const file = options.file || {};
  const status = options.status || "blocked";
  const runState = options.context && options.context.runState && typeof options.context.runState === "object"
    ? options.context.runState
    : null;
  const outputGuardrailBlock = normalizeOutputGuardrailBlock(options.outputGuardrailBlock);
  const blockSignal = recordPublishBlockHistoryAndSignal(runState, status, {
    outputGuardrailBlock,
    reason: options.message
  });
  const sameStatusCount = blockSignal ? blockSignal.statusCounts[status] || 0 : 0;
  const totalCount = blockSignal ? blockSignal.count : 0;
  const cyclesUsed = blockSignal ? blockSignal.cyclesUsed : null;
  const cyclesMax = blockSignal ? blockSignal.cyclesMax : null;
  const cyclesRemaining = blockSignal ? blockSignal.cyclesRemaining : null;
  const counterPrefix = sameStatusCount > 1
    ? `[publish blocked attempt ${sameStatusCount} of status=${status}; total publish blocks this run=${totalCount}] `
    : `[publish blocked attempt 1 of status=${status}] `;
  const budgetSuffix = cyclesUsed != null && cyclesMax != null
    ? ` (cycles_used=${cyclesUsed}/${cyclesMax}${cyclesRemaining != null ? `, cycles_remaining=${cyclesRemaining}` : ""}; if you keep retrying without progress the run will hit maxSteps and force-stop with an error).`
    : "";
  // Prescription-grade feedback (weak-model trace walk 2026-06-10): the FIRST
  // rejection already names both exits (repair → ready, or honest limited with
  // the concrete args example) instead of waiting for an escalation ladder
  // that "responsive but wrong-direction" models never trigger.
  const publishPrescription = buildPublishPrescription({
    runState,
    status,
    citationCoverage: buildCitationCoverageAudit(
      typeof file.content === "string" ? file.content : "",
      runState
    )
  });
  const annotatedMessage = `${counterPrefix}${options.message}${budgetSuffix} ${publishPrescription.rule}`;
  const workspace = runState && runState.virtualWorkspace ? runState.virtualWorkspace : null;
  const candidatePathMismatchSignal = runState && runState.candidatePathMismatchSignal
    ? runState.candidatePathMismatchSignal
    : workspace && workspace.candidatePathMismatchSignal
      ? workspace.candidatePathMismatchSignal
      : null;
  return {
    control: "continue",
    output: {
      candidateAuditTrail: collectCandidateAuditTrail(workspace, file.path),
      candidateQualitySignal: options.candidateQualitySignal || null,
      candidatePathMismatchSignal,
      finalReadiness: options.finalReadiness || null,
      kind: "virtual_workspace_publish_blocked",
      message: annotatedMessage,
      outputGuardrailBlock,
      path: file.path || null,
      publishBlockSignal: blockSignal,
      publishPrescription,
      publishProtocol: options.publishProtocol || null,
      readinessAudit: options.readinessAudit || null,
      researchPublishReadinessRequired: options.researchPublishRequired === true,
      status,
      textStats: file.textStats || null
    },
    summary: `workspace_publish_candidate blocked(status=${status}, sameStatusCount=${sameStatusCount}, totalBlocks=${totalCount}${cyclesRemaining != null ? `, cycles_remaining=${cyclesRemaining}` : ""})`
  };
}

function normalizeOutputGuardrailBlock(value) {
  if (!value || typeof value !== "object") return null;
  return {
    info: value.info != null ? value.info : null,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : null,
    reason: typeof value.reason === "string" && value.reason.trim() ? value.reason.trim() : null
  };
}

// ADR-0051 — run host-defined output guardrails over the publish-readiness
// FACTS. Returns the first { name, reason, info } block, or null if all pass.
// A guardrail is validation-only: it returns { block, reason?, info? } and
// never authors content. A throwing host guardrail must NOT crash the run —
// it is recorded (observable) and treated as non-blocking.
async function runOutputGuardrails(context, options) {
  const guardrails = context
    && context.runtimeConfig
    && Array.isArray(context.runtimeConfig.outputGuardrails)
    ? context.runtimeConfig.outputGuardrails
    : [];
  if (guardrails.length === 0) return null;
  const file = options.file || {};
  const args = {
    candidate: typeof file.content === "string" ? file.content : "",
    candidateQualitySignal: options.candidateQualitySignal || null,
    finalReadiness: options.finalReadiness || null,
    runState: context && context.runState ? context.runState : null
  };
  for (const guardrail of guardrails) {
    let result = null;
    try {
      result = await guardrail.execute(args);
    } catch (error) {
      if (context && typeof context.pushStep === "function") {
        context.pushStep("output-guardrail-error", {
          name: guardrail.name,
          error: error && error.message ? String(error.message) : String(error)
        });
      }
      continue;
    }
    if (result && typeof result === "object" && result.block === true) {
      const reason = typeof result.reason === "string" && result.reason.trim()
        ? result.reason.trim()
        : `Output guardrail "${guardrail.name}" blocked publish.`;
      return { name: guardrail.name, reason, info: result.info != null ? result.info : null };
    }
  }
  return null;
}

// Pure read-only projection of the workspace operations log filtered
// to the candidate path. Surfaced on both the success and blocked
// envelopes of workspace_publish_candidate so inspectors (and AI
// itself on retry) can see how the candidate evolved across cycles
// without runtime keeping any extra history. Capped at the last 12
// ops to keep payload bounded.
function collectCandidateAuditTrail(workspace, path) {
  if (!workspace || typeof workspace !== "object") return [];
  if (!Array.isArray(workspace.operations)) return [];
  const filePath = readString$N(path);
  if (!filePath) return [];
  return workspace.operations
    .filter((operation) => operation && operation.path === filePath)
    .slice(-12)
    .map((operation) => ({
      action: readString$N(operation.action) || "workspace",
      cycle: Number.isInteger(operation.cycle) ? operation.cycle : 0,
      status: readString$N(operation.status) || "ok",
      summary: readString$N(operation.summary)
    }));
}

// Push one entry into runState.publishBlockHistory and refresh
// runState.publishBlockSignal so the next planner cycle sees the
// running totals + maxSteps budget. Mirrors actionFailureSignal
// (ADR-0026) — read-only signal, runtime never decides when to stop.
function recordPublishBlockHistoryAndSignal(runState, status, options = {}) {
  if (!runState || typeof runState !== "object") return null;
  const cycle = Number.isInteger(runState.cycleCount) && runState.cycleCount >= 0
    ? runState.cycleCount
    : 0;
  if (!Array.isArray(runState.publishBlockHistory)) {
    runState.publishBlockHistory = [];
  }
  const outputGuardrailBlock = options.outputGuardrailBlock && typeof options.outputGuardrailBlock === "object"
    ? options.outputGuardrailBlock
    : null;
  const reason = readString$N(options.reason);
  runState.publishBlockHistory.push({
    actionName: PUBLISH_DIRECT_ACTION,
    cycle,
    outputGuardrailBlock,
    reason,
    status
  });
  // Cap history at 50 entries to keep snapshot/clone bounded.
  if (runState.publishBlockHistory.length > 50) {
    runState.publishBlockHistory.splice(0, runState.publishBlockHistory.length - 50);
  }
  const statusCounts = {};
  let lastStatus = null;
  let lastCycle = null;
  for (const entry of runState.publishBlockHistory) {
    const entryStatus = entry && typeof entry.status === "string" ? entry.status : "blocked";
    statusCounts[entryStatus] = (statusCounts[entryStatus] || 0) + 1;
    lastStatus = entryStatus;
    if (Number.isInteger(entry && entry.cycle)) lastCycle = entry.cycle;
  }
  const cyclesMax = Number.isInteger(runState.maxSteps) && runState.maxSteps > 0
    ? runState.maxSteps
    : null;
  const cyclesUsed = Number.isInteger(runState.cycleCount) && runState.cycleCount >= 0
    ? runState.cycleCount
    : null;
  const cyclesRemaining = cyclesMax != null && cyclesUsed != null
    ? Math.max(0, cyclesMax - cyclesUsed)
    : null;
  const signal = {
    count: runState.publishBlockHistory.length,
    cyclesMax,
    cyclesRemaining,
    cyclesUsed,
    kind: "publish_block_signal",
    lastCycle,
    lastStatus,
    outputGuardrailBlock,
    reason,
    statusCounts
  };
  runState.publishBlockSignal = signal;
  return signal;
}

function inspectPublishReadiness(context, workspace, file, finalReadiness) {
  const readinessRequired = isResearchPublishReadinessRequired(context);
  if (!readinessRequired && !finalReadiness) {
    return { ok: true };
  }
  if (!finalReadiness) {
    return {
      ok: false,
      message: "workspace_publish_candidate requires finalReadiness for this publish. Declare ready or limited with requirementsAssessment based on the latest workspace_read stats."
    };
  }
  const assessment = finalReadiness.requirementsAssessment;
  if (!assessment || typeof assessment !== "object") {
    return {
      ok: false,
      message: "workspace_publish_candidate requires finalReadiness.requirementsAssessment based on the latest workspace_read stats."
    };
  }
  const lastRead = workspace && workspace.quality && workspace.quality.lastRead;
  if (!lastRead || lastRead.path !== file.path || !lastRead.textStats) {
    return {
      ok: false,
      message: `workspace_publish_candidate requires the latest workspace_read to review ${file.path} before publish.`
    };
  }
  // AGRUN-244 Phase 3 — structure is a display-only observation, not a publish
  // block. The literal duplicate-heading check is gameable (renamed duplicates
  // evade it); the AI sees the structure facts in observations and decides.
  //
  // AGRUN-402 — runtime no longer flips the AI-declared `checkedWorkspaceStats`
  // boolean from false→true. The lastRead gate above is the runtime-observed
  // SSOT proof that this file's workspace stats were read; the AI's boolean is
  // a redundant self-attestation runtime must not rewrite, and nothing
  // downstream blocks publish on it. Whatever the AI declared stands.
  if (!readString$N(assessment.observedLengthUnit)) {
    const requestedLength = extractRequestedLengthContract(readTerminalContractText(context));
    const observedUnit = requestedLength ? requestedLength.unit : "chars";
    assessment.observedLengthUnit = observedUnit;
    recordPublishAutoCorrection(context && context.runState, {
      declared: null,
      field: "finalReadiness.requirementsAssessment.observedLengthUnit",
      kind: "observed_length_unit_auto_corrected",
      observed: observedUnit
    });
  }
  const statsKey = readStatsKeyForUnit(assessment.observedLengthUnit);
  const actualObserved = readNumber$6(lastRead.textStats[statsKey]);
  const observedLength = typeof assessment.observedLength === "number" && Number.isFinite(assessment.observedLength)
    ? assessment.observedLength
    : null;
  if (observedLength == null || observedLength !== actualObserved) {
    assessment.observedLength = actualObserved;
    recordPublishAutoCorrection(context && context.runState, {
      declared: observedLength,
      field: "finalReadiness.requirementsAssessment.observedLength",
      kind: observedLength == null
        ? "observed_length_auto_filled"
        : "observed_length_auto_corrected",
      observed: actualObserved
    });
  }
  const successfulEvidenceCount = typeof assessment.successfulEvidenceCount === "number" && Number.isFinite(assessment.successfulEvidenceCount)
    ? assessment.successfulEvidenceCount
    : null;
  const actualSuccessfulEvidenceCount = countSuccessfulEvidenceArtifacts(context && context.runState, context && context.runtimeConfig);
  const successfulReadUrlCount = typeof assessment.successfulReadUrlCount === "number" && Number.isFinite(assessment.successfulReadUrlCount)
    ? assessment.successfulReadUrlCount
    : null;
  const actualSuccessfulReadUrlCount = countSuccessfulReadUrlArtifacts(context && context.runState);
  if (successfulEvidenceCount != null && successfulEvidenceCount !== actualSuccessfulEvidenceCount) {
    assessment.successfulEvidenceCount = actualSuccessfulEvidenceCount;
    recordPublishAutoCorrection(context && context.runState, {
      declared: successfulEvidenceCount,
      field: "finalReadiness.requirementsAssessment.successfulEvidenceCount",
      kind: "successful_evidence_count_auto_corrected",
      observed: actualSuccessfulEvidenceCount
    });
  }
  if (successfulReadUrlCount != null && successfulReadUrlCount !== actualSuccessfulReadUrlCount) {
    // Fix C1 — auto-correct the AI's mis-declared count to the observed
    // value rather than blocking. Same pattern as Fix A (commit 32d4a7921):
    // when an AI-declared self-report disagrees with a runtime-observed
    // fact runtime already computes (countSuccessfulReadUrlArtifacts is
    // the SSOT), runtime overrides the declaration. Live evidence: TNO
    // session 2 burned 27/32 publish attempts on this exact mismatch
    // (declared=3 observed=2), exhausting maxSteps with finalCandidate
    // already complete. AI never figured out the correction text in the
    // prompt; the loop is deterministic-correctable.
    //
    // AI-first compliance: runtime makes NO content decision and NO
    // readiness decision (decision=ready vs limited is still AI's).
    // It only aligns one numeric field to data runtime owns. Downstream
    // sourceMinimum gate is unaffected — sourceMinimum is computed from
    // readSources/relevantSources, not successfulReadUrlCount, so a
    // smaller successfulReadUrlCount does not falsely satisfy a gate.
    assessment.successfulReadUrlCount = actualSuccessfulReadUrlCount;
    recordPublishAutoCorrection(context && context.runState, {
      declared: successfulReadUrlCount,
      field: "finalReadiness.requirementsAssessment.successfulReadUrlCount",
      kind: "successful_read_url_count_auto_corrected",
      observed: actualSuccessfulReadUrlCount
    });
    // Fall through to the remaining audits with the corrected value.
  }
  const researchState = context && context.runState && context.runState.researchState && typeof context.runState.researchState === "object"
    ? context.runState.researchState
    : null;
  const researchGateBlocked = Boolean(
    researchState &&
    researchState.qualityGateRequired === true &&
    researchState.finalAllowed === false
  );
  const sourceMinimum = readPublishSourceMinimum(context && context.runState);
  const sourceMinimumFailed = Boolean(sourceMinimum && sourceMinimum.passed === false && readinessRequired);
  // Length is never runtime-authored content. Runtime owns the mechanical
  // latest-read number, while the AI still owns ready/limited judgment below.
  if (finalReadiness.decision === "ready" && assessment.evidenceSatisfied === false) {
    const recoveryActions = formatEvidenceRecoveryActions(context && context.runtimeConfig);
    return {
      ok: false,
      message: `workspace_publish_candidate readiness is internally inconsistent: decision=ready but evidenceSatisfied is false. Continue evidence work (${recoveryActions}), or publish as limited with concrete blockers.`
    };
  }
  if (canPublishLimitedWithTerminalRepair(context, finalReadiness, file.path)) {
    return { ok: true };
  }
  const sourceReadinessIssue = inspectSourceMinimumPublishReadiness({
    assessment,
    finalReadiness,
    researchGateBlocked,
    runtimeConfig: context && context.runtimeConfig,
    researchState,
    sourceMinimumFailed
  });
  if (sourceReadinessIssue) return sourceReadinessIssue;
  const recoveryAudit = inspectLimitedRecoveryReadiness(context && context.runState, {
    finalReadiness,
    request: context && context.request,
    runtimeConfig: context && context.runtimeConfig
  });
  if (!recoveryAudit.ok) {
    return {
      ok: false,
      message: recoveryAudit.message,
      requirementRecoveryEvaluator: recoveryAudit.evaluator
    };
  }
  return { ok: true };
}

function recordPublishAutoCorrection(runState, correction) {
  if (!runState || typeof runState !== "object") return;
  if (!Array.isArray(runState.publishAutoCorrections)) {
    runState.publishAutoCorrections = [];
  }
  runState.publishAutoCorrections.push({
    cycle: Number.isInteger(runState.cycleCount) ? runState.cycleCount : 0,
    declared: correction && correction.declared,
    field: readString$N(correction && correction.field),
    kind: readString$N(correction && correction.kind) || "publish_auto_corrected",
    observed: correction && correction.observed
  });
  // Cap log at 20 entries so snapshots stay bounded.
  if (runState.publishAutoCorrections.length > 20) {
    runState.publishAutoCorrections.splice(0, runState.publishAutoCorrections.length - 20);
  }
}

function canPublishLimitedWithTerminalRepair(context, finalReadiness, publishPath) {
  const repair = context &&
    context.runState &&
    context.runState.terminalRepairState &&
    typeof context.runState.terminalRepairState === "object"
    ? context.runState.terminalRepairState
    : null;
  if (!repair || repair.active !== true) return false;
  if (!Array.isArray(repair.allowedActions) || !repair.allowedActions.includes(PUBLISH_DIRECT_ACTION)) {
    return false;
  }
  return isValidTerminalRepairPublishArgs({ finalReadiness, path: publishPath }, repair, {
    runState: context && context.runState
  });
}

function readPublishSourceMinimum(runState) {
  const packetSourceMinimum = runState &&
    runState.researchReportLoop &&
    runState.researchReportLoop.gateSignal &&
    runState.researchReportLoop.gateSignal.acceptancePacket &&
    runState.researchReportLoop.gateSignal.acceptancePacket.evidence &&
    runState.researchReportLoop.gateSignal.acceptancePacket.evidence.sourceMinimum &&
    typeof runState.researchReportLoop.gateSignal.acceptancePacket.evidence.sourceMinimum === "object"
    ? runState.researchReportLoop.gateSignal.acceptancePacket.evidence.sourceMinimum
    : null;
  const loopSourceMinimum = runState &&
    runState.researchReportLoop &&
    runState.researchReportLoop.sourceMinimum &&
    typeof runState.researchReportLoop.sourceMinimum === "object"
    ? runState.researchReportLoop.sourceMinimum
    : null;
  const source = packetSourceMinimum || loopSourceMinimum;
  if (!source) return null;
  return {
    minReadSources: readNumber$6(source.minReadSources),
    minRelevantSources: readNumber$6(source.minRelevantSources),
    passed: source.passed === true,
    readSources: readNumber$6(source.readSources),
    relevantSources: readNumber$6(source.relevantSources)
  };
}

function inspectSourceMinimumPublishReadiness(options) {
  const assessment = options && options.assessment;
  const finalReadiness = options && options.finalReadiness;
  const researchState = options && options.researchState;
  const blocked = Boolean(options && (options.researchGateBlocked || options.sourceMinimumFailed));
  if (!blocked) return null;
  const recoveryActions = formatEvidenceRecoveryActions(options && options.runtimeConfig);
  const finalReason = readString$N(researchState && researchState.finalReason) || "research gate or source minimum still reports evidence gaps";
  if (
    finalReadiness &&
    finalReadiness.decision === "limited" &&
    (!Array.isArray(assessment && assessment.remainingGaps) || assessment.remainingGaps.length === 0)
  ) {
    return {
      ok: false,
      message: `workspace_publish_candidate limited publish needs concrete remainingGaps while evidence/source minimum is blocked (${finalReason}). Continue evidence gathering with ${recoveryActions}, or publish limited with evidenceSatisfied=false and non-empty requirementsAssessment.remainingGaps.`
    };
  }
  if (
    finalReadiness &&
    finalReadiness.decision === "limited" &&
    assessment &&
    assessment.evidenceSatisfied !== false
  ) {
    return {
      ok: false,
      message: `workspace_publish_candidate limited publish must declare evidenceSatisfied=false while evidence/source minimum is blocked (${finalReason}). Continue configured evidence work (${recoveryActions}), or publish limited with concrete evidence blockers in requirementsAssessment.remainingGaps.`
    };
  }
  if (
    finalReadiness &&
    finalReadiness.decision === "limited" &&
    assessment &&
    assessment.requirementSatisfied !== false
  ) {
    return {
      ok: false,
      message: `workspace_publish_candidate limited publish must declare requirementSatisfied=false while evidence/source minimum is blocked (${finalReason}). Continue evidence work, or publish limited with concrete blockers.`
    };
  }
  if (assessment && assessment.evidenceSatisfied === true) {
    return {
      ok: false,
      message: `workspace_publish_candidate readiness conflicts with evidence/source facts: evidenceSatisfied=true while source minimum or Research Gate is blocked (${finalReason}). Continue evidence gathering with ${recoveryActions}, or publish limited with evidenceSatisfied=false and concrete remainingGaps.`
    };
  }
  if (finalReadiness && finalReadiness.decision === "ready") {
    return {
      ok: false,
      message: `workspace_publish_candidate readiness conflicts with evidence/source facts: decision=ready while source minimum or Research Gate is blocked (${finalReason}). Continue evidence gathering with ${recoveryActions}, or publish limited with concrete blockers.`
    };
  }
  return null;
}

function inspectPublishTodoStateSync(context, finalReadiness, publishPath) {
  const todoState = context && context.runState && context.runState.todoState;
  if (!todoState || typeof todoState !== "object") return { ok: true };
  if (todoState.terminatedAt) return { ok: true };
  const items = Array.isArray(todoState.items) ? todoState.items : [];
  if (items.length === 0) return { ok: true };
  const unfinished = items.filter((item) => {
    const status = readString$N(item && item.status) || "pending";
    return status === "active" || status === "pending" || status === "blocked";
  });
  if (unfinished.length === 0) return { ok: true };
  if (canPublishLimitedWithUnfinishedTodo(context, finalReadiness, publishPath)) {
    return {
      ok: true,
      status: "todo_state_limited_with_remaining_gaps"
    };
  }
  const activeItem = findActiveTodoItem$1(todoState, items);
  const activeLabel = readString$N(activeItem && activeItem.label) || readString$N(unfinished[0] && unfinished[0].label) || "current TodoState item";
  const statusSummary = countTodoStatuses(items);
  return {
    ok: false,
    status: "todo_state_not_synced",
    message: `workspace_publish_candidate cannot be terminal while TodoState still has unfinished work. Active item: "${activeLabel}". Counts: done=${statusSummary.done}, active=${statusSummary.active}, pending=${statusSummary.pending}, blocked=${statusSummary.blocked}, abandoned=${statusSummary.abandoned}, total=${statusSummary.total}. If the work is complete, choose todo_run_next or todo_advance before publishing; if the plan changed, use todo_plan or todo_cancel. Runtime will not auto-complete TodoState for the AI.`
  };
}

function canPublishLimitedWithUnfinishedTodo(context, finalReadiness, publishPath) {
  const repair = context &&
    context.runState &&
    context.runState.terminalRepairState &&
    typeof context.runState.terminalRepairState === "object"
    ? context.runState.terminalRepairState
    : null;
  if (!repair || repair.active !== true) return false;
  if (!Array.isArray(repair.activeDeficits) || !repair.activeDeficits.includes("todo")) return false;
  if (!Array.isArray(repair.allowedActions) || !repair.allowedActions.includes(PUBLISH_DIRECT_ACTION)) {
    return false;
  }
  if (!isBudgetConstrainedForLimitedPublish(repair)) return false;
  return isValidTerminalRepairPublishArgs({ finalReadiness, path: publishPath }, repair, {
    runState: context && context.runState
  });
}

function findActiveTodoItem$1(todoState, items) {
  const activeItemId = readString$N(todoState && todoState.activeItemId);
  if (activeItemId) {
    const byId = items.find((item) => item && item.id === activeItemId && item.status === "active");
    if (byId) return byId;
  }
  return items.find((item) => item && item.status === "active") || null;
}

function countTodoStatuses(items) {
  const counts = {
    abandoned: 0,
    active: 0,
    blocked: 0,
    done: 0,
    pending: 0,
    total: 0
  };
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    counts.total += 1;
    const status = readString$N(item.status) || "pending";
    if (status === "done") counts.done += 1;
    else if (status === "active") counts.active += 1;
    else if (status === "blocked") counts.blocked += 1;
    else if (status === "abandoned") counts.abandoned += 1;
    else counts.pending += 1;
  }
  return counts;
}

function isResearchPublishReadinessRequired(context) {
  const runState = context && context.runState;
  if (!runState || typeof runState !== "object") return false;
  if (isResearchQualityGateRequired(runState, { prompt: context.request && context.request.prompt })) return true;
  const activeSkill = runState.agentSkillContext && runState.agentSkillContext.activeSkill;
  return activeSkill != null &&
    activeSkill.capabilities != null &&
    activeSkill.capabilities.requiresPublishReadiness === true;
}

function ensureWorkspace(context) {
  if (!context || !context.runState) {
    throw new Error("workspace action requires runState");
  }
  return ensureVirtualWorkspace(context.runState, {
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    force: true,
    prompt: context.request && context.request.prompt
  });
}

function preflightWorkspacePath(_context, args) {
  validateWorkspacePath(args && args.path);
}

// Read-before-mutate gate (study from claude-code FileEditTool — the
// readFileState invariant). Pure observation: only enforces the gate
// when there IS existing non-empty content the AI could be mutating
// without seeing. New files (no existing content) skip the check
// because writing into an empty slot is unambiguous. Missing runState
// (preflight unit tests pass {} as context) also skips the check; the
// gate runs at action execute time with full context.

function preflightWorkspaceMutationRequiresRead(context, args) {
  validateWorkspacePath(args && args.path);
  const runState = context && context.runState;
  if (!runState || typeof runState !== "object") return;
  const workspace = runState.virtualWorkspace;
  if (!workspace || typeof workspace !== "object") return;
  const files = workspace.files && typeof workspace.files === "object" ? workspace.files : {};
  const file = files[args.path];
  const currentContent = file && typeof file.content === "string" ? file.content : "";
  if (!currentContent.trim()) return;
  const lastRead = workspace.quality && workspace.quality.lastRead;
  if (!lastRead || lastRead.path !== args.path) {
    throw new Error(`workspace mutation on ${args.path}: workspace_read this file first so you see the current ${currentContent.length}-char content before editing.`);
  }
  const readAt = readString$N(lastRead.observedAt);
  const updatedAt = readString$N(file && file.updatedAt);
  if (readAt && updatedAt && readAt < updatedAt) {
    throw new Error(`workspace mutation on ${args.path}: file changed since last workspace_read (read=${readAt}, updated=${updatedAt}); workspace_read it again before editing.`);
  }
}

function summarizeLengthProgress(context, file) {
  const requested = extractRequestedLengthContract(readTerminalContractText(context));
  if (!requested) return null;
  const safeFile = file && typeof file === "object" ? file : {};
  const stats = safeFile.textStats && typeof safeFile.textStats === "object"
    ? safeFile.textStats
    : summarizeTextStats(safeFile.content);
  const observed = readNumber$6(stats[requested.statsKey]);
  const remaining = Math.max(0, requested.value - observed);
  return {
    lengthSatisfied: remaining === 0,
    observedLength: observed,
    observedLengthUnit: requested.unit,
    remainingLength: remaining,
    requestedLength: requested.value,
    statsKey: requested.statsKey,
    status: remaining === 0 ? "satisfied" : "below_requested"
  };
}

function summarizeMutationStats(beforeFile, afterFile, addedContent) {
  const beforeStats = summarizeFileStats(beforeFile);
  const afterStats = summarizeFileStats(afterFile);
  return {
    addedTextStats: summarizeTextStats(addedContent),
    delta: {
      chars: afterStats.chars - beforeStats.chars,
      cjkChars: afterStats.cjkChars - beforeStats.cjkChars,
      nonWhitespaceChars: afterStats.nonWhitespaceChars - beforeStats.nonWhitespaceChars,
      words: afterStats.words - beforeStats.words
    }
  };
}

function summarizeWorkspacePathsStats(workspace, paths) {
  const safeWorkspace = workspace && typeof workspace === "object" ? workspace : {};
  const files = safeWorkspace.files && typeof safeWorkspace.files === "object" ? safeWorkspace.files : {};
  const totals = { chars: 0, cjkChars: 0, nonWhitespaceChars: 0, words: 0 };
  for (const filePath of Array.isArray(paths) ? paths : []) {
    const stats = summarizeFileStats(files[filePath]);
    totals.chars += stats.chars;
    totals.cjkChars += stats.cjkChars;
    totals.nonWhitespaceChars += stats.nonWhitespaceChars;
    totals.words += stats.words;
  }
  return totals;
}

function summarizeAggregateMutationStats(beforeStats, afterStats) {
  const before = beforeStats && typeof beforeStats === "object" ? beforeStats : {};
  const after = afterStats && typeof afterStats === "object" ? afterStats : {};
  return {
    delta: {
      chars: readNumber$6(after.chars) - readNumber$6(before.chars),
      cjkChars: readNumber$6(after.cjkChars) - readNumber$6(before.cjkChars),
      nonWhitespaceChars: readNumber$6(after.nonWhitespaceChars) - readNumber$6(before.nonWhitespaceChars),
      words: readNumber$6(after.words) - readNumber$6(before.words)
    }
  };
}

function summarizeWorkspaceRead(file, context) {
  const progress = summarizeLengthProgress(context, file);
  const base = `workspace_read(${file.path}, ${formatTextStats(file.textStats)}`;
  if (!progress) return `${base})`;
  return `${base}, requested${capitalize(progress.observedLengthUnit)}=${progress.requestedLength}, remaining${capitalize(progress.observedLengthUnit)}=${progress.remainingLength})`;
}

function summarizeWorkspaceMutation(actionName, file, context) {
  const safeFile = file && typeof file === "object" ? file : {};
  const stats = summarizeFileStats(safeFile);
  const progress = summarizeLengthProgress(context, safeFile);
  const path = readString$N(safeFile.path) || "<unknown>";
  const pieces = [`${actionName}(${path}`, `chars=${stats.chars}`, `words=${stats.words}`];
  if (progress) {
    pieces.push(`requested${capitalize(progress.observedLengthUnit)}=${progress.requestedLength}`);
    pieces.push(`remaining${capitalize(progress.observedLengthUnit)}=${progress.remainingLength}`);
  }
  return `${pieces.join(", ")})`;
}

function summarizeFileStats(file) {
  const safeFile = file && typeof file === "object" ? file : {};
  if (safeFile.textStats && typeof safeFile.textStats === "object") {
    return {
      chars: readNumber$6(safeFile.textStats.chars),
      cjkChars: readNumber$6(safeFile.textStats.cjkChars),
      nonWhitespaceChars: readNumber$6(safeFile.textStats.nonWhitespaceChars),
      words: readNumber$6(safeFile.textStats.words)
    };
  }
  return summarizeTextStats(safeFile.content);
}

function summarizeFile(file) {
  const safe = file && typeof file === "object" ? file : {};
  const content = typeof safe.content === "string" ? safe.content : "";
  return {
    hasContent: content.length > 0,
    path: typeof safe.path === "string" ? safe.path : null,
    size: content.length,
    textStats: summarizeTextStats(content),
    updatedAt: safe.updatedAt || null,
    version: safe.version || 0
  };
}

function readString$N(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber$6(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function capitalize(value) {
  const source = readString$N(value);
  if (!source) return "";
  return source.slice(0, 1).toUpperCase() + source.slice(1);
}

function summarizeTextStats(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const latinWords = text.match(/[A-Za-z0-9]+(?:[.'_-][A-Za-z0-9]+)*/g) || [];
  const cjkChars = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g) || [];
  return {
    chars: text.length,
    cjkChars: cjkChars.length,
    nonWhitespaceChars: text.replace(/\s/g, "").length,
    words: latinWords.length
  };
}

function formatTextStats(stats) {
  const source = stats && typeof stats === "object" ? stats : {};
  return `chars=${source.chars || 0}, nonWhitespace=${source.nonWhitespaceChars || 0}, cjk=${source.cjkChars || 0}, words=${source.words || 0}`;
}

export { executeWorkspaceApplyPatchAction, executeWorkspaceFinalizeCandidateAction, executeWorkspaceInsertAfterSectionAction, executeWorkspaceListAction, executeWorkspaceMoveAction, executeWorkspaceMultiEditAction, executeWorkspaceProposePatchAction, executeWorkspacePublishCandidateAction, executeWorkspaceReadAction, executeWorkspaceRemoveAction, executeWorkspaceReplaceAction, executeWorkspaceReviewCandidateAction, executeWorkspaceWriteAction, workspaceApplyPatchAction, workspaceFinalizeCandidateAction, workspaceInsertAfterSectionAction, workspaceListAction, workspaceMoveAction, workspaceMultiEditAction, workspaceProposePatchAction, workspacePublishCandidateAction, workspaceReadAction, workspaceRemoveAction, workspaceReplaceAction, workspaceReviewCandidateAction, workspaceWriteAction };
