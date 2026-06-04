# ADR Guide

Architecture Decision Records capture changes that would otherwise become unclear across multiple engineers and PRs.

## When To Write One

Create or update an ADR when a change affects:

- `createRuntime`, `runtime.run`, result schema, or other public runtime contracts
- runtime loop, state, memory, router, approval flow, or action contract
- bundle, build, or distribution strategy
- a built-in skill that changes capability boundaries

If a PR only changes local implementation details without changing a boundary or contract, an ADR is usually not needed.

## Numbering

- Use zero-padded numbers: `0001-...md`, `0002-...md`, and so on.
- Keep numbers increasing; do not reuse retired numbers.
- Link the ADR from the PR description whenever the PR triggers ADR requirements.

## File Shape

Start from [agrun_docs/adr/_template.md](./_template.md).

Every ADR must contain these sections:

- `Context`
- `Decision`
- `Alternatives`
- `Consequences`
- `Rollback`

## Writing Rules

- Keep the ADR scoped to one decision.
- Record the chosen decision, not a brainstorming transcript.
- Name the tradeoff clearly so later reviewers can tell what was intentionally excluded.
- Update related docs in the same PR when the ADR changes a published contract or workflow.

## Review Expectations

Reviewers should confirm:

- the problem statement is concrete
- the chosen option is explicit
- alternatives are real, not placeholder text
- consequences mention costs or risks
- rollback is realistic

## ADR Index

Status legend: **Accepted** = active decision; **Superseded** = replaced by a later ADR (still valid for context); **Skipped** = number reserved/never written.

| # | Date | Status | Subject |
|---|---|---|---|
| [0001](./0001-runtime-hardening-batch.md) | 2026-04 | Accepted | Runtime hardening batch |
| [0002](./0002-long-running-multi-topic-architecture.md) | 2026-04 | Accepted | Long-running & multi-topic task architecture |
| 0003 | 2026-04-29 | Amended | [Auto planner mode, native tools as preferred encoding](./0003-native-tools-default-readiness.md) |
| 0004 | — | Skipped | Number unused |
| [0005](./0005-run-identity-and-turn-ordering.md) | 2026-04 | Accepted | Run identity and turn ordering |
| [0006](./0006-session-record-cas.md) | 2026-04 | Accepted | Session record optimistic concurrency (CAS) |
| [0007](./0007-indexeddb-schema-migration.md) | 2026-04 | Accepted | IndexedDB schema migration via descriptor |
| [0008](./0008-provider-auth-modes.md) | 2026-04 | Accepted | Provider auth modes + header allow-list |
| [0009](./0009-host-supplied-endpoints.md) | 2026-04 | Accepted | Host-supplied endpoints (no library-shipped defaults) |
| [0010](./0010-todo-state.md) | 2026-04 | Accepted | TodoState runtime harness |
| [0011](./0011-improvement-harness.md) | 2026-04 | Accepted | Self-improvement harness (AGRUN-210) |
| [0012](./0012-long-research-belongs-to-skill.md) | 2026-05 | Accepted | Long-research belongs to agent skill, not runtime |
| [0013a](./0013-skill-discovery-is-a-tool.md) | 2026-05 | Accepted | Skill discovery is a tool, not a runtime decision |
| [0013b](./0013-workspace-tools-claude-code-codex-study.md) | 2026-05-12 | Accepted | Workspace tools — 5 improvements from claude-code + codex study *(number collision with 0013a — kept for now; future ADRs should not collide)* |
| [0014](./0014-recovery-belongs-to-ai.md) | 2026-05-07 | Accepted | Empty-response & invalid-envelope recovery is AI's job |
| [0015](./0015-workspace-files-are-ai-authored.md) | 2026-05-07 | Accepted | Workspace files are AI-authored, runtime is storage |
| [0016](./0016-simple-research-belongs-to-ai.md) | 2026-05-07 | Accepted (resolved by 0028) | Simple research follows ADR-0012 |
| [0017](./0017-topic-extraction-belongs-to-ai.md) | 2026-05-07 | Accepted | Topic extraction is AI-declared, not regex-extracted |
| [0018](./0018-research-filters-are-host-pluggable.md) | 2026-05-07 | Accepted | Research filters are host-pluggable |
| [0019](./0019-final-response-quality-belongs-to-ai.md) | 2026-05-07 | Accepted (consolidated by 0023) | Final-response quality is a signal, not a veto |
| [0020](./0020-skill-catalog-ranking-is-ai-tool-only.md) | 2026-05-07 | Accepted (consolidated by 0023) | Skill catalog ranking is AI-tool-only |
| 0021 | — | Skipped | Number unused |
| 0022 | — | Skipped | Number unused |
| [0023](./0023-harness-as-tool-provider-only.md) | 2026-05-08 | **Accepted (current architecture SSOT)** | Harness is a tool provider, not a decision maker — deletes 8 push-mode sites |
| [0024](./0024-ai-first-scaffolding-research-class.md) | 2026-05-08 | Accepted | AI-first scaffolding: research-class prompt encourages tool use |
| [0025](./0025-terminal-source-labels-ai-vs-runtime.md) | 2026-05-08 | Accepted | Terminal source labels distinguish AI-driven from runtime-forced |
| [0026](./0026-zero-residual-push-mode.md) | 2026-05-08 | Accepted | Zero residual push-mode (delete final fail-safe pushes) |
| [0027](./0027-live-e2e-closure-adr-0023-0026.md) | 2026-05-08 | Accepted | Live e2e closure for ADR-0023 / ADR-0026 |
| [0028](./0028-simple-research-no-runtime-auto-read.md) | 2026-05-08 | Accepted (resolves 0016) | Simple research belongs to AI — delete `resolveResearchContinuation` |
| [0029](./0029-cost-ledger-as-observability.md) | 2026-05-11 | Accepted | Cost Ledger as observability, not governance |
| [0044](./0044-turn-state-ssot.md) | 2026-05-27 | Accepted | TurnState SSOT and NextStep signals for future HITL resume |
| [0049](./0049-spawn-subagent-empty-finalresponse-root-cause.md) | 2026-06-04 | Accepted | `spawn_subagent` empty `finalResponse` root cause — result-envelope extraction bug (AGRUN-296), not Gemini empty completion |
| [0050](./0050-per-step-snapshot-convergence-ssot.md) | 2026-06-04 | Accepted | Per-step debug snapshot carries the convergence family (`actionPatternConvergence`/`terminalRepairState`/`invalidActionConvergence`) so hosts read `readOnlyPlanningState` live without `terminalRepairState.reason` parsing (AGRUN-266) |
| [0051](./0051-output-guardrail-host-policy.md) | 2026-06-04 | Accepted (slice 1) | Host-defined output guardrails (OpenAI-Agents-SDK `defineOutputGuardrail` shape, adapted: block→re-plan not halt): move publish/quality POLICY out of the runtime, consolidate the sprawled publish-readiness facts into one SSOT bundle; validation-only (distinct from the ADR-0030-rejected authoring hook) (AGRUN-297) |

**Current architecture SSOT:** When ADRs conflict, prefer the later number. [ADR-0023](./0023-harness-as-tool-provider-only.md) is the controlling decision for the runtime/AI ownership boundary; [ADR-0012](./0012-long-research-belongs-to-skill.md) is the controlling decision for long-research. See [`../architecture-ssot.md`](../architecture-ssot.md) for the full authority order.
