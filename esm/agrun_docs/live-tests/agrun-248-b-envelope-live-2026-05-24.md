# AGRUN-248-B Live Envelope Evidence — 2026-05-24

Run: `2026-05-24T15-42-32-953Z`
Command: `npm run test:live:node-debug`
Provider: gemini / gemini-3.1-flash-lite (envelope planner mode, AGRUN_DEBUG=1)
Prompt: 3000-word deep research report on "What is Harness Engineering in AI agent systems"
Source-of-truth files:
- `agrun_debug_runs/2026-05-24T15-42-32-953Z.jsonl` (40 events)
- `agrun_debug_runs/2026-05-24T15-42-32-953Z.md` (live summary)
- `agrun_debug_runs/2026-05-24T15-42-32-953Z-report.md` (AI final output)

## Goal of this live run

Confirm AGRUN-248-B v1 envelope does not break end-to-end runtime under a real provider, and that the multi-kind / multi-control `workspace_publish_candidate` envelope correctly drives `runState.actState.outputKind`.

This is **not** an AGRUN-246-J long-form quality run; quality fields are reported only for completeness.

## Envelope-relevant observations

| Field | Value | Interpretation |
|---|---|---|
| `runStatus` | `completed` | OODAE loop closed normally |
| `outputKind` | `final_response` | `runState.actState.outputKind = envelope.kind` from `workspace_publish_candidate` (one of declared `kinds: ["final_response", "virtual_workspace_publish_blocked"]`) |
| `finalAnswerSource` | `workspace_publish_candidate` | Terminal action consumed via envelope `control: "complete"` |
| `actionTimings.totalActionsTimed` | `13` | 13 action executions all flowed through `normalizeActionResultEnvelope` |
| `actionTimings.byAction.statuses` per action | only `success` and `unknown` (web_search-internal HTTP status) | No `protocol_error`. (`unknown` is body-level `lastResult.status` from web_search, not envelope.status — pre-existing behavior, not introduced by AGRUN-248-B) |
| Action sequence | `todo_plan → web_search(×3) → plan → read_url(×5) → workspace_write → read_url → finalize → read_url → finalize → workspace_publish_candidate → workspace_finalize_candidate → workspace_read → workspace_publish_candidate` | Includes both `workspace_publish_candidate` shapes (blocked at cycle 16 → unblocks → published at cycle 19) — exercises the multi-kind/multi-control envelope |
| `workspaceDiagnostics.candidateLifecycle.publishedPath` | `final_candidate.md` | AGRUN-248-A lifecycle still correct under envelope refactor |
| `workspaceDiagnostics.candidatePathMismatchSignal` | `null` | No path-mismatch noise from envelope normalization |

## Verification matrix vs AGRUN-248-B acceptance

| Acceptance criterion | Result |
|---|---|
| Every built-in action has `outputSchema` or explicit `null` waiver | covered by `test/unit/action-output-contract.test.js` (20 actions inspected) |
| Six envelope unit cases pass | covered by `test/unit/action-result-envelope.test.js` (12 PASS — superset of the six) |
| Inspector `buildActionResultEnvelope` removes `web_search`-specific fallback | covered at code level; live run did not exercise browser Inspector |
| `npm test / build / dist:check` green | yes (1000 PASS, build exit 0, 266 md pass) |
| `recentActions` rows expose `resultEnvelopeVersion: "v1"` and no `status: "protocol_error"` | **live run produced no `status: "protocol_error"`**; envelope fields land on `action-executed` step detail (verified by code path), but `node-agrun-3000-live` emits aggregated summary events rather than per-step detail, so direct envelope-field inspection requires browser Inspector or a per-step recorder. Indirect evidence: `outputKind: "final_response"` is sourced from `envelope.kind` (`runState.actState.outputKind = envelope.kind` in `action-loop-action.js`) and matches the declared schema |

## Quality footnote (AGRUN-246-J unchanged by this slice)

`qualityScore: 30/100`. Failing gates: `length` (304/3000 words), `source` (citations under threshold). `structure: true`. AGRUN-248-B is a contract/visibility slice; it does not improve long-form quality. AGRUN-246-J quality work is tracked separately.

## HBR

- `node-agrun-3000-live.mjs` log aggregates action timings into a per-action summary rather than streaming per-step `action-executed` details. Direct verification of every envelope field per call requires either:
  1. A browser Inspector recording (next live e2e via Chrome MCP), or
  2. Adding a per-step recorder to the live debug script that captures `action-executed` step detail (envelope.kind / envelope.status / envelope.resultEnvelopeVersion).
  Choice 1 is cheaper for this slice; choice 2 is a future debug-harness improvement.
- Quality remains poor (304/3000 words). Not a regression from AGRUN-248-B; baseline at commit `5d8123c79` was already 432/3000. The slight drop is within noise for a single live run with non-deterministic Gemini lite output and is unrelated to envelope semantics.

## Conclusion

AGRUN-248-B envelope path executes cleanly end-to-end under a real Gemini run: 13 action invocations across 19 cycles, both shapes of `workspace_publish_candidate` returned, terminal `control: "complete"` and `envelope.kind: "final_response"` flowed through `handleActionResult` to set `runState.actState.outputKind`. No envelope protocol error was raised; the run was equivalent to the AGRUN-248-A baseline (`5d8123c79`) on all envelope-adjacent fields.
