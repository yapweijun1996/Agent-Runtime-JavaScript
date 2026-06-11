# Action-Loop History Compaction (GAP 4) — Design

**Status:** DONE (implemented 2026-06-10). Single implementation chunk. Implementation note: the projection is wired through a separate `promptHistory` option on the planner request (computed once per cycle in `action-loop-session-loop.js` via `projectActionHistory(session, config)`), so `action-loop-planner.js` keeps feeding the FULL `actionHistory` to `readDeniedActions` while both `buildPlannerPrompt` and `planNextAction` receive the compacted view. The session-surface `charsPerToken` constant is reused via `normalizeSessionPolicy(null).charsPerToken` (the constant itself is not exported and `src/session/` is out of scope). Observer usage rides on the `history-compaction` step detail, so `prepareRuntimeStepDetail` → `recordCostEntry` accounts observer spend in the GAP 5 cost ledger automatically (verified by a `callKind: "history-compaction"` ledger-entry assertion in the unit test). Live lever: `NODE_AGRUN_LIVE_HC_TRIGGER_TOKENS` in `test/node-agrun-3000-live.mjs`.

**Default-config observation (2026-06-10 A/B, gemini-3.1-flash-lite):** a typical 3000-word research run peaks at ~900–1100 projected-history tokens over 32–40 cycles (~27 tokens/cycle), so the default `triggerTokens: 4000` never fires for single-report runs (zero observer overhead, prompt byte-identical — verified live) and would first trigger around cycle ~145. The per-cycle re-trigger cascade observed earlier exists only when the trigger sits at/below the natural floor (`protectHeadEntries + protectTailEntries` raw entries + observation log, ~830 tokens in that run): at trigger 800 it cascaded 1-entry observer calls every cycle; at 1500 and 4000, zero triggers. Tuning rule for hosts: set `triggerTokens` comfortably above that floor (≥ ~2× the protected head+tail block) or the observer will run every cycle. No min-new-entries gate needed for the defaults; revisit only with the Reflector.

**Marathon probe (same date):** even a forced 8-topic serial-research run — the longest single-task run obtainable on this model (51 cycles, the AI publishes when it judges the task done regardless of word/topic targets) — peaked at ~1150 projected-history tokens. Conclusion: the default trigger CANNOT fire in any single-report scenario; it is strictly a tail-risk valve for 100+-cycle sessions (multi-hour autopilot / browser marathons), which is the design intent. The mechanism's live proof is the lowered-trigger run above (9 observer steps in trace.v1); the threshold arithmetic from there to the default is deterministic and unit-tested.
**Gap:** GAP 4 of the general-runtime capability audit (see KB direction review 2026-06-10), **corrected after code reading** (the 5th time a gap list overstated — the original claim "agrun lacks compaction" is wrong on the session surface and right on the action loop):

- agrun already ships a full **session-surface** compaction subsystem: token budget (`src/session/token-budget.js` `evaluateProviderPromptBudget` → `needsCompaction`), LLM summarization + CAS summary write (`src/session/compaction.js:184-256`), tiered degradation (`src/session/context-window-plan.js`), thread-aware windows (AGRUN-145). **None of this changes.**
- The **action loop** — the surface that actually runs long — uses none of it (verified: `grep prepareProviderSessionContext|needsCompaction src/runtime/` is empty; only `config.js` imports `normalizeCompactionPolicy`):
  1. `session.actionHistory` is pushed unbounded every cycle (`action-loop-session-loop.js:226` and ~20 sibling push sites; `action-loop-action.js:218` etc.).
  2. It is passed **in full** to the planner: `action-loop-planner.js:92` `history: actionHistory`.
  3. It is rendered **in full** into every planner prompt: `planner-prompt.js:215-220` (`historyBlock = history.map(...)`, numbered list, no slice, no cap).

**Consequence:** planner prompt grows linearly with cycle count → cumulative token spend grows quadratically over a run → long tasks (long-task-lab, 3000-word e2e) pay more every cycle and eventually overflow the provider context window with no recovery path.

## Reference design

Mastra **Observational Memory**: an Observer compresses raw history past a token threshold into a dated, event-based observation log (decisions, outcomes, failures preserved as events — not prose documentation); the most recent raw block is kept verbatim; a second-level Reflector merges/supersedes observations when the log itself grows. Tool-heavy workloads compress 5–40×. We adopt the **Observer layer only**; the Reflector is covered minimally by incremental re-compaction (below), full Reflector = future work.

## Design constraints (standing decisions this must respect)

1. **AI-first.** The compression itself is an AI job — an observer LLM call produces the observation log. The runtime's only jobs are generic mechanism: detect the threshold (same legitimacy class as `maxSteps`/`runDeadlineMs`), protect head/tail, and fall back safely. No runtime-authored heuristic summaries of content.
2. **Compact the projection, NOT the state.** In-memory `session.actionHistory` stays full and untouched — it is cheap JS, and every existing consumer keeps working on full data: `readDeniedActions` (`action-loop-planner.js:91`), `summarizeActionFailureSignal` (`action-loop-session-loop.js:984`), `checkBudget` (`session-budget.js:152`), drift/convergence detectors. **Only the history view handed to `buildPlannerPrompt` is compacted.** This kills nearly all regression risk.
3. **Never break the run.** Observer call failure → mechanical fallback projection: protected head + one `[N earlier steps omitted — compaction unavailable]` marker + protected tail. Recorded in the step detail (`mode: "fallback"`). The run continues.
4. **Prompt-visible by design.** Unlike cost (AI-invisible, GAP 5), the observation log exists FOR the planner — it replaces raw lines the planner would otherwise see. Not a violation of any standing decision.
5. **Keep runtime simple.** One new module, one config key, one session field. `src/session/compaction*.js`, `context-window-*.js`, `token-budget.js` are **not modified**.

## Mechanism

| Piece | Anchor | New behavior |
|---|---|---|
| Config | `config.js` — add `normalizeHistoryCompaction` next to `normalizeMaxCostUsd` | `historyCompaction: { triggerTokens = 4000, protectHeadEntries = 5, protectTailEntries = 15, enabled = true }`. Invalid values throw (mirror existing normalize style). Default **enabled** — under the threshold behavior is byte-identical, so short runs and all existing tests are unchanged; long runs get rescued without host opt-in. `enabled: false` restores today's behavior exactly. |
| Session field | wherever `session.actionHistory` is initialized | `session.historyCompaction = { observations: "", compactedThrough: 0 }` (observations = the running log text; compactedThrough = actionHistory index already folded in). |
| Trigger check | `action-loop-session-loop.js` cycle boundary, next to the runDeadline/maxCostUsd checks | Estimate the projected history block size with the existing chars-per-token heuristic (~4 chars/token; reuse the constant, do not invent a new estimator). Estimate covers: current observations log + raw entries since `compactedThrough`. If ≥ `triggerTokens` and there are ≥ 1 compactable entries (between head/tail protection) → run the observer. |
| Observer call | same provider path the planner uses (see `requestPlanner`, `action-loop-planner.js:79`) | One LLM call: input = previous observation log + the raw entries `[max(compactedThrough, protectHeadEntries) .. length - protectTailEntries)`; instruction = merge into an updated numbered/dated observation log preserving decisions, denied actions, failures, file paths, URLs, and numbers verbatim; never invent. Output replaces `observations`; `compactedThrough` advances. Incremental by construction — the log itself is input next time, which bounds total size (poor-man's Reflector). Usage flows through the normal provider event path, so the GAP 5 cost ledger and `maxCostUsd` automatically account for observer spend. |
| Step record | new step `history-compaction` | detail: `{ mode: "observer" \| "fallback", entriesCompacted, approxTokensBefore, approxTokensAfter }`. Visible in Inspector + `agrun.trace.v1` for free. |
| Projection | new module `src/runtime/action-history-compaction.js`, pure function `projectActionHistory(session, config)` | Returns the history array for the prompt: first `protectHeadEntries` raw entries + (if observations non-empty) one synthetic entry `{ kind: "compacted-observations", summary: <log> }` + raw entries from `compactedThrough`/tail window. Wired in at `action-loop-planner.js:92` (`history: projectActionHistory(...)`). |
| Prompt render | `planner-prompt.js:215-220` | Render the synthetic entry as its own block (e.g. `Earlier steps (compressed observations):`) instead of a numbered line, so the planner can tell compressed context from verbatim recent steps. Numbering of surrounding raw entries may stay simple (1..N of the projected list) — the planner never needed global indices. |

## Out of scope

- Full Reflector (second-level observation merge as a separate pass) — incremental re-compaction above is the v1 stand-in.
- `runState.toolContext.history` / `researchContext.readSources` in-memory caps and lifecycle sync (separate, smaller issue; prompt side already capped at 3 recent).
- Any change to session-surface compaction (`src/session/`).
- Exposing compaction pressure as a planner decision signal beyond the observation block itself.

## Acceptance

1. `npm run build && npm test` green.
2. New unit test `test/unit/action-history-compaction.test.js` (mocked provider):
   (a) low `triggerTokens` + many cycles → a `history-compaction` step appears; the NEXT planner request prompt contains the observation block, retains head + tail raw summaries, and no longer contains a known middle-entry summary string;
   (b) observer provider call fails → `mode: "fallback"` step, omission marker in prompt, run still completes;
   (c) under threshold → projected history is the same array content as raw (prompt byte-identical to today);
   (d) invalid config (`triggerTokens: 0`, negative, NaN) throws at `createRuntime`;
   (e) regression pin: denied-actions and failure-signal still computed from the FULL in-memory history while the prompt is compacted.
3. `grep -rn historyCompaction src/` shows: config normalize, session init, loop trigger, projection module, prompt render — nothing else.
4. Docs: one paragraph in `agrun_docs/public-runtime-api.md` next to `maxSteps`/`runDeadlineMs`/`maxCostUsd`.
5. Live verify (real key, `.env.local`): one long run (`test/node-agrun-3000-live.mjs` or long-task-lab scenario) with a lowered `triggerTokens` shows a `history-compaction` step in the emitted `agrun.trace.v1` and the run completes with normal output quality.

## Browser demo — URL params and known limits (2026-06-10)

The browser example exposes three HC query params (committed `95cac2199`, `6febd84b2`):

```
?debug_yn=y&hcTriggerTokens=10&hcProtectTail=0&hcProtectHead=0
```

- `debug_yn=y` — required; gates `InspectorPanel` mount in `App.tsx`. Without it the Inspector DOM never exists.
- `hcTriggerTokens` — lowers token threshold (default 4000). Positive integer only.
- `hcProtectTail` — overrides `protectTailEntries` (default 15). Non-negative integer.
- `hcProtectHead` — overrides `protectHeadEntries` (default 5). Non-negative integer.

**Proven working demo URL** (Inspector History Compaction section lights up within one turn):
```
http://localhost:3100/?debug_yn=y&hcTriggerTokens=10&hcProtectTail=0&hcProtectHead=0
```
Confirmed: 3 observer folds, mode="observer", Inspector shows "History Compaction / Folds / Entries folded" chips.

**Why `protectTail > 0` doesn't fire in short browser sessions:**

The window guard is `end > start` where `end = actionHistory.length - protectTailEntries` and `start = max(compactedThrough, protectHeadEntries)`. For the window to open, the session needs **at least `protectHead + protectTail + 1` OODA cycles**. With default values (head=5, tail=15) this requires 21+ cycles. Fast models (gpt-5.4-mini) complete short queries in 1–5 OODA cycles, so the window guard fires before the token guard. Precise condition: `cycleCount ≥ protectHead + protectTail + 1`.

**Validation strategy by protect level:**

| protect setting | min cycles needed | validation path |
|---|---|---|
| `tail=0, head=0` | 1 | Browser demo (`?hcTriggerTokens=10&hcProtectTail=0&hcProtectHead=0`) ✅ |
| `tail=1, head=1` | 3 | Unit test case (a) ✅ |
| `tail=15, head=5` (production default) | 21 | Marathon run (100+ cycles) ✅ |

**Implementation note:** `msg.metadata.debug` is NOT persisted to IndexedDB; the debug snapshot only exists in React memory for the current page-load session. Inspecting it after a page reload requires re-running the agent.
