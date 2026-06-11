# ADR-0030 — Graceful valid-limited publish on exhausted budget (draft, NEEDS_APPROVAL)

- **Status:** Proposed (2026-05-16) — NEEDS_APPROVAL
- **Owner:** AGRUN-239 (proposed)
- **Related:** ADR-0023 (harness-as-tool-provider-only), ADR-0026 (zero residual push-mode), ADR-0027 (live e2e closure), commit `7f4986df6` (path-aware publish length validation), commit `ea4dcd6e8` (publish-protocol terminal repair)
- **Audit predecessor:** `agrun_docs/live-tests/node-agrun-3000-double-baseline-2026-05-16.md`, `agrun_docs/live-tests/node-agrun-fixed-prompt-terminal-review-2026-05-16.md`

## Context

The 2026-05-16 fixed-prompt and double-baseline live tests against `gemini-3-flash-preview` reproducibly fail the 3000-word Success Criteria as `max_steps_continuation`, *not* because source / structure / evidence / publish-protocol are wrong, but because the AI runs out of step budget while attempting a valid limited publish that the runtime keeps rejecting.

Concrete failure trace (step 89/90 of the 3000/90 debug ladder, `agrun_debug_runs/2026-05-16T10-52-56-909Z.md`):

```
finalCandidateStructureOk = true
sourceMinimum.passed      = true (3 reads / 2 relevant)
candidateWords            = 1681 / 3000
budgetState               = exhausted
requirementRecoveryEvaluator.recommendedContract = "valid_limited_allowed"

AI emits workspace_publish_candidate with:
  finalReadiness.decision               = "limited"     ✓
  lengthSatisfied                       = false         ✓
  requirementSatisfied                  = false         ✓
  remainingGaps                         = ["Length short of target"]

Runtime blocks with invalidPublishReasons = [
  "remaining_gaps_must_name_todo_deficit"
]
```

The AI declared exactly the right `decision=limited` contract. It even named the length gap. The block fires because terminal-repair-state has accumulated a `todo` deficit (an active TodoState item is still `pending`), and `isValidTerminalRepairPublishArgs` requires the `remainingGaps[]` to mention `todo|task|progress|plan` keywords — which the AI's text did not. By the time the AI sees the rejection observation, the next planner cycle hits maxSteps.

The runtime is **already** in `valid_limited_allowed` mode per `requirement-recovery-evaluator.js:569`. The mechanism exists. What is missing is a **read-only, prospective contract** telling the AI *which exact gap strings* its `remainingGaps[]` must contain *before* it composes the publish call — so the publish succeeds on the first try, not after one or more rejection rounds the AI cannot afford under exhausted budget.

This is not push-mode: runtime never authors the `remainingGaps[]` text and never decides whether to publish. Runtime only exposes the same validator rules it *already* applies post-hoc, but prospectively, as observable state on the planner prompt.

## Decision

Add a read-only `exhaustedBudgetPublishContract` block to `terminalRepairState` (and surface it through `researchReportLoop.gateSignal.acceptancePacket` so it lands in the planner prompt projection). It is populated only when **both**:

1. `requirementRecoveryEvaluator.recommendedContract === "valid_limited_allowed"`, **and**
2. `terminalRepairState.budgetState === "exhausted"` (or `cyclesRemaining <= 2`).

Shape:

```js
exhaustedBudgetPublishContract: {
  active: true,
  trigger: "budget_exhausted" | "cycles_remaining_low",
  requiredFinalReadiness: {
    decision: "limited",
    requirementsAssessment: {
      requirementSatisfied: false,
      lengthSatisfied: <true if observed >= requested else false>,
      evidenceSatisfied: <true if sourceMinimum passed else false>
    }
  },
  requiredGapKeywords: ["todo", "task", "progress", "plan"],   // only when todo deficit active
  requiredGapPhrases: [                                        // human-readable hints, AI authors final text
    "Length deficit: candidateWords 1681 / 3000 requested",
    "Unfinished TodoState item: \"<title>\" (status: pending)"
  ],
  publishPathHint: "final_candidate.md",
  publishProtocolNext: "workspace_publish_candidate"          // already finalized+read
}
```

The planner prompt section becomes (rendered only when `active=true`):

```
Budget is exhausted. You may publish limited now if you author finalReadiness
with the contract below. Runtime will not write this text for you.

  decision: "limited"
  requirementSatisfied: false
  lengthSatisfied: <as shown>
  evidenceSatisfied: <as shown>
  remainingGaps: must include strings that mention each of:
    - <requiredGapPhrases[0]>
    - <requiredGapPhrases[1]>
```

### Where the contract is built

- New helper `buildExhaustedBudgetPublishContract(runState, terminalRepairState)` in `src/runtime/terminal-repair-state.js`.
- Populated by `refreshTerminalRepairState` after `requirementRecoveryEvaluator` has run.
- Surfaced into `runState.researchReportLoop.gateSignal.acceptancePacket.exhaustedBudgetPublishContract` via `refreshResearchReportLoopGate` (already wired for `acceptancePacket`).
- Planner prompt projection in `src/runtime/planner-prompt.js` reads it from `acceptancePacket` and emits the rendered block.

### What changes about `isValidTerminalRepairPublishArgs`

Nothing. The validator stays as the single source of truth for "is this publish acceptable?". The new contract is just a **read-only mirror of the same rules**, projected *forward* to the AI before it composes the call. This satisfies SSOT.

### What does NOT happen (anti-push-mode guarantees)

- Runtime never writes `finalReadiness.remainingGaps` for the AI.
- Runtime never calls `workspace_publish_candidate` itself.
- Runtime never forces a finalize / synthesize result.
- If the AI ignores the contract and submits a malformed publish, the existing terminal-repair block still fires with `invalidPublishReasons`. Behavior at the validator boundary is unchanged.
- If the AI ignores the contract and does nothing, the run still terminates as `max_steps_continuation`. No silent rescue.

### Acceptance criteria

| # | Acceptance signal | Verification source |
|---|---|---|
| A1 | `runState.terminalRepairState.exhaustedBudgetPublishContract` is populated when `budgetState=exhausted` AND `valid_limited_allowed` AND deficits include `todo` | unit test |
| A2 | `acceptancePacket.exhaustedBudgetPublishContract` mirrors A1 (no diverging copies) | unit test |
| A3 | Planner prompt projection includes the rendered block only when `active=true`; absent otherwise | planner-prompt unit test |
| A4 | `git grep -n "finalReadiness\.remainingGaps\s*=" src/runtime/` returns zero hits where runtime writes the array (only validator-side reads allowed) | grep gate |
| A5 | `npm test`, `npm run build`, `npm run dist:check` pass | terminal |
| A6 | Existing terminal-repair tests still pass — validator behavior at the block boundary is unchanged | unit test |
| A7 | A new fixture-mode planner prompt unit test verifies that when the contract is active and the AI's mock response includes the suggested keywords, `executeWorkspacePublishCandidateAction` accepts; when AI omits a required keyword, it still blocks with `remaining_gaps_must_name_todo_deficit` (no regression) | unit test |
| A8 | Live `npm run test:live:node-debug` on `gemini-3-flash-preview` 3000/90: the publish-rejection-then-maxSteps pattern is gone — either a clean valid-limited publish lands within budget, OR the failure mode shifts to a different convergence axis (length growth, source acquisition, etc.). HBR documented, not gated. | live trace |

## Alternatives rejected

1. **Soften the validator (drop `remaining_gaps_must_name_todo_deficit` under exhausted budget)** — Reduces invariant strength: the validator's whole point is enforcing AI honesty about deficits. Removing the rule because the AI cannot read it is the wrong direction. Rejected.
2. **Auto-fill `remainingGaps` with runtime-generated text when AI omits it** — Push-mode. Runtime authors user-facing content. Violates ADR-0023 / ADR-0026. Rejected.
3. **Raise default `maxSteps` to give AI more rejection rounds** — Treats the symptom. Per-prompt cost grows linearly. Cheaper / dumber models still drift; pro models do not need it. Rejected.
4. **Skip the publish-protocol audit (finalize / read) at exhausted budget** — Already partially in place via path-aware length validation (commit 7f4986df6). The remaining gap is the *gap-text contract*, not the protocol-move contract. Rejected as out of scope.
5. **Add a host hook `onExhaustedBudgetPublish` that hosts implement to author remainingGaps** — Externalizes the same push-mode problem to the host. Most hosts will not implement it correctly. The whole point of harness engineering is the AI authors content. Rejected.

## Consequences

- **Pros:**
  - Closes the last reproducible 3000-word failure mode on flash-tier models that does not require a model swap.
  - Strengthens the AI-first contract: the AI sees the *full* validator surface prospectively, not as post-hoc error messages.
  - Zero new push-mode surface. Reuses `requirementRecoveryEvaluator` and `terminalRepairState` SSOT.
  - Inspector / Node debug trace becomes self-documenting — `exhaustedBudgetPublishContract` is visible whenever the rule fires.

- **Cons:**
  - Planner prompt grows ~20 tokens when the contract is active. Negligible.
  - One more piece of state on `terminalRepairState` to keep in shape contract.

- **Risks:**
  - **AI authors `remainingGaps[]` strings that lexically match the keywords but are semantically empty (gaming the keyword check).** Acceptable: the validator already accepts keyword presence as the contract; tightening to semantic match is a separate decision (not push-mode, but a different ADR).
  - **The contract goes stale between `refreshTerminalRepairState` and the next planner prompt if a new TodoState item appears mid-cycle.** Mitigation: refresh once per cycle inside the existing OODAE refresh chain. No new refresh point.
  - **Flash model still ignores the contract even when shown.** Then the failure axis shifts (length growth, source acquisition, or honest abandonment of the run) — exactly the diagnostic clarity we want. The pro-model swap remains the alternative for hosts that need the harder guarantee.

## Rollback

- Delete `buildExhaustedBudgetPublishContract` and its single call in `refreshTerminalRepairState`.
- Delete the `exhaustedBudgetPublishContract` field from `acceptancePacket` projection.
- Delete the planner-prompt branch that renders the block.
- Validator behavior at the block boundary is unchanged by this ADR, so no validator rollback needed.

## Cadence

Single PR. Touches `src/runtime/terminal-repair-state.js` (new builder + state field), `src/runtime/research-report-loop.js` (acceptancePacket projection), `src/runtime/planner-prompt.js` (one new rendered block), `src/runtime/run-state.js` (init), 3 test files (`test/unit/terminal-repair-state.test.js`, `test/unit/planner-prompt-exhausted-publish.test.js` new, `test/unit/workspace-actions.test.js` regression), this ADR, `task.md`. Acceptance gate: A1–A7 (test-level) — A8 is live verification documented as HBR but not blocking. No deletions; no breaking change to existing public surface.

## Migration notes for hosts

No host-facing migration. The new state field is purely additive on `runState.terminalRepairState` and read-only.

If a host inspects `runState.terminalRepairState` for custom UI:

- New field path: `runState.terminalRepairState.exhaustedBudgetPublishContract` (object or `null`).
- Useful for showing a "Why was my publish rejected and what would unblock it?" panel in Inspector.

## Open questions

- Should `requiredGapKeywords` be expanded to cover *future* deficit types (e.g., a new `evidence` deficit) automatically? Current proposal hardcodes the four known keyword groups (`todo`, `task`, `progress`, `plan`); deficit-keyword routing should live in `terminal-repair-state` as a single map, not duplicated across validator and contract builder.
- Should the contract include a `softDeadlineCycleCount` field so the AI can prioritize publish over further expansion? Current proposal does not — runtime should not be telling the AI when to commit. AI reads `cyclesRemaining` on its own.
- Pro-model live verification (gemini-3-pro-preview) is currently flaky on the endpoint side (2 of 3 runs fail to provider timeout / signal kill). Once endpoint stability is established, rerun the 3000/90 contract test under pro to confirm the contract does not regress the existing 20-step PASS path. Tracked as part of A8 follow-up.
