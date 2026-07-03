// AGRUN-448 — the ONE place every registered runtime action NAME literal lives.
//
// Generic control-flow sites (convergence name-guards, budget switches, repair
// allow-lists, planner-prompt checks) only have the action NAME-string in scope,
// with no action object to route on. Instead of scattering the literal across
// ~180 comparison sites, those sites import the constant from here, so a rename
// is a single-file change and a typo is caught by the parity guard
// (test/unit/action-names.test.js asserts ACTION_NAMES === the action registry's
// BUILT_IN_ACTION_NAMES, bidirectionally).
//
// This module has NO imports (pure data) so it can be imported anywhere without a
// cycle. kernel-terminal-actions.js re-exports the two terminal constants from
// here for its existing importers — there is exactly one SSOT.
//
// NOTE: planner DECISION-TYPE literals (action / plan / final / finalize) and
// status / event / output-kind / error-code strings are NOT registered action
// names and are deliberately absent.

const WEB_SEARCH_ACTION = "web_search";
const READ_URL_ACTION = "read_url";
const HANDOFF_TO_SKILL_ACTION = "handoff_to_skill";
const SPAWN_SUBAGENT_ACTION = "spawn_subagent";

const TODO_PLAN_ACTION = "todo_plan";
const TODO_ADVANCE_ACTION = "todo_advance";
const TODO_CANCEL_ACTION = "todo_cancel";
const TODO_RUN_NEXT_ACTION = "todo_run_next";
const TODO_INSPECT_ACTION = "todo_inspect";

const WORKSPACE_LIST_ACTION = "workspace_list";
const WORKSPACE_READ_ACTION = "workspace_read";
const WORKSPACE_WRITE_ACTION = "workspace_write";
const WORKSPACE_REPLACE_ACTION = "workspace_replace";
const WORKSPACE_PROPOSE_PATCH_ACTION = "workspace_propose_patch";
const WORKSPACE_APPLY_PATCH_ACTION = "workspace_apply_patch";
const WORKSPACE_INSERT_AFTER_SECTION_ACTION = "workspace_insert_after_section";
const WORKSPACE_REMOVE_ACTION = "workspace_remove";
const WORKSPACE_MOVE_ACTION = "workspace_move";
const WORKSPACE_MULTI_EDIT_ACTION = "workspace_multi_edit";
const FINALIZE_CANDIDATE_ACTION = "workspace_finalize_candidate";
const WORKSPACE_REVIEW_CANDIDATE_ACTION = "workspace_review_candidate";
const PUBLISH_DIRECT_ACTION = "workspace_publish_candidate";

const REPO_RG_ACTION = "repo_rg";
const REPO_READ_FILE_ACTION = "repo_read_file";

const ASK_CLARIFICATION_ACTION = "ask_clarification";
// Standing-instruction fix (2026-07-03) — model-initiated durable memory.
const REMEMBER_ACTION = "remember";
// ADR-0057 Phase 1 (AGRUN-565) — opens a deferred action namespace. Only
// registered when createRuntime({deferredNamespaces}) is non-empty (see
// createOpenActionNamespaceAction), so default catalogs are unchanged.
const OPEN_ACTION_NAMESPACE_ACTION = "open_action_namespace";
const LIST_AGENT_SKILLS_ACTION = "list_agent_skills";
const READ_AGENT_SKILL_ACTION = "read_agent_skill";
const USE_AGENT_SKILL_ACTION = "use_agent_skill";
const EXECUTE_SKILL_TOOL_ACTION = "execute_skill_tool";

// Frozen, sorted set of every registered action-name literal. The parity guard
// pins this against the action registry so the enum can never drift.
Object.freeze([
  ASK_CLARIFICATION_ACTION,
  EXECUTE_SKILL_TOOL_ACTION,
  FINALIZE_CANDIDATE_ACTION,
  HANDOFF_TO_SKILL_ACTION,
  LIST_AGENT_SKILLS_ACTION,
  OPEN_ACTION_NAMESPACE_ACTION,
  PUBLISH_DIRECT_ACTION,
  READ_AGENT_SKILL_ACTION,
  READ_URL_ACTION,
  REMEMBER_ACTION,
  REPO_READ_FILE_ACTION,
  REPO_RG_ACTION,
  SPAWN_SUBAGENT_ACTION,
  TODO_ADVANCE_ACTION,
  TODO_CANCEL_ACTION,
  TODO_INSPECT_ACTION,
  TODO_PLAN_ACTION,
  TODO_RUN_NEXT_ACTION,
  USE_AGENT_SKILL_ACTION,
  WEB_SEARCH_ACTION,
  WORKSPACE_APPLY_PATCH_ACTION,
  WORKSPACE_INSERT_AFTER_SECTION_ACTION,
  WORKSPACE_LIST_ACTION,
  WORKSPACE_MOVE_ACTION,
  WORKSPACE_MULTI_EDIT_ACTION,
  WORKSPACE_PROPOSE_PATCH_ACTION,
  WORKSPACE_READ_ACTION,
  WORKSPACE_REMOVE_ACTION,
  WORKSPACE_REPLACE_ACTION,
  WORKSPACE_REVIEW_CANDIDATE_ACTION,
  WORKSPACE_WRITE_ACTION
].slice().sort());

export { ASK_CLARIFICATION_ACTION, EXECUTE_SKILL_TOOL_ACTION, FINALIZE_CANDIDATE_ACTION, HANDOFF_TO_SKILL_ACTION, LIST_AGENT_SKILLS_ACTION, OPEN_ACTION_NAMESPACE_ACTION, PUBLISH_DIRECT_ACTION, READ_AGENT_SKILL_ACTION, READ_URL_ACTION, REMEMBER_ACTION, REPO_READ_FILE_ACTION, REPO_RG_ACTION, SPAWN_SUBAGENT_ACTION, TODO_ADVANCE_ACTION, TODO_CANCEL_ACTION, TODO_INSPECT_ACTION, TODO_PLAN_ACTION, TODO_RUN_NEXT_ACTION, USE_AGENT_SKILL_ACTION, WEB_SEARCH_ACTION, WORKSPACE_APPLY_PATCH_ACTION, WORKSPACE_INSERT_AFTER_SECTION_ACTION, WORKSPACE_LIST_ACTION, WORKSPACE_MOVE_ACTION, WORKSPACE_MULTI_EDIT_ACTION, WORKSPACE_PROPOSE_PATCH_ACTION, WORKSPACE_READ_ACTION, WORKSPACE_REMOVE_ACTION, WORKSPACE_REPLACE_ACTION, WORKSPACE_REVIEW_CANDIDATE_ACTION, WORKSPACE_WRITE_ACTION };
