import { FINALIZE_CANDIDATE_ACTION, PUBLISH_DIRECT_ACTION } from '../action-names.js';
import { DEFAULT_FINAL_CANDIDATE_PATH } from '../workspace-candidate-lifecycle.js';
import { validateWorkspacePath } from '../virtual-workspace.js';
import { STANDALONE_PLAN_ACTION } from '../action-plan-contract.js';
import { preflightWorkspacePath, preflightWorkspaceMutationRequiresRead } from './workspace/workspace-preflight.js';
import { executeWorkspaceFinalizeCandidateAction, executeWorkspaceReviewCandidateAction, executeWorkspacePublishCandidateAction } from './workspace/workspace-candidate-executors.js';
import { executeWorkspaceListAction, executeWorkspaceReadAction, executeWorkspaceWriteAction, executeWorkspaceReplaceAction, executeWorkspaceProposePatchAction, executeWorkspaceApplyPatchAction, executeWorkspaceInsertAfterSectionAction, executeWorkspaceRemoveAction, executeWorkspaceMoveAction, executeWorkspaceMultiEditAction } from './workspace/workspace-edit-executors.js';

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
      path: DEFAULT_FINAL_CANDIDATE_PATH,
      summary: "preview heading normalization patch"
    },
    argsSchema: {
      applyIfValid: { type: "boolean" },
      operations: { type: "array", required: true },
      path: { type: "string", required: true },
      summary: { type: "string" }
    },
    decisionType: "action",
    guidance: "Use workspace_propose_patch before risky candidate repair. Valid operations are exactly: {type:\"append\",content:\"...\"}, {type:\"insert_after_section\",heading:\"Existing Heading\",content:\"...\"}, {type:\"replace\",find:\"exact current text\",replace:\"new text\",replace_all?:true}, or {type:\"normalize_headings\",headings:[{\"lineNumber\":42,\"text\":\"## 4. Unique Heading\"}]}. Use normalize_headings alone only for exact duplicate headings/section numbers shown in duplicate_heading_context, duplicate_section_number_context, or section_number_repair_context; runtime changes only those Markdown heading lines and validates structure. Do not use normalize_headings for semantic_duplicate_heading_context or body_after_final_section_context because those require merging/removing content blocks with replace/write/multi_edit. For heading-only normalize_headings repair, set applyIfValid:true to avoid a separate workspace_apply_patch cycle; if the preview has blocking riskFlags it will not apply. If length is already satisfied and the visible issue is exact duplicate heading/section-number context, send exactly one normalize_headings operation. Do not mix normalize_headings with replace unless the exact current find text is visible in the prompt and heading-only repair cannot improve structure. The JSON key must be \"lineNumber\" with a numeric value, not \"lineNumber:42\". Do not send {type:\"replace\",content:\"full document\"}; replace needs find+replace and will be blocked without a non-empty find. If riskFlags include no_growth, content_structure_not_repaired, not_found, ambiguous, or structure_maybe_worse, revise the patch or use workspace_replace/workspace_write/workspace_multi_edit only when those actions are currently allowed instead of finalizing."
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
      path: DEFAULT_FINAL_CANDIDATE_PATH,
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
      to: DEFAULT_FINAL_CANDIDATE_PATH,
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
      path: DEFAULT_FINAL_CANDIDATE_PATH,
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
      path: DEFAULT_FINAL_CANDIDATE_PATH,
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
      path: DEFAULT_FINAL_CANDIDATE_PATH
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

export { executeWorkspaceApplyPatchAction, executeWorkspaceFinalizeCandidateAction, executeWorkspaceInsertAfterSectionAction, executeWorkspaceListAction, executeWorkspaceMoveAction, executeWorkspaceMultiEditAction, executeWorkspaceProposePatchAction, executeWorkspacePublishCandidateAction, executeWorkspaceReadAction, executeWorkspaceRemoveAction, executeWorkspaceReplaceAction, executeWorkspaceReviewCandidateAction, executeWorkspaceWriteAction, workspaceApplyPatchAction, workspaceFinalizeCandidateAction, workspaceInsertAfterSectionAction, workspaceListAction, workspaceMoveAction, workspaceMultiEditAction, workspaceProposePatchAction, workspacePublishCandidateAction, workspaceReadAction, workspaceRemoveAction, workspaceReplaceAction, workspaceReviewCandidateAction, workspaceWriteAction };
