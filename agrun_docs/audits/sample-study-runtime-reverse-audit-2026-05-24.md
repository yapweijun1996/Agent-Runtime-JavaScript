# Sample-Study Reverse Audit — Current Runtime Improvements

Date: 2026-05-24

Scope: compare the current `src/runtime/` and browser Inspector shape against MCP-KB `agrun.sample-study` findings from the local `sample project for study logic/` corpus.

Project goal: agrun.js is a browser-first general harness agent runtime. Runtime should provide execution control, state, policy, events, and evidence surfaces while AI owns planning, quality judgment, and final content.

## Evidence Read

- MCP-KB `Production Agent Harness for agrun.js`, kbcid `agrun.sample-study`:
  - `33b18dba-a6b4-4400-bdc4-cf6d7ab22963` — sample inventory / routing.
  - `5a7f296a-df36-4887-bb5b-235b60995d94` — logic/functions/skills/UX/direction breakdown.
  - `9029cefd-0fda-4e8d-88a5-57b6fba63fad` — operating protocol.
- Current runtime files:
  - `src/runtime/action-loop-session-loop.js`
  - `src/runtime/state.js`
  - `src/runtime/runtime-events.js`
  - `src/runtime/action-registry.js`
  - `src/runtime/terminal-repair-state.js`
  - `src/runtime/virtual-workspace.js`
  - `src/runtime/research-acceptance-evaluator.js`
  - `examples/browser/src/components/inspector-support.ts`
- Codeloom status: repo `agrun` is reachable and auto-reindex is ok, but embeddings are partial. Local file reads were used as source of truth.

## Top 5 Improvements

### 1. Add a typed runtime event ledger with stream modes

Priority: P1

Sample basis: LangGraph stream modes (`values`, `updates`, `checkpoints`, `tasks`, `debug`, `messages`, `custom`) and Goose/Codex trace discipline.

Current gap: `runtime-events.js` currently prepares step details and metrics, but events are not a first-class typed ledger with visibility/mode contracts. Browser Inspector compensates by assembling many derived ledgers; `buildDebugIndex()` takes a large cross-section of derived inputs.

Why it matters: Inspector, support bundle, host apps, and future replay should read one SSOT event stream, then project different views. This reduces debug drift and makes long-running task behavior easier to verify.

First PR:
- Add `src/runtime/runtime-event-ledger.js`.
- Normalize every emitted event into `{ id, runId, cycle, ts, mode, visibility, type, phase, payload, schemaVersion }`.
- Keep existing `onStep` and `onStreamEvent` compatibility by projecting from the ledger.
- Add projection helpers for Inspector: debug stream, user-visible stream, agent-projection stream.

Acceptance checks:
- Existing `onStep` consumers still receive compatible steps.
- New tests prove event ordering and mode filtering.
- Browser Inspector can render at least Summary / OODAE / LLM Trace from the event projection without bespoke duplicate parsing.

Impact: High. Effort: Medium. Risk: Medium.

### 2. Replace remaining runtime-synthesized planner recovery with AI-visible repair contracts

Priority: P1

Sample basis: Swarm keeps control transfer explicit; agents-js exposes guard facts; LangGraph uses explicit command/interrupt semantics instead of hidden replacement decisions.

Current gap: `action-loop-session-loop.js` still creates runtime-selected `web_search` fallback decisions after invalid/empty planner output for non-long-research paths. It is bounded and safer than older behavior, but it still lets runtime choose an action for AI.

Why it matters: This is the same architectural shape as the old shadow planner. Even if useful, it creates inconsistent semantics: long-research mode surfaces errors to AI, while other modes may receive synthetic recovery actions.

First PR:
- Introduce a `plannerRepairSignal` or extend `plannerInvalidSignal`.
- On invalid/empty planner output, record facts and ask the planner again with the repair signal instead of creating a `web_search` decision.
- Keep a host-configurable legacy fallback only behind an explicit compatibility flag if needed.

Acceptance checks:
- Unit tests cover invalid envelope and empty response without runtime-selected action.
- Existing planner fallback concern tests are updated to assert AI-visible repair observation.
- No long-research behavior regresses.

Impact: High. Effort: Medium. Risk: Medium.

### 3. Add action output schemas and normalized result envelopes

Priority: P1

Sample basis: Goose tool result serde and AIVerify schema-first plugin/result contracts.

Current gap: `action-registry.js` exposes `argsSchema`, permission metadata, and plan metadata, but no `outputSchema`. `handleActionResult()` only depends on `control` and output shape. Action results are observable, but the contract is not yet schema-driven.

Why it matters: Browser hosts and Inspector need stable action result contracts. AI-first does not mean loose protocol; harness should validate mechanical shape and expose protocol errors as observations.

First PR:
- Extend action metadata with `outputSchema` and `resultEnvelopeVersion`.
- Add a lightweight `normalizeActionResultEnvelope()` at the action boundary.
- Add tests for success, continue, invalid args, approval required, policy block, and action error envelopes.

Acceptance checks:
- Every built-in action has an output schema or an explicit `outputSchema: null` waiver.
- Inspector action-result rows can read common fields without action-specific fallbacks.
- Protocol failures become AI-observable observations, not thrown terminal failures unless the runtime itself is corrupt.

Impact: High. Effort: Medium. Risk: Low-Medium.

### 4. Promote workspace candidate lifecycle to an explicit state machine

Priority: P0/P1 for long-form quality

Sample basis: opencode/Codex snapshots and patch discipline; Hermes recovery invariants; Open WebUI task progress UX.

Current gap: `virtual-workspace.js` correctly lets AI choose paths and keeps security validation only, but the recent live HBR shows a path-discipline failure: AI wrote `report.md` while selected/published candidate remained `final_candidate.md` empty. Terminal repair and research acceptance can observe deficits, but candidate lifecycle is not yet a clear state machine.

Why it matters: The next root issue is not word-count hardcode; it is artifact lifecycle. Runtime should not judge prose quality, but it should make "which file is candidate, which file was read, which file was finalized, which file is publishable" mechanically unambiguous.

First PR:
- Add a candidate lifecycle object: `{ activePath, draftPaths, lastWrittenPath, lastReadPath, finalizedPath, publishedPath, status }`.
- Workspace write/read/finalize/publish actions update this object.
- Planner prompt and Inspector show candidate-path mismatch as a fact.
- If publishing a stale/empty path, return an observation that names the mismatch and expected next mechanical action.

Acceptance checks:
- Unit test reproduces `report.md` written while `final_candidate.md` is selected; runtime surfaces mismatch.
- Publish cannot silently use an empty stale candidate when another file has fresh content.
- AI still chooses content and readiness; runtime only enforces artifact identity and freshness.

Impact: Very High. Effort: Medium. Risk: Medium.

### 5. Split the giant RunState into kernel state plus subsystem projections

Priority: P2

Sample basis: agents-js minimal `TurnState`; LangGraph explicit state/checkpoint projections; production harness report's typed run object.

Current gap: `createRunState()` and `createLastRunSummary()` carry many subsystem fields in one object. This works but increases coupling: every subsystem tends to add fields to the global shape, and Inspector/support projection becomes more fragile over time.

Why it matters: agrun has grown from MVP runtime to production harness. A typed kernel state plus subsystem-owned ledgers would keep the core loop small and reduce regression risk when adding features.

First PR:
- Define `RunKernelState` for identity/status/cycle/phase/terminal fields only.
- Move research/workspace/todo/approval/metrics into projection helpers with stable `project*State()` outputs.
- Keep the public `runState` output compatible through a projection layer.

Acceptance checks:
- Snapshot output remains backward compatible for public fields.
- Unit tests verify subsystem projection shape.
- No subsystem reads another subsystem's private mutable object directly unless routed through a helper.

Impact: Medium-High. Effort: High. Risk: High.

## Recommended Sequence

1. Candidate lifecycle state machine.
2. Action output schemas / result envelopes.
3. Runtime event ledger and stream modes.
4. Planner repair contract.
5. RunState split after the above contracts stabilize.

## HBR

This is a static reverse audit plus source inspection. I did not run live E2E in this task. Existing dirty worktree changes were left untouched. Codeloom semantic search was partial, so local source reads are the verification base.
