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
