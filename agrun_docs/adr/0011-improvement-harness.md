# ADR 0011: Self-improvement harness (AGRUN-210)

## Context

The 19 phases of AGRUN-118, the 7 phases of AGRUN-212a, and the
eight P1/P2/P3 findings (AGRUN-201..208) all followed the same
informal lifecycle: someone observed a problem → proposed a root
cause → designed a fix → ran tests → reflected on whether the fix
was harness or patch. That lifecycle was tracked in commit
messages, ADRs, and head memory. AGRUN-210 encodes it as typed
runtime state so future findings can flow through one structured
path with a non-bypassable completion gate.

This ADR locks the schema, the gate, the reflection rules, and
the persistence-excluded scope decision. AGRUN-212a (TodoState)
is intentionally NOT a precedent: TodoState is a per-thread
**user-task** plan; ImprovementPlan is a project-level
**developer-improvement** plan. They share no schema and live in
different stores (TodoState on `sessionRecord.threads[i]`;
ImprovementPlan in host's source-of-truth, see "Persistence" below).

Affected modules:
- `src/runtime/improvement.js` (Phases A + B)
- `src/runtime/improvement-reflection.js` (Phase C)
- `test/fixtures/improvements/*.json` (Phase D)
- `test/unit/improvement-fixtures.test.js` (Phase D dogfood)
- `test/unit/improvement-long-running.test.js` (Phase E literate example)

## Decision

### Schema (locked)

Five typed records, each with a write-time validation that rejects
the silent-failure mode the framework exists to prevent:

```ts
ImprovementSignal  = { id, source, description, evidence[], createdAt }
Hypothesis         = { id, signalId, rootCause, scope, createdAt }
ImprovementPlan    = { id, hypothesisId, acceptance[], filesAffected[],
                       status, createdAt, updatedAt, version }
VerificationResult = { planId, passed, evidence[], verifiedAt }
ReflectionResult   = { planId, hardcodeRisk, harnessQuality, reasons[], reflectedAt }
```

Write-time rejections (factory throws):
- `description` empty → reject
- `rootCause` empty → reject
- `acceptance` empty → reject (a plan with no acceptance criteria
  is the silent-failure mode this harness exists to prevent)
- `passed: true` + `evidence: []` → reject (passing-without-evidence
  is exactly the case the gate would catch later; surfacing the bug
  at write time points the stack trace at the writer, not the closer)
- `reasons` empty → reject (a verdict without justification is
  just a label)

Explicitly rejected from MVP:
- `confidence` on Hypothesis → planner LLM does not need it for MVP.
- `hardcodeRisk` field on ImprovementPlan → lives on ReflectionResult
  instead so the plan's status field stays single-source.
- Cross-finding dependencies / DAG → mirrors ADR-0010's TodoState
  rejection; if real demand surfaces, add in a successor ADR.
- LLM-driven reflection → recursion risk; rule-based for MVP.

### Lifecycle gate

`finalizeImprovement(plan, verification, reflection)` is the ONLY
sanctioned path from `verifying` to `verified`. Five-layer check:

1. plan / verification / reflection all non-null.
2. `plan.status === "verifying"` (explicit; the transition table's
   same-status no-op shortcut would otherwise let `verified →
   verified` silently succeed).
3. `verification.planId === plan.id === reflection.planId` (catches
   cross-wired records — a stale verification from an earlier plan
   still in scope).
4. `verification.passed === true`.
5. `reflection.hardcodeRisk !== "high"` (medium and low pass).

On success: `applyPlanAdvance(plan, {nextStatus: "verified"})`.
Inputs are never mutated.

Each precondition has a typed error: `VerificationFailedError`,
`HardcodeRiskError`, `PlanIdMismatchError`. `isImprovementGateError`
predicate covers all three for one catch-block consumers.

`rejectImprovement(plan, reason)` is the explicit abandon path.
`reason` is required — silent rejections are forbidden, mirroring
the "passed=true requires evidence" discipline.

### Reflection rules (locked at 4)

Encoded from `agrun_docs/archive/agrun-118-phase-history.md`'s
"Cross-cutting lessons" section. Each rule is a pure function over
a structured `Diff` input:

| Rule | AGRUN-118 source | High trigger | Medium trigger |
|---|---|---|---|
| `concurrency-leak` | P7 | `globalThis.X =` in test/ outside test/helpers/ AND no `withPatchedGlobals` | both keywords appear; nesting unverifiable |
| `missing-import` | P12, P16 | n/a | new test/concerns/* uses helper without require/import line |
| `orphan-declaration` | P11, P14, P18 | n/a | xxxRuntime consumer removed but declaration not retired AND no fresh declaration |
| `mixed-concerns` | P11, P15 | n/a | one commit touches ≥ 2 distinct test/concerns/*.test.js files |

Composition: `composeReflection(plan, diff)` returns a
ReflectionResult with `hardcodeRisk = max(rule risks)` and
`harnessQuality` mapped from risk:

```
low    → harness   (no findings; default verdict for clean diffs)
medium → hybrid    (warning bucket; finalize gate still passes)
high   → patch     (gate blocks)
```

Reasons are tagged by ruleId for audit. Empty findings still
produce a non-empty reasons list so the trail is never silent.

### Heuristics, not proofs

The four rules are deliberately conservative:
- HIGH only on unambiguous violations (a clear `globalThis.X =`
  outside test/helpers/ with no helper invocation in the same file).
- MEDIUM on suspicious-but-uncertain patterns (the "warning"
  bucket; gate passes).
- LOW for clean diffs (no findings).

Comment-only lines are skipped when matching positive helper
signals (a comment `// no withPatchedGlobals here` must NOT count
as evidence the helper is invoked). Discovered while writing the
synthetic-high fixture; the fix excludes lines whose first
non-whitespace tokens are `//`, `/*`, `*`, or `#`.

### Persistence — DELIBERATELY EXCLUDED from MVP

ImprovementPlan is **project-scoped** (the Improvement is "fix this
bug in agrun.js"), not session-scoped. Its source of truth lives
where the host already tracks engineering work — git log, issue
trackers, or a separate persistence the host owns. Forcing it onto
`sessionRecord` would couple the framework to AGRUN-202 / 206
session machinery without semantic justification.

What the framework provides:
- Pure data records (factories return plain objects).
- A non-bypassable lifecycle gate.
- Reflection rules.
- Fixture-driven dogfood test (`test/fixtures/improvements/*.json`).

What the host provides:
- How to persist signals / plans across sessions.
- How to derive a `Diff` from `git diff` (or staged changes).
- The verifier callback (test runner / API call / LLM judge).
- Retention policy for closed plans.

If a later sprint surfaces a real need for runtime persistence,
add it in a successor ADR with a concrete use case.

### Custom rule extension

`composeReflection(plan, diff, rules?)` accepts an optional `rules`
array; when provided, it replaces the default 4. Hosts that want
project-specific reflection (e.g. "PR description must mention test
plan") write a `(diff) => RuleResult` function and pass it in. The
default rule set stays small and locked; extensions are explicit.

### Failure-path note

Phase B's `handlePreparedSessionError` does NOT write back any
TodoState mutations from the failure path. The same principle
applies here: `finalizeImprovement` does not run for failed
verifications — those go through `rejectImprovement` explicitly.
A planner that calls finalizeImprovement on an unverified plan
gets a typed error, not silent partial commit.

## Alternatives

1. **Persist plans on `sessionRecord.improvements[]`.** Rejected —
   semantic mismatch (project-scope vs session-scope); would couple
   the framework to AGRUN-206 CAS without justification.
2. **LLM-driven reflection.** Rejected — recursion risk (the
   reflection itself becomes an improvement that needs reflection).
   Rule-based MVP first; LLM-augmented as a separate phase if
   demand surfaces.
3. **Five rules from day one (adding `detect-todo-state-bypass`).**
   Rejected — only 4 lessons have ≥ 3 corroborating phases in the
   AGRUN-118 history. The fifth is speculative; defer until a
   real bypass shows up.
4. **Schema with `confidence` on Hypothesis and `hardcodeRisk` on
   ImprovementPlan.** Rejected — `confidence` adds a numeric field
   no consumer needs; `hardcodeRisk` belongs on ReflectionResult
   (so the plan record stays single-purpose).
5. **Auto-compose reflection from a parsed `git diff` string.**
   Rejected — diff parsing is the host's job; the framework takes
   structured `Diff` input. This keeps `improvement-reflection.js`
   a pure module without a parser dep.

## Consequences

Pros:
- The lifecycle that AGRUN-201..208 / 212a / 118 followed informally
  is now structured runtime state. Future findings flow through
  one path with a non-bypassable gate.
- Three real-history fixtures (AGRUN-201, AGRUN-208, synthetic-high)
  prove the framework processes its own history. Adding a fixture
  is an O(1) edit; the dogfood test auto-discovers them.
- 4 reflection rules encode the cross-cutting lessons from
  `agrun_docs/archive/agrun-118-phase-history.md` so they cannot be
  forgotten in future PRs.
- Custom-rule extension means hosts can layer project-specific
  reflection without forking the framework.

Cons:
- Heuristic-based rules will produce false positives (medium when
  human reviewer would say low). The medium bucket is the
  intended dump for that uncertainty — gate still passes.
- The framework provides no persistence; hosts must wire their
  own. This is a feature, but it does mean each integration
  re-implements signal/plan storage.
- The 4 rules cover AGRUN-118 lessons; future sprints (AGRUN-212b,
  AGRUN-210 Phase F+) may surface new lesson categories that need
  new rules. The rule set is locked at 4 here; new rules need a
  successor ADR.

Risks:
- A wide enough false-negative gap (a real patch that none of the
  4 rules catch) would let a low-quality fix through. Mitigation:
  the gate only blocks HIGH; medium and low both pass with
  warnings, so the audit trail captures something even when the
  gate green-lights.
- The dogfood test uses synthetic fixtures alongside real ones.
  If a synthetic fixture's expected verdict drifts from what the
  rules actually produce after a future rule tweak, the test fails
  — by design (forces ADR amendment), but adds friction.

## Rollback

- All AGRUN-210 changes ship as additive — no existing runtime
  code is rewritten, no public API changed. Reverting the five
  feat commits (Phases A-E) leaves the rest of the runtime
  untouched.
- The `test/fixtures/improvements/` JSON files are pure data;
  removing them is safe.
- `agrun_docs/adr/0011-improvement-harness.md` (this file) and the
  AGRUN-121 ADR-list checkbox should be updated in any rollback.

## References

- AGRUN-118 phase history: [agrun_docs/archive/agrun-118-phase-history.md](../archive/agrun-118-phase-history.md)
- ADR-0010 TodoState (precedent for "5-field discipline"): [agrun_docs/adr/0010-todo-state.md](./0010-todo-state.md)
- Long-running smoke (literate "how to use" example):
  [test/unit/improvement-long-running.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/improvement-long-running.test.js)
- Fixture format: [test/fixtures/improvements/README.md](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/fixtures/improvements/README.md)
