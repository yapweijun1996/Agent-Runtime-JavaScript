# Audit — Globe3 `researchReportLoop.enabled` Anomaly Investigation (2026-05-25)

## Context

Globe3 trace 1 (prompt `"i need sales report 2010"`, job_id
`21d54d85-50f9-4748-8c7a8132109fe5f0`) runState dump shows
`researchReportLoop.enabled` flipping `false → true` between sample
step 50 and step 250, correlated with `selectedSkill: null → "globe3-report"`.
Per source review and mock repro, this should not be reachable on
their config (32 ERP agentSkills, no long-research skill, no
`researchActivation`, no workspace activity, no successful `web_search` /
`read_url` — all rejected by `disabledActions`).

This audit is a **diagnostic snapshot**, not a fix. It will be
finalized once Globe3 returns the additional dump fields requested in
the round-5 reply (`runState.researchReportLoop.status`,
`runState.researchReportLoop.lastTopic`, the `runtime.run({...})`
options object, and a `grep` of host-side `researchReportLoop` /
`researchActivation` writes).

## Closed: Main bug (hypothesis (e))

Globe3 dump fields (terminalRepairState.active=false at all samples,
activeDeficits=null, terminalCorrectionState=null, terminalRetryCooldown=null,
readOnlyPlanningState=null) **match the mock repro 1:1**.
Hypothesis (e) — `planner-invalid-action × planner-repair-failed`
loop with no AI-visible signal and no terminal escape short of step
budget — is the confirmed root cause. ADR-0034 implementation will
close this.

## Open: `researchReportLoop.enabled` anomaly

### Reproduced and ruled out paths

**Path (i) — Lexical detection of skill description / instructions.**
Globe3 hypothesized that the runtime reads `globe3-report` SKILL.md
strings (`"Long-form deep analysis"`, `"≥ 1500 words"`, `"deep analysis"`)
into a long-research heuristic. **Ruled out.** Source grep confirms:

- `isLongResearchRun` (research-state.js:445-455) only matches skill
  **id** against `LONG_RESEARCH_SKILL_IDS = {"deep-research-writer",
  "long-web-research"}`. No description / instructions read.
- `qualityGateRequired` (research-state.js:51) derives from
  `isLongResearchRun`, not from any text source.
- `shouldCommitResearchReportLoopGate` (research-report-loop.js:287-298)
  uses the five preconditions listed in the round-4 reply; none read
  skill description text.
- Strings `"deep analysis"` / `"long-form"` appear in source only at
  `agent-skills-bundle.js` (bundled skill metadata itself) and
  `actions/list-agent-skills-search.js:75` (skill ranking keywords for
  the planner's catalog presentation, not gate activation).

Mock repro at `/tmp/globe3-anomaly-repro.mjs`:

- agentSkills includes `globe3-report` with the exact description
  keywords reported by Globe3
- mock provider emits `use_agent_skill("globe3-report")` then
  30× `web_search`
- Result: `agentSkillContext.activeSkill = "globe3-report"`,
  `agentSkillContext.lastReadSkill = "globe3-report"`, but
  `researchReportLoop.enabled = false`, `status = "idle"`.

**Path (a) — `selectedSkill` set via provider-skill selection.**
Hypothesized: if `globe3-report` is registered in BOTH `skills:[]`
(provider layer) and `agentSkills:[]` (instruction pack layer),
`run-skill-loop.js:154` writes `runState.selectedSkill = "globe3-report"`.
**Ruled out.** Mock repro at `/tmp/globe3-anomaly-path-a.mjs`:

- `skills: [globe3ReportProviderSkill, fallbackSkill]`
- `agentSkills: [globe3-report, sales-report, customer-master]`
- Result: `selectedSkill = "globe3-report"` (matches Globe3 dump
  observation), but `researchReportLoop.enabled = false`,
  `qualityGateRequired = false`.

Both `selectedSkill: "globe3-report"` and
`researchReportLoop.enabled: false` can hold simultaneously. The
correlation Globe3 reported (selectedSkill flip → enabled flip) is
not causation per current source.

### Paths still to discriminate (need Globe3 dump fields)

1. **Dump-capture skew.** `enabled` is captured from a different
   sample window than the surrounding fields, or from a side-stream
   that hydrates post-run. Discriminator: `researchReportLoop.status`
   from the same sample. If `enabled=true` but `status="idle"`,
   that diagnoses hydration-vs-commit mismatch.

2. **Session / thread hydration from prior session.** If Globe3 uses
   `sessionStore: createIndexedDBSessionStore(...)` and the
   `session_id` for the failing trace resumes from a session_id
   where a prior long-research run did commit, `applyResearchSliceToRunState`
   (research-thread-sync.js:108-134) would carry `researchReportLoop`
   forward. Discriminator: the exact `runtime.run({...})` options
   object and host sessionStore config.

3. **Host-side direct mutation of `runState.researchReportLoop`.**
   The host ColdFusion / Node wrapper could write directly to the
   runState slot (via plan-result hook or onStep mutation, both of
   which would be host bugs). Discriminator:
   `grep -nE "researchReportLoop|researchActivation" ai_agent_runner.js`
   and the CFM wrapper.

4. **A sixth gate path we have not found.** Less likely after the
   above source review, but cannot be ruled out without seeing the
   exact event sequence Globe3 captured between sample step 50 and
   step 250.

### Why this matters even if main bug is fixed

If the anomaly turns out to be path (4), ADR-0012's "no lexical, no
auto-activation" contract is broken somewhere. That is a separate
P1 ticket — must NOT be folded into ADR-0034. The contract is
load-bearing for every host that registers agent skills without
intending to opt into long-research behaviour.

If the anomaly turns out to be path (1), (2), or (3), it is a
documentation or dump-capture issue, not a runtime bug. We update
docs and close.

## Source review notes (for the implementer who reads this audit cold)

`refreshResearchReportLoopGate` callers and their refresh predicates:

| Caller | File:line | Predicate |
|---|---|---|
| Main planner cycle | action-loop-action.js:804 | `shouldRefreshLongRunAcceptanceGate` |
| Plan-actions terminal | action-loop-plan-actions.js:220 | `shouldRefreshLongRunAcceptanceGate` |
| Virtual workspace action | actions/virtual-workspace-actions.js:1011 | inline (workspace_* completion) |

`shouldRefreshLongRunAcceptanceGate` (action-loop-action.js:2416-2429):

- `web_search` AND `status === "after_web_search"` (post-execute)
- `read_url` AND `status === "after_read_url"` (post-execute)
- workspace_read / workspace_finalize_candidate / workspace_publish_candidate /
  workspace_apply_patch / workspace_propose_patch / workspace_write /
  workspace_insert_after_section / workspace_replace

For Globe3 trace 1: every web_search emission is rejected by
`disabledActions` validation BEFORE reaching `after_web_search`. No
read_url emitted. No workspace_* actions. Therefore none of the
three callers ever calls `refreshResearchReportLoopGate` on this
trace via the normal action-completion path.

Direct mutations of `runState.researchReportLoop` outside
`commitResearchReportLoop`:

| File:line | What it does |
|---|---|
| research-report-loop.js:187 | `noteResearchCoverageSearchAttempt` records recent query, does not touch `enabled` |
| research-report-loop.js:545 | `applyTopicChangeReset` (only reachable via `commitResearchReportLoop` path) |
| research-thread-sync.js:116 | `applyResearchSliceToRunState` — **thread hydration** (path 2 above) |
| approval.js:176 | approval-resume hydration |
| research-evidence-graph.js:268 | `materializeEvidenceGraph` mutates sub-fields only if `runState.researchReportLoop` already exists; does not set `enabled` |

The path (2) candidate is `research-thread-sync.js:116`. It is the
ONLY place outside `commitResearchReportLoop` and approval-resume
that writes `runState.researchReportLoop = {...}` directly, and it
spreads `enabled: true` forward from a hydrated slice when the slice
carries it.

## Verdict (closed 2026-05-25 evening)

- (e) — CONFIRMED, ADR-0034 closes
- Path (i) lexical description — RULED OUT (source + mock)
- Path (a) selectedSkill provider — RULED OUT (mock with both
  registrations still keeps enabled=false)
- Path (1) dump-capture timing skew — **ACCEPTED as working hypothesis** by Globe3
- Path (2) thread / session hydration — **RULED OUT**. Globe3 confirmed:
  no `sessionStore` configured (agrun default in-memory store),
  no `threads:{enabled:true}` on backend; backend Node is
  `ProcessBuilder` fresh-spawn per job by Lucee, scoped to the
  single Node process lifetime.
- Path (3) host direct mutation — **RULED OUT**. Globe3 grep across
  `folder_ai_chatbox/ai_agent_runner.js`,
  `contentadmin/ai_chatbox_js_runtime_*.cfm`, and
  `contentadmin/ai_agent_*.cfm`: only match is a read-only dump
  hook (`const _rrl = _rs.researchReportLoop || {};`) in
  ai_agent_runner.js:948-963. Zero mutation paths.
- Path (4) sixth gate path — **not pursued**. Globe3 accepted the
  trade-off: small chance of missing a gate path now vs cost of
  another verify cycle, given the symptom (533 step events in 30s)
  becomes structurally unreachable once ADR-0034 + planner-prompt
  follow-up land. If the anomaly persists post-fix on a fresh trace
  with narrower sampling (cycles 1 / 50 / 100 / 200 / cycle boundary),
  Globe3 will open a fresh ticket.

## Closing rationale

Path (1) is the simplest explanation consistent with all observed
data:

- Globe3's `onStep(step, snapshot)` capture took `snapshot.runState`
  as-given; the snapshot could be a phase-cycle interim view rather
  than the committed post-cycle view.
- Per source review, `runState.researchReportLoop` has no commit path
  reachable on Globe3's trace shape (no long-research activation, no
  workspace candidate, no length contract, no successful web_search /
  read_url completion).
- Paths (2) and (3) — the only ways an external write could set
  `enabled = true` without `commitResearchReportLoop` — are ruled
  out by Globe3's grep + spawn-model evidence.
- Therefore the most plausible source for `enabled = true` in the
  capture is interim state read during a phase boundary that
  committed state never reflects.

Globe3 explicitly trades this small uncertainty against the cost of
another verify cycle. The trade is reasonable because:

1. ADR-0034's invalidActionConvergence fix is on-path for the core
   bounded loop. Once it ships, the planner does not loop 30+ cycles
   on invalid action, so the anomaly capture window is no longer
   reproducible by construction.
2. If the anomaly resurfaces with narrower sampling post-fix, Globe3
   reopens with cleaner data.

## Artifacts

- `/tmp/globe3-repro.mjs` — main bug (e) repro
- `/tmp/globe3-anomaly-repro.mjs` — path (i) ruled out
- `/tmp/globe3-anomaly-path-a.mjs` — path (a) ruled out
- [`test/unit/disabled-action-invalid-loop-baseline.test.js`](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/disabled-action-invalid-loop-baseline.test.js) — baseline regression for (e)
- [`test/unit/planner-prompt-disabled-actions.test.js`](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/planner-prompt-disabled-actions.test.js) — regression for ADR-0034 prompt-construction follow-up
- [`agrun_docs/adr/0034-invalid-action-observation-surface.md`](../adr/0034-invalid-action-observation-surface.md) — ADR for (e) fix
- Commit `6dd00c00` — ADR-0034 follow-up landed (planner-prompt
  gates `web_search`/`read_url` advisory lines on action availability)

## Follow-up commitments

- agrun side: ship full ADR-0034 `invalidActionConvergence` slot +
  step event + planner-prompt observation block in the next published
  bundle. Already shipped on dev branch: ADR-0034 doc, baseline test,
  planner-prompt follow-up patch.
- Globe3 side: post-build, revert `budget.invalidDecisions: 2 → 3`
  once `invalid-action-convergence-refreshed` step event is available;
  draft `host-rerouting-patterns.md` PR (ASK #5) reflecting post-fix
  contract; reopen ticket if anomaly resurfaces with cycles 1 / 50 /
  100 / 200 / cycle-boundary sampling.
