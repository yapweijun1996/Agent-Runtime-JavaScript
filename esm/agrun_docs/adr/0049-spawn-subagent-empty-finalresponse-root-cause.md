# ADR: `spawn_subagent` empty `finalResponse` — result-envelope extraction (AGRUN-296)

Status: Accepted — 2026-06-04. Root-cause follow-up to AGRUN-261 / ADR-0037.

## Context

- AGRUN-261 (2026-05-27) handled the symptom "a child `spawn_subagent` completes
  `status:"success"`/`"completed"` but the parent gets no answer" with strategy B:
  `normalizeChildResult` (`src/runtime/spawn-subagent-capability.js`) **demotes** the
  empty success to `status:"failed"` + `error.code:"SUBAGENT_EMPTY_RESPONSE"` so the
  parent AI can react. It surfaced the problem but did not explain *why* the child's
  answer was empty.
- The empty result was **mis-attributed to "Gemini grounding / empty-completion
  returns nothing."** AGRUN-296 was filed (2026-06-03) to give the child an AI-first
  recovery cycle so a worker that did real work would not lose its summary.
- Investigation for AGRUN-296 found a **deterministic** root cause that the "Gemini
  empty" framing masked: `normalizeChildResult` read the child answer with
  `readString(childResult.output)`, but `runLoop` returns `result.output` as a
  **terminal object** `{ kind:"final_response"|"planner_final", text, … }` for every
  successful finalize/final terminal — **never a bare string**. `readString` of an
  object is `""`, so the child answer was discarded *regardless of what the finalizer
  produced*. The only thing that ever populated `finalResponse` was the
  `runState.lastPlannerFinalText` fallback, which is captured only on the `final` path
  and only for answers ≥ 80 chars — so short answers (e.g. `"PONG"`) and every
  `finalize`-path child lost their answer and were demoted to `SUBAGENT_EMPTY_RESPONSE`.

  Verified deterministically: a real `runLoop` finalizing `"PONG"` returns
  `result.output = { kind:"final_response", text:"PONG" }` with `lastPlannerFinalText:
  null`; the pre-fix extraction computed `""`. The existing capability unit tests
  passed only because they mocked `output` as a **string** (`"child final answer"`) — a
  shape the real `runLoop` never produces.
- Affected: `src/runtime/spawn-subagent-capability.js`,
  `test/unit/spawn-subagent-capability.test.js`,
  `agrun_docs/adr/0037-spawn-subagent-orchestrator-worker.md`,
  `agrun_docs/context-attention-budget-and-subagents.md`,
  `agrun_docs/multi-agent.md`.

## Decision

- **Fix the extraction, not the symptom.** `normalizeChildResult` now reads the child's
  answer from the terminal envelope object via a kind-guarded helper
  `readChildFinalResponse(childResult, runState)`:
  - For genuine terminal kinds (`final_response`, `planner_final`) read `output.text`.
  - Keep a bare-string fallback for back-compat (legacy hosts / string outputs).
  - Then fall back to `runState.lastPlannerFinalText`, then `""`.
  - The **kind-guard is deliberate**: a blocked child returns
    `output.kind:"approval_required"` with text `"Approval required before running X"` —
    that is NOT a final answer and must never leak as a `finalResponse`.
- This is path-agnostic: it fixes both the `finalize` (runtime-finalizer LLM) and
  `final` (planner-inlined) terminals uniformly, which a recovery-cycle (option a) would
  not have, because the answer was being produced correctly and then dropped.
- **AGRUN-261's demotion is preserved.** When the child genuinely produces no text
  (`output.text` empty/whitespace) the extraction yields `""` and the existing
  `emptySuccessError` branch still demotes to `SUBAGENT_EMPTY_RESPONSE`. That is the
  correct outcome for a genuinely empty/exhausted child.
- **Parent-side contract (option b), documented, not coded:** when the parent observes
  a `subagent_result` with `error.code:"SUBAGENT_EMPTY_RESPONSE"`, it should re-delegate
  with a sharper task, answer inline from its own context, or report the gap to the
  user — never fabricate the worker's output. No hardcoded fallback text; the runtime
  never invents the child's answer (consistent with ADR-0014, ADR-0023).

## Alternatives

1. **(a) One-shot child recovery cycle before demotion.** Re-prompt the child once when
   its finalize is empty. Rejected as the *primary* fix: the answer was not actually
   empty — it was produced and then dropped by the extraction bug, so a recovery cycle
   would have re-run a child that already succeeded. Also higher cost and loop surgery.
2. **(A2) Close the finalizer "clean-empty return" gap** in `executeRuntimeFinalize`
   (the existing one-shot retry only fires when the provider *throws* an empty-response
   error, not when it returns `text:""` cleanly). Deferred: the required real-LLM Gemini
   e2e (below) confirmed the child returns its answer cleanly once extraction is fixed —
   the genuine-empty finalizer did not occur. Building A2 now would only add regression
   surface on the research finalize path for an unproven case. Revisit only if a future
   genuine finalizer-empty is observed (the demotion already handles it safely).
3. **Keep AGRUN-261 demotion as the only behavior.** Rejected: it loses the answer of
   every finalize-path child — the bug that generated this ticket.

## Consequences

- Pros: deterministic root-cause fix; every successful child now returns its answer to
  the parent; no new LLM calls; no runtime-invented text; AGRUN-261 demotion intact for
  genuinely empty children; tests now mirror the real `runLoop` envelope shape.
- Cons: none functional. The bare-string fallback is retained purely for back-compat.
- Risks: low. The guard is provably complete for today's runtime: **every** answer-bearing
  terminal emits `kind:"final_response"` or `kind:"planner_final"` — `handleRuntimeFinalize`
  and `handleDirectFinal` and the plan-synthesize / `workspace_publish_candidate` terminal
  (`action-loop-plan-terminal.js`) all use `final_response`; `handlePlannerFinal` uses
  `planner_final`. A *future* terminal that carries the final answer under a different
  `kind`/field would need to be added to the guard; until then it falls back to the string
  path and `lastPlannerFinalText` (safe — it may under-report, never leak a non-answer).

## Verification

- Deterministic unit tests (`test/unit/spawn-subagent-capability.test.js`): Test 19
  (finalize-path `{kind:"final_response", text:"PONG"}` → `finalResponse:"PONG"`,
  not demoted), Test 20 (`planner_final` extracted), Test 21 (`approval_required.text`
  not leaked), Test 22 (string back-compat), Test 17 (genuine empty whitespace → still
  `SUBAGENT_EMPTY_RESPONSE`). Tests 2/17 updated from the fictional string `output`
  shape to the real terminal-object shape.
- Probe against the real `runLoop` confirmed `result.output = {kind:"final_response",
  text:"PONG"}` and pre-fix extraction `""`.
- Gates: `npm test` EXIT 0, `npm run build` EXIT 0, `npm run dist:check` EXIT 0.
- Real-LLM (3b) e2e on `gemini-3.1-flash-lite` (the exact reproducing model), 3 runs:
  parent `completed`, spawn `action-executed` status `success`, no
  `SUBAGENT_EMPTY_RESPONSE`, parent relayed the worker's answer
  (`"The worker's answer is: PONG."`).

## Rollback

- Revert the `readChildFinalResponse` helper and its call site in
  `normalizeChildResult` to `readString(childResult.output)`; revert the test envelope
  shapes. This restores the bug (every finalize-path child demotes) and would need this
  ADR plus the AGRUN-296 task entries flipped back to OPEN.
