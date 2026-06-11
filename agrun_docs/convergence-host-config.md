# Convergence detection is host-configurable (runtimeConfig.convergence)

**Ticket:** AGRUN-456
**Date:** 2026-06-09
**Status:** completed (source-only; dist rebuilt at release)

## Goal / issue

`agrun` is a GENERAL agent runtime ("general harness agent runtime for all kind
frontend system"). `CLAUDE.md` mandates **no hardcode**: the runtime observes and
exposes signals, the AI decides; only the *host* knows its task type and how
aggressive convergence detection should be.

`src/runtime/action-pattern-convergence.js` baked **11 numeric thresholds** and
**3 forbidden-action lists** into module-level constants with **no host override
path**, embedding research/document-domain assumptions into the core. A host
running a non-research task (e.g. a code-edit loop, a chat-tool loop) could not
loosen, tighten, or re-scope the circuit breaker.

This is **not** a bug in the breaker mechanism. The advisory → escalate →
`hard_veto` circuit breaker is the right AI-first design and is **unchanged**.
The only problem was that its tunables were not host-configurable.

## What `hard_veto` actually is (so the change is understood)

`hard_veto` is **two-layer real enforcement**, not just a prompt hint:

1. `planner-action-surface.js` removes a state's `forbiddenActions` from the
   AI-visible action list when `escalation === "hard_veto"` — the AI cannot even
   choose them.
2. `action-loop-action.js` preflight (`read_only_planning_hard_veto_block`,
   `structure_repair_hard_veto_block`) returns `ok:false, status:"blocked"` even
   if the AI tries; `terminal-repair-state.js` consumes the same forbidden set.

Both consumers read `state.forbiddenActions` off the **built convergence state
object** — they do not recompute from the constants. That is why this change is
contained: writing the host-resolved list into the state inside the `update*`
functions makes the veto layer follow automatically, with **zero consumer edits**.

## The contract: `runtimeConfig.convergence`

`normalizeConvergenceConfig(runtimeConfig)` (exported) reads
`runtimeConfig.convergence`, mirroring `normalizeActionGuardrailConfig` and
`resolveProductiveProgressDimensions`:

- **Thresholds** use `readPositiveInteger(value, DEFAULT)` — a non-negative
  integer wins, anything else (missing / non-integer / negative) falls back to
  the `DEFAULT_*` constant.
- **Forbidden-action lists** use `readForbiddenActionList(value, DEFAULT)` —
  **REPLACE, not merge**. A non-empty host array wins outright; an absent/empty
  one falls back to the `DEFAULT_*` list. Replacement is intentional (same
  rationale as `resolveProductiveProgressDimensions`) so misconfiguration is loud,
  not silently additive.

`DEFAULT_CONVERGENCE_CONFIG` is the SSOT default map; every entry points at the
existing `DEFAULT_*` constant, so **default behavior is byte-identical** when the
host supplies no `convergence` config.

### Entry-point wiring (load-bearing)

`normalizeRuntimeConfig` in `config.js` builds the public `runtimeConfig` object as
an **explicit allowlist** — it constructs a fixed object of named keys and does NOT
spread unknown keys. A new top-level key is therefore *silently dropped* unless it
is registered there. So `config.js` wires `convergence: normalizeConvergenceConfig(config)`
into the composition root (exactly like `actionGuardrail`, `evidencePolicy`, …). This
pre-normalizes once so `getRuntimeConfig().convergence` shows the resolved values;
the detector's own `normalizeConvergenceConfig(context.runtimeConfig)` then re-reads
it idempotently. Without this line a host's `createRuntime({ convergence: {...} })`
would never reach `session.runtimeConfig` — green unit tests, dead feature.

### Configurable keys

| `runtimeConfig.convergence.*` | default | drives |
|---|---|---|
| `repeatThreshold` | 2 | exact/semantic/error repeat → signal; read-only & terminal "escalated" status |
| `transitionalOnlyThreshold` | 3 | search/plan-only no-progress → signal; read-only-planning activation |
| `readOnlyPlanningHardVetoThreshold` | 3 | read-only-planning advisory → hard_veto |
| `readOnlyPlanningClearThreshold` | 2 | consecutive workspace-productive steps needed to clear sticky read-only state |
| `structureRepairNoProgressThreshold` | 2 | structure-repair no-progress → activate |
| `structureRepairHardVetoThreshold` | 3 | structure-repair advisory → hard_veto |
| `workspaceMutationGrowthAdvisoryThreshold` | 2 | workspace_write stall → advisory |
| `workspaceMutationGrowthHardVetoThreshold` | 3 | workspace_write stall → hard_veto |
| `workspaceMutationGrowthStallFloor` | 30 | min net words for a workspace_write to not count as a stall |
| `toolResultDedupWindow` | 5 | tool-result dedup ring size (anti-gaming) |
| `maxRecentPatterns` | 12 | recent-pattern ring size |
| `readOnlyPlanningForbiddenActions` | `["web_search","todo_plan","todo_inspect","workspace_list","workspace_read","list_agent_skills","read_agent_skill","use_agent_skill","execute_skill_tool"]` | actions vetoed + classified as read-only-planning |
| `structureRepairForbiddenActions` | `["workspace_list","workspace_read","workspace_insert_after_section","workspace_multi_edit","workspace_propose_patch","workspace_apply_patch","workspace_replace"]` | actions vetoed during structure-repair |
| `workspaceMutationGrowthForbiddenActions` | `["workspace_write","workspace_replace"]` | actions vetoed during a write-stall |

## Threading

A single normalized `config` object is resolved once in
`evaluateActionPatternConvergence` / `refreshActionPatternConvergence` and threaded
through every detector: `buildConvergenceSignal`, `updateReadOnlyPlanningState`,
`updateStructureRepairConvergence`, `updateGuardrailSectionRepair`,
`updateWorkspaceMutationGrowthConvergence`, `computeMinimumEffectiveWorkspaceGrowth`,
`updateTerminalCorrectionState`, `buildLatestCorrectionSignal`,
`appendRecentPattern`, `updateRecentToolFingerprints`,
`normalizeActionPatternConvergenceState`, `readReadOnlyPlanningForbiddenActions`,
`isReadOnlyPlanningAction`, `isStructuredReadOnlyPlanningLoop`. Each consumer takes
`config = DEFAULT_CONVERGENCE_CONFIG` as a defaulted parameter, so config-less
callers (e.g. `summarize*`) stay byte-identical.

## Two decisions worth recording

1. **`isReadOnlyPlanningAction` is COUPLED to the config list.** "Is this action
   read-only planning?" is defined by membership in
   `readOnlyPlanningForbiddenActions`. So when a host removes an action from the
   list, it is also no longer *classified* as a read-only-planning loop step —
   the host *permits* it, it does not merely *un-veto* it. SSOT: one definition of
   the set, used for both detection and veto. (Default list = default config →
   identical default behavior; the test suite alone cannot distinguish couple vs.
   decouple, hence this note.)

2. **Default prompt text now renders from the same convergence config.**
   `planner-base-directives.js`, `planner-compact-directives.js`, and
   `planner-native-directives.js` expose builder functions that call
   `normalizeConvergenceConfig(runtimeConfig)`. The default no-override output is
   byte-identical, but a host override now updates the AI-readable directive text
   for the read-only-planning forbidden-action list, the read-only hard-veto
   threshold, and the structure-repair hard-veto threshold. Host-supplied
   `runtimeConfig.prompts.*` overrides still replace/disable sections as before.

   Out of scope: the terminal-repair directive still says
   `ignoredCount>=3 AND budget exhausted, OR ignoredCount>=6`. Those numbers come
   from `terminal-repair-state.js`, not `runtimeConfig.convergence`, and should be
   treated as a separate follow-up if terminal repair becomes host-configurable.

## Verification

- `node test/unit/action-pattern-convergence.test.js` → 61 PASS (57 prior + 4 new):
  `normalizeConvergenceConfig` defaults/overrides/replace-not-merge; a raised
  `readOnlyPlanningHardVetoThreshold` keeps `advisory` at `ignoredCount=3` where
  the default escalates to `hard_veto`; a custom `readOnlyPlanningForbiddenActions`
  replaces the default and reaches the built `state.forbiddenActions`; and the
  entry-point passthrough — `normalizeRuntimeConfig({ convergence })` surfaces the
  override on `runtimeConfig.convergence`.
- `npm run check` (build:lib + rollup + browser build + dist:check + smoke /
  auto-discovered unit tests) → EXIT 0. The browser example is rebuilt from the
  same source as part of `build`, so the change is integrated there too.
- Prompt-path follow-up verification:
  `node test/unit/planner-directives-convergence-config.test.js` proves default
  base/compact directive builders are byte-identical to their static default
  exports, and a runtimeConfig override renders the custom read-only forbidden
  list plus overridden thresholds into base/compact/native prompt text.
- Default-unchanged invariant: each `DEFAULT_*` threshold constant now appears
  only in its declaration + the `DEFAULT_CONVERGENCE_CONFIG` map + comments; the
  only remaining bare uses of the constants are `create*State` normalize-path
  fallbacks (harmless — `update*` always sets the value explicitly). Prompt text
  no longer reads the default read-only forbidden-action export directly.
