# Long Task Lab Debug Diagnosis 2026-05-21

## Scope

Improve Long Task Lab Debug/Inspector so engineers can observe why an AI agent produced a weak or limited result without hardcoding search queries, sources, report content, or quality scores.

This is observability-only. It does not change planner decisions, source selection, evidence scoring, or final report generation.

## Implementation

Debug Inspector now includes `Agent Limitation Diagnosis`.

The diagnosis summarizes:

- evidence gate status: `pass`, `partial`, `fail`, or `unknown`
- usable and strong source counts
- failed read count
- source issue counts such as `weak`, `thin`, `blocked`, `failed`, and HTTP status buckets
- repeated `web_search` query patterns from timeline steps
- terminal workspace limitations, shown only after terminal states

The Debug metric strip also includes an `Evidence` metric in `usable/strong` form.

This makes the TNO rerun failure easier to understand:

- source links passed
- length passed
- workspace publish passed
- structure passed
- evidence failed because there was only `1 usable / 0 strong`
- source issue mix included weak/blocked/thin reads
- repeated narrow query patterns can now be seen directly

## Harness Boundary

The runtime does not tell the agent to search a fixed TNO query or use a fixed source. It only exposes AI-readable facts about the failure surface. The next agent turn can use these facts to create its own recovery strategy.

Correct boundary:

```text
Runtime: evidence failed because 1 usable / 0 strong; source issues weak/thin/blocked; repeated query observed.
Agent: decide the next search/read strategy.
```

Incorrect boundary:

```text
Runtime: hardcode the next query or hardcode a TNO source.
```

## Verification

Passed:

- `node --experimental-strip-types examples/long-task-lab/test/lab-state.smoke.ts`
- `npm run test:long-task-lab`
- `npm run build:long-task-lab`
- Chrome DevTools MCP UI smoke at `http://127.0.0.1:3001/?qa=debug-diagnosis-smoke&qa_clean=y`

Chrome observed:

- Debug tab loaded.
- `Agent Limitation Diagnosis` section is visible.
- Idle run shows `unknown` and `No evidence diagnosis yet.`
- Evidence metric is visible.
- Console check returned no errors, warnings, or issues.

The smoke test covers a TNO-like diagnosis case with:

- `1 usable / 0 strong`
- weak, blocked, and thin source issue counts
- repeated query detection
- `evidence_gate_failed`
- `repeated_query_strategy`

## Honest Bad Result

This does not improve the actual TNO report yet. It improves the inspector so the next failure is diagnosable without reading raw JSON or guessing from the final answer. The next implementation should feed this diagnosis back to the planner as compact context, then test whether the agent independently improves its evidence recovery strategy.
