# Deferred Architecture Backlog Review

Date: 2026-05-25
Status: CLOSED WITH HBR

## PG

Review Step 6 of the ordered pending journey after the live evidence gates
completed. The goal is to decide whether any deferred architecture item is now
safe to reactivate without violating harness engineering or adding speculative
runtime complexity.

## Review Inputs

- `task.md` ordered journey Step 6.
- AGRUN-246-J current-head HBR:
  `agrun_docs/live-tests/agrun-246-j-current-head-rerun-2026-05-25.md`.
- Workspace editor evidence gate HBR:
  `agrun_docs/live-tests/workspace-multi-edit-cycle-delta-2026-05-25/SUMMARY.md`.
- AGRUN-248-C eventLedger Phase 1/2 docs:
  `agrun_docs/audits/agrun-248-c-runtime-event-ledger-design-2026-05-25.md`,
  `agrun_docs/audits/agrun-248-c-inspector-event-ledger-phase2-2026-05-25.md`.

## Decisions

| Item | Decision | Reason |
|---|---|---|
| AGRUN-246-H LLM-delegated NLP helpers | Keep deferred | It needs an async LLM-call surface inside currently sync helper paths, and AGRUN-246-J still lacks stable structure-quality proof. Adding this now would mix architecture plumbing with unresolved long-form quality evidence. |
| AGRUN-212b TodoState DAG / priority / drift-driven replan | Keep backlog | ADR-0010 explicitly deferred DAG complexity until the MVP TodoState shape has production-cycle evidence. Recent HBRs still show Todo/publish churn, so adding DAG semantics now risks widening the state machine before simpler readiness churn is stable. |
| MemoryProvider / AGRUN-119 / AGRUN-213d | Keep deferred | Product direction still says not now. There is no concrete host need for a pluggable memory backend in this journey. |
| Provider fallback / AGRUN-120 | Keep deferred | Provider error clarity and retry/circuit breaker pieces exist, but fallback policy would change single-provider behavior and needs explicit product/API acceptance. |
| AGRUN-248-C Phase 3 LangGraph-style mode subscription API | Keep deferred | Phase 1/2 eventLedger work is complete, but the public API still documents `onStep` as the stable event sink and says no second `onEvent` callback. A subscription API would be a public host contract change and needs a concrete host consumer/acceptance shape before implementation. |
| `workspace_diff` | Keep blocked | The workspace_multi_edit evidence gate did not prove the required >=20% cycle reduction. Phase 2 editor action work remains blocked by evidence, not implementation difficulty. |

## Result

No architecture implementation is unlocked by the Step 6 review. The ordered
journey is closed as reviewed, with the next practical engineering direction
remaining quality-focused rather than breadth-focused:

1. Fix the observed long-form structure-repair failure class from AGRUN-246-J.
2. Reduce publish/Todo/workspace protocol churn with observable signals only.
3. Re-run live evidence before reopening editor Phase 2 or event subscription
   Phase 3.

## Verification

- `task.md` and `task.jsonl` updated with this review.
- `npm run docs:index`
- `npm run build`
- `npm run dist:check`
- `task.jsonl` parse check
- `git diff --check`

## HBR

This review does not ship runtime behavior. It intentionally prevents
speculative architecture work. The bad result is that several useful ideas
remain deferred, but that is better than adding public API or state-machine
surface without evidence.
