# Codebase Review — 2026-05-16 (post mock-provider seam relocation)

Read-only architectural review performed after the MockProvider seam relocation
commit batch (`ef81768bf` → `43a326f63` → `a3e69a9bf`). Verifies harness purity
of shipped changes, re-checks earlier review findings, surfaces remaining debt.

## Shipped this session (3 commits)

| Commit | Type | Net effect |
|---|---|---|
| `ef81768bf` | fix(test) | Restore the `test/helpers/mock-provider.mjs` file `test/unit/mock-provider-plan-loop.test.js:8` imports but `f98a5f2f6` forgot to commit. `npm test` mock-provider-plan-loop went from `Cannot find module` to PASS for any fresh clone. |
| `43a326f63` | refactor(runtime) | Drop `"mock"` from `SUPPORTED_PROVIDERS`; delete `src/runtime/mock-provider.js`; stop exporting `createMockProvider` from `src/index.js`; replace the runtime `provider==="mock"` dispatch branch with a generic `isInjectedTransport(options.transport)` short-circuit. Net: production bundle no longer ships test transport code. |
| `a3e69a9bf` | build(dist) | Rollup + Vite regen of `dist/agrun.js` + `dist/agrun.md` + browser example bundle. New asset hash `index-B2I071Su.js` replaces `index-gg3ZmF2b.js`. `npm run dist:check` PASS (175 markdown files). |

## Harness purity audit

Before this batch, `src/runtime/provider.js` had:

```js
SUPPORTED_PROVIDERS = ["openai", "gemini", "mock"];

if (options.provider === "mock") {
  result = await requestMockProviderCompletion(options);
} else if (options.provider === "openai") { ... }
else if (options.provider === "gemini") { ... }
```

This treated `"mock"` as a first-class production-bundle provider id. Three
problems:

1. **Public surface leak.** Any agrun host could pass `provider:"mock"` through
   the public API; runtime would dispatch to a transport that was only meaningful
   to in-repo tests. Test fixtures bled through to production.
2. **Production bundle weight.** Rollup pulled `src/runtime/mock-provider.js`
   into `dist/agrun.js`. Mock dispatch logic shipped to every host.
3. **Coupling to the dispatch shape.** Adding new test transports (replay,
   record-replay, deterministic fake) meant editing the runtime dispatch
   table. The runtime knew about test concerns.

After:

```js
SUPPORTED_PROVIDERS = ["openai", "gemini"];

if (isInjectedTransport(options.transport)) {
  return options.transport.complete(options);
}
// ... existing openai/gemini dispatch unchanged
```

Net: runtime no longer knows about test transports. Callers (tests, replay
tools, evals) attach a `transport: { complete, stream }` shape; runtime
short-circuits before circuit breaker + provider dispatch. Adding a new
test transport requires zero runtime changes.

This is a textbook harness-engineering refactor: **delete a hardcoded
provider id branch, replace with a caller-injected signal.** The runtime
surface shrunk; capability did not.

## Re-check: earlier review finding `planner-action-surface.js:71` — superseded 2026-05-17

2026-05-17 follow-up: this finding is stale against the current tree.
`src/runtime/planner-action-surface.js` no longer contains
`resolveSkillActionSurface`, `isExplicitSkillRequest`,
`matchesComplexSkillIntent`, or `tokenizeIntent`. The current module is the
terminal-repair/read-only/structure-repair planner action filter and is
covered by `test/unit/planner-action-surface.test.js`.

Historical note below is kept so the review audit trail explains why this
was investigated.

The 2026-05-15 review flagged `resolveSkillActionSurface()` in
`src/runtime/planner-action-surface.js:58-72` as dead branching:

```js
function resolveSkillActionSurface(options) {
  if (hasNamedSkill(options.activeAgentSkill) || ...) {
    return "full";
  }
  if (isExplicitSkillRequest(options.prompt, options.availableAgentSkills)) {
    return "full";
  }
  if (matchesComplexSkillIntent(options.prompt, options.availableAgentSkills)) {
    return "full";
  }
  return "full";
}
```

All four branches return `"full"`. `isExplicitSkillRequest`,
`matchesComplexSkillIntent`, `tokenizeIntent` (~50 LOC of helpers) are dead
code. The function is equivalent to `() => "full"`.

The hard-veto wiring fix landed on 2026-05-16
(`agrun_docs/live-tests/planner-action-surface-hard-veto-2026-05-16.md`) and
added unit coverage in `test/unit/planner-action-surface.test.js`, but the
dead branching survived because the hard-veto work was orthogonal. **Two
sprints have shipped near this code without cleaning the dead branches.**

Risk is closed in the current tree because the stale helper stack is gone.

## Re-check: `action-pattern-convergence.js` 1906 LOC layering — partially closed 2026-05-17

2026-05-17 follow-up: progress projection/classification moved to
`src/runtime/action-pattern-progress.js`, reducing
`action-pattern-convergence.js` from 1906 LOC to 1560 LOC. Convergence now
imports progress snapshot/diff helpers and keeps the state/correction
orchestration in the main module. This closes the productive/transitional
layering smell without changing behavior.

Historical note below explains the original finding.

Still 1906 LOC, unchanged this sprint. Productive vs transitional
classification is embedded in base convergence rather than emitted as a
named downstream signal. The 2026-05-16 double-baseline Run A failure
(`repeatedSemanticFingerprintCount = 0` after 5 distinct full-rewrite
attempts with the same repair intent) suggests the fingerprint algorithm
treats "different text, same intent" as different — which is the same
layering smell. ADR-0030 graceful valid-limited publish proposes the right
direction (separate evaluator), but is in NEEDS_APPROVAL.

Not regressing; just not improving. Tracked for future refactor.

## Pre-existing failure discovered: `test/concerns/planner.test.js:210` — stale closed 2026-05-17

2026-05-17 follow-up: this failure no longer reproduces on current HEAD.
`node test/concerns/planner.test.js` passes, and the workspace publish
fixture now asserts at line 217 that
`finalAnswerSource === "workspace_publish_candidate"`. The run also checks
`terminalizedBy === "workspace_publish_candidate"`, exact candidate output,
and TodoState terminal observation. No bisect is needed for the current
tree.

Historical note below explains the original local failure report.

```
AssertionError: Expected values to be strictly equal:
+ actual:   null
- expected: 'workspace_publish_candidate'

at workspacePublishResult.finalAnswerSource === 'workspace_publish_candidate'
```

Reproduces on clean `main` HEAD `ef81768bf` with all uncommitted refactor
changes stashed — **the failure pre-existed the mock-provider seam
relocation**. The test was last touched in `3222c4345 refactor(runtime):
integrate harness modules across action-loop / planner / todo`, which is
the likely bisect target.

Symptom interpretation: runtime returns `finalAnswerSource = null` on a
publish flow where the test fixture asserts the source should be
`workspace_publish_candidate`. Either (a) the publish path no longer sets
`finalAnswerSource`, (b) the fixture's mocked planner sequence stopped
matching the current envelope contract, or (c) the test asserts a
contract a recent refactor broke.

This no longer masks current `npm test`; keep this section only as review
audit history.

## Module count and LOC

| Metric | Value | Δ vs 2026-05-15 |
|---|---|---|
| `src/runtime/*.js` total LOC | 41209 | -146 (mock-provider.js deleted) |
| `src/runtime/*.js` file count | 166 | -1 |
| Largest file | `action-pattern-convergence.js` 1560 LOC | progress helpers extracted 2026-05-17 |
| Second largest | `action-loop-action.js` 1717 LOC | unchanged |
| Subdirectory examples | `src/runtime/actions/` (11 files) | unchanged |

The flat 166-file `src/runtime/` directory remains the largest organization
smell. `src/runtime/actions/` precedent is good; should be replicated for
`runtime/loop/` (21 `action-loop-*` files), `runtime/todo/` (14 files),
`runtime/research/` (11 files), `runtime/convergence/` (continue the
convergence split started by `src/runtime/action-pattern-progress.js`).

## Verification

- `node test/unit/mock-provider-plan-loop.test.js` → PASS in <1s.
- `npm run build` → vite + rollup OK.
- `npm run dist:check` → 175 markdown files PASS.
- 2026-05-17 follow-up: `node test/concerns/planner.test.js` → PASS.

## Recommended next moves (priority order)

1. **Promote `src/runtime/actions/` subdirectory precedent.** Add
   `src/runtime/loop/`, `runtime/todo/`, `runtime/research/`,
   `runtime/convergence/`. Zero-risk file moves; large IDE-navigation +
   future-refactor-safety win.
2. **Resolve ADR-0030 NEEDS_APPROVAL.** Either implement the graceful
   valid-limited publish path (unblocks Gemini ladder) or write a reject
   note (close the loop). One week in NEEDS_APPROVAL is the most expensive
   state.

## Out of scope this session

- No runtime convergence changes (Gemini Flash long-form behavior remains
  model-side ceiling per `node-agrun-3000-double-baseline-2026-05-16.md`).
- No `action-loop-action.js` / `virtual-workspace.js` deep dives.
- No live API run; refactor is provider-dispatch only and does not touch
  the openai/gemini code paths.
