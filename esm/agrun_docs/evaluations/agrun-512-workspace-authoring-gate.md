# AGRUN-512 — Evaluate gating the native_tools workspace AUTHORING surface

Status: **EVALUATION COMPLETE → gating is SAFE and RECOMMENDED.** Implementation is a
separate behavior change (it alters which tools the planner sees on the default
tool_loop/native path) and must be validated with **live e2e** (real keys),
mirroring the live 6/6-fail evidence that motivated it — see "Implementation" below.

Date: 2026-06-14. Parallel precedent: AGRUN-256 (`workspace_publish_candidate` gate).

## Problem

In `plannerMode: native_tools` (and plain `tool_loop`) the planner action surface
**always** exposes the full workspace authoring subsystem — the 9
`virtualMutationPermission` actions — with **no gate**:

`workspace_write`, `workspace_replace`, `workspace_apply_patch`,
`workspace_insert_after_section`, `workspace_remove`, `workspace_move`,
`workspace_multi_edit`, `workspace_review_candidate`, `workspace_finalize_candidate`
(`action-registry.js` permission metadata, the `virtualMutationPermission` set).

Only `workspace_publish_candidate` is surface-gated today (AGRUN-256,
`shouldHideWorkspacePublishCandidateForMode` in `planner-action-surface.js`).

**Live evidence (gpt-5-mini, native_tools, trivial prompt, 2026-06-13, 6/6 FAIL):**
with the authoring tools on the table, the model executes `list_agent_skills` then
wanders into a `workspace_write → workspace_read → workspace_review_candidate`
authoring loop, burning the `maxSteps=8` budget → `MAX_STEPS_EXCEEDED`, instead of
simply finalizing. The authoring surface being available for a trivial prompt pulls
the model off task.

## The decider: regression risk = ZERO (in-repo)

The binding risk question: **does any legitimate flow author into the workspace
WITHOUT engaging an evidence/publish/authoring skill?** Audit of `examples/`,
`test/`, `agrun_docs/`, and `task.jsonl`:

- Every `workspace_write/replace/insert_after_section/apply_patch` use is inside a
  research/evidence skill (`deep-research-writer`, `long-web-research` SKILL.md),
  OR inside terminal-repair with its own explicit allowlist
  (`terminalRepairState.allowedActions`), OR inside a readiness-gated publish flow.
- `test/unit/planner-action-surface.test.js` confirms the *current* behavior: in
  plain tool_loop, `workspace_write` is visible (only `publish_candidate` is hidden).
- No example, test, doc, or task describes a bare "write me a doc via
  `workspace_write`" tool_loop flow with no skill engaged.

**Conclusion:** no in-repo flow would regress. A downstream host *could* author
without a skill, which is exactly what the host opt-out (below) is for.

## Recommended design (mirror AGRUN-256 exactly)

1. **Predicate** in `planner-action-surface.js`, parallel to
   `shouldHideWorkspacePublishCandidateForMode`: hide the 9 authoring actions when
   - the run is NOT an evidence-convergence run
     (`isEvidenceConvergenceRun`, `convergence-activation.js` — skill-capability
     `requiresEvidenceConvergence`), AND
   - no publish-readiness skill is active (`requiresPublishReadiness`), AND
   - terminal-repair is not active (its allowlist owns the surface), AND
   - the host has not disabled the gate.
   Keep the READ-ONLY workspace actions (`workspace_read`, `workspace_list`,
   `workspace_propose_patch`) ALWAYS visible — they are harmless.
   `workspace_publish_candidate` keeps its own AGRUN-256 gate (do not double-gate).
2. **AI-FIRST (binding):** the gate is **skill-capability-driven**, never
   prompt-content-driven. No "if trivial prompt, hide tools" — that would violate
   ADR-0023. A skill that authors declares `requiresEvidenceConvergence` /
   `requiresPublishReadiness` (or a new `requiresAuthoringReadiness`) and the gate
   unhides on that signal.
3. **Host opt-out:** `runtimeConfig.workspaceAuthoringGate.enabled === false`
   disables the gate (mirrors `publishCandidateGate.enabled`), for a host that
   legitimately authors without a skill.
4. **Dispatch-path parity (两道门):** the predicate lives in `selectPlannerActions`
   (shared surface) so it covers single-action AND plan paths AND envelope/native
   modes by construction; add the gated-action escalation
   (`invalidKind: "workspace_authoring_gated"`) on both
   `action-loop-session-loop.js` and `action-loop-plan-validation.js`, mirroring
   the `workspace_publish_candidate_gated` escalation.
5. **Test:** mirror `planner-action-surface.test.js`'s publish-gate cases — assert
   the 9 authoring actions are hidden in tool_loop/native with no skill, visible
   with an evidence/publish skill active, visible under terminal-repair, and
   visible when the host opt-out is set.

## Why implementation is gated on live e2e

The change alters the planner's **default** tool surface in tool_loop/native — a
high-impact AI-behavior change. Unit tests pin the hide/show logic and the full
smoke suite guards the research/publish/terminal-repair flows (which stay
skill-engaged → unaffected), but the **value** claim (the 6/6-fail trivial-prompt
case becomes pass, and no research flow degrades) is an AI-quality property that
must be confirmed with real keys, per the project's live-e2e discipline. That live
validation is the implementation's acceptance gate, tracked as AGRUN-512-IMPL.
