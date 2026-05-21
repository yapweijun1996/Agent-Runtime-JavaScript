# X2 Live Model Comparison — 2026-05-20

## Goal

Compare `gemini-3.1-flash-lite` and `gemini-3.5-flash` on the same Node 3000-word Harness Engineering live prompt after X2 source-handoff and terminal limited-publish fixes.

## Commands

```bash
AGRUN_DEBUG=1 AGRUN_DEBUG_DIR=agrun_docs/live-tests/x2-live-2026-05-20 AGRUN_DEBUG_RUN_ID=run4-lite-after-source-handoff NODE_AGRUN_LIVE_PROVIDER=gemini GEMINI_MODEL=gemini-3.1-flash-lite NODE_AGRUN_LIVE_MAX_STEPS=90 node test/node-agrun-3000-live.mjs

AGRUN_DEBUG=1 AGRUN_DEBUG_DIR=agrun_docs/live-tests/x2-live-2026-05-20 AGRUN_DEBUG_RUN_ID=run5-gemini-3.5-flash NODE_AGRUN_LIVE_PROVIDER=gemini GEMINI_MODEL=gemini-3.5-flash NODE_AGRUN_LIVE_MAX_STEPS=90 node test/node-agrun-3000-live.mjs
```

## Result Table

| Model | Classification | Terminal | Acceptance | Duration | Candidate words | Structure | Source minimum | Source reads | Key result |
| --- | --- | --- | --- | ---: | ---: | --- | --- | ---: | --- |
| `gemini-3.1-flash-lite` | weak / cheap-latency model | `workspace_publish_candidate` | pass | 274.9s | 462/3000 | pass | pass | 4 | Can terminate valid limited, but weak long-form writing cadence; 45 overwrite-style writes in raw diagnostics. |
| `gemini-3.5-flash` | normal / stronger model | `max_steps_continuation` | fail | 933.3s | 2981/3000 | pass | fail | 7 | Strong long-form ability, but source relevance stayed 1/2 and terminal repair did not converge to valid limited publish before max steps. |

## Findings

- `gemini-3.5-flash` is available through the configured Gemini API key; the model name did not fail provider validation.
- Official public docs/search results found Gemini 3 Flash references, but not a clear official `gemini-3.5-flash` model-code page in the browsed results. Treat availability as proven by the local API run, not by a public docs quote.
- X2 source-handoff improved weak-model behavior enough for `gemini-3.1-flash-lite` to pass current live acceptance with source minimum and clean structure.
- The weak model remains poor at long-form generation: only 462 words and many repeated `workspace_write` operations.
- `gemini-3.5-flash` showed much stronger content capacity: it reached 3093 words mid-run and ended at 2981 words, but kept cycling through `web_search`, `read_url`, `workspace_read`, and `workspace_append`.
- The next harness bug is shared across models: when source relevance remains below minimum and budget is near exhausted, the action surface should converge faster to either targeted source recovery or valid limited publish. The runtime must not write content or choose sources for the AI; it should project the facts and remove low-value loops.

## Run5 Convergence Debug

`scripts/debug-live-convergence.mjs` was added to inspect a saved live JSONL without calling a provider:

```bash
node scripts/debug-live-convergence.mjs \
  --jsonl agrun_docs/live-tests/x2-live-2026-05-20/run5-gemini-3.5-flash.jsonl \
  --tail 15 \
  --out agrun_docs/live-tests/x2-live-2026-05-20/run5-convergence-debug.md
```

Key diagnosis:

- This is an SSOT alignment issue, not only model weakness.
- The decisive conflict is protocol/action-surface mismatch: `terminalRepairState.reason` repeatedly reports `missing_latest_workspace_read`, but the planner action surface does not include `workspace_read` in cycles 82-88, and final state allows only `workspace_publish_candidate`.
- Prompt noise is real but secondary: cycle 90 prompt was ~41k chars, with ~12k history chars and ~23k loopState chars. Large loop fields include `actionPatternConvergence` (~6k), `terminalRepairState` (~3.3k), `researchReportLoop` (~3.1k), and `readUrlRecoverySignal` (~2k).
- `gemini-3.5-flash` did choose `workspace_publish_candidate`; it was not simply refusing to publish. One publish was invalid because remainingGaps omitted the TodoState gap, but the larger blocker is the impossible surface: the runtime asks for `workspace_read` while hiding `workspace_read`.
- The next fix should make protocol-required actions (`workspace_read`, `workspace_finalize_candidate`) win over broad recovery/mutation pruning, or make the terminal repair reason/allowedActions derive from one publish-protocol SSOT.

## Publish Protocol SSOT Fix

Implemented the run5 follow-up as a harness-level SSOT alignment fix:

- Added `resolvePublishProtocolActionContract(runState)` so publish-protocol readiness maps to one required next action:
  - `missing_finalize_after_latest_write` -> `workspace_finalize_candidate`
  - `missing_latest_workspace_read` -> `workspace_read`
  - protocol ready -> `workspace_publish_candidate`
- `terminalRepairState.allowedActions`, planner action-surface filtering, and read-only planning preflight now preserve the protocol-required action even when a broad read-only-planning hard veto exists.
- The exception is narrow: hard veto still removes unrelated churn actions such as `workspace_write`; only the observable protocol-required action survives.
- Regression coverage locks the run5 failure mode: when terminal repair says `missing_latest_workspace_read`, `workspace_read` must remain exposed and `workspace_publish_candidate` must not become the only visible action while the latest-read protocol is unmet.

Verification after the SSOT fix:

```bash
node --check src/runtime/terminal-repair-state.js
node --check src/runtime/planner-action-surface.js
node --check src/runtime/action-loop-action.js
node test/unit/terminal-repair-state.test.js
node test/unit/planner-action-surface.test.js
node test/unit/action-pattern-convergence.test.js
node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/x2-research-phase-contract.test.js
node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/workspace-actions.test.js
node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/planner-prompt-terminal-repair-focused.test.js
node scripts/debug-x2-harness.mjs
npm test
npm run build:lib
```

HBR at this point: this proved the local contract and prevented the old impossible action surface, but a fresh provider live run was still required to prove full late-stage behavior with the normal model. Run6/Run7 below completed that verification.

## Run6/Run7 Live Verification

Run6 attempted the same `gemini-3.5-flash` live after the publish-protocol SSOT fix:

```bash
AGRUN_DEBUG=1 AGRUN_DEBUG_DIR=agrun_docs/live-tests/x2-live-2026-05-20 AGRUN_DEBUG_RUN_ID=run6-protocol-ssot-gemini-3.5-flash NODE_AGRUN_LIVE_PROVIDER=gemini GEMINI_MODEL=gemini-3.5-flash NODE_AGRUN_LIVE_MAX_STEPS=90 node test/node-agrun-3000-live.mjs
```

Run6 failed before terminal publish because the Gemini planner request timed out at cycle 5. Debug showed no publish-protocol action-surface conflict, but the run never reached the target behavior.

The timeout root cause was another SSOT coverage gap: `deriveProviderTimeoutMs()` only elevated deadlines for TodoState autopilot turns. X2 long research can run without TodoState, so the same long-running harness path fell back to the default 60s provider timeout. The fix extends the same provider-timeout helper to recognize structural long-research contracts (`researchActivation="long_research"` or a long `researchReportLoop.gateSignal.acceptancePacket.requestedLength`), preserving host-supplied explicit `request.timeoutMs`.

Run7 reran the same live command after rebuilding:

```bash
AGRUN_DEBUG=1 AGRUN_DEBUG_DIR=agrun_docs/live-tests/x2-live-2026-05-20 AGRUN_DEBUG_RUN_ID=run7-timeout-ssot-gemini-3.5-flash NODE_AGRUN_LIVE_PROVIDER=gemini GEMINI_MODEL=gemini-3.5-flash NODE_AGRUN_LIVE_MAX_STEPS=90 node test/node-agrun-3000-live.mjs
```

Run7 result:

| Model | Terminal | Acceptance | Duration | Candidate words | Structure | Source minimum | Source reads | Debug conflicts |
| --- | --- | --- | ---: | ---: | --- | --- | ---: | ---: |
| `gemini-3.5-flash` | `workspace_publish_candidate` | pass | 358.9s | 3085/3000 | pass | pass | 3 | 0 |

Run7 raw JSONL/debug artifacts:

- `agrun_docs/live-tests/x2-live-2026-05-20/run7-timeout-ssot-gemini-3.5-flash.jsonl`
- `agrun_docs/live-tests/x2-live-2026-05-20/run7-timeout-ssot-gemini-3.5-flash.md`
- `agrun_docs/live-tests/x2-live-2026-05-20/run7-timeout-ssot-debug.md`

Key proof:

- The previous run6 timeout point was crossed; cycle 5 completed under the long-research timeout SSOT.
- The final publish was `decision="ready"` with `evidenceSatisfied=true`, `lengthSatisfied=true`, `requirementSatisfied=true`, `remainingGaps=[]`.
- Source minimum passed: `readSources=3/3`, `relevantSources=2/2`; source tiers were 2 strong and 1 usable.
- JSONL convergence debug found `conflicts=0`, including no `missing_latest_workspace_read_without_workspace_read_action` and no final impossible action surface.

Remaining HBR: prompt noise is still high late in the run (`lastPromptChars=35545`, `loopStateChars=21494-23035`, `actionPatternConvergence` around 5.6k). The run passed, but prompt compaction/noise should still be improved later for cost and latency.

## HBR

Run7 resolved the original run5 live blocker for `gemini-3.5-flash`, but late prompt noise is still high. Future work should compact noisy loop fields and reduce repeated search/read planning so successful runs are cheaper and faster.
