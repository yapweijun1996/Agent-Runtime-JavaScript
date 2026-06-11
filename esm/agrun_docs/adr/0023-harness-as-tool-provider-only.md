# ADR-0023 — Harness is a tool provider, not a decision maker

- **Status:** Accepted (2026-05-08)
- **Owner:** AGRUN-230
- **Related:** ADR-0013 (skill discovery as tool), ADR-0015 (workspace as tool), ADR-0019 (final-response quality is signal), ADR-0020 (skill catalog ranking is AI tool only)
- **Audit predecessor:** `agrun_docs/audits/non-ai-first-2026-05-07.md` V14 (added today)

## Context

The 2026-05-08 real-LLM live test (`agrun_docs/live-tests/skill-catalog-ai-tool-only-2026-05-08-real-llm-matrix.md`) on `gemini-3.1-flash-lite-preview` × Mandarin × 3000-word prompt showed that ADR-0020 narrow scope was met (no `skillCatalogRanking` field anywhere) but the broader system still routed the run as:

| Signal | Healthy target | This run | Status |
|---|---|---|---|
| Final-answer source | `planner_final` | `runtime_finalize` (forced) | ❌ |
| AI finalize attempts blocked | 0 | 17 | ❌ |
| `before-finalize-veto` step count | <5 | 23 | ❌ |
| `planner-repair-failed` count | 0 | 14 | ❌ |
| `session-budget-breach` count | 0 | 9 | ❌ |
| Source quality | strong/medium | thin:2 / strong:0 | ❌ |
| draft.md size | ~3000 chars | 919 chars (~25%) | ❌ |
| Final answer authoring | AI authored | runtime_finalize re-prompt fabricated | ❌ |

The root cause is architectural, not local: the runtime still contains 8 sites where it makes decisions on behalf of the AI (push-mode), instead of being a pure tool provider that the AI calls (pull-mode). Each previous ADR attacked one local symptom; the system as a whole continues to behave as a runtime-driven controller that occasionally consults the AI rather than an AI-driven loop that occasionally calls the runtime.

This contradicts the project rule in `CLAUDE.md`:

> agrun.js is a general harness agent runtime javascript library for all kind frontend system. We must build the real AI-first architecture, follow by harness engineering principle, remove the non AI-first logic if needed.

## Decision

Delete the 8 runtime-decision sites in one PR. Runtime retains only:

- Provider abstraction (LLM call / tool invocation / streaming token relay).
- Tool surface (`list_agent_skills`, `read_agent_skill`, `use_agent_skill`, `execute_skill_tool`, `web_search`, `read_url`, `workspace_*`, `todo_*`, `final`, `finalize`, `plan`, `clarify`).
- Read-only signals on `runState` and `loopState` that the AI sees in the next planner prompt (`finalResponseQuality`, `recoveryContext`, `sessionBudget`).
- Pure JSON-envelope repair (one round-trip retry to fix malformed JSON; not push-mode because the AI's intent is the same — runtime is just a JSON parser shim).

Runtime stops:

- Re-prompting the LLM with hardcoded "fix this" instructions on top of AI's finalize attempt.
- Vetoing AI's finalize decision based on runtime-side coverage / quality / autopilot heuristics.
- Pre-loading the full skill catalog into the planner prompt before AI asks.
- Auto-recovering from a malformed plan envelope by extracting one action and running it standalone.
- Auto-finalizing on session-budget breach.
- Strict-retry cascade (3rd API call) when envelope repair already failed.

When AI's output is bad, AI's output is bad — AI sees the diagnosis as a signal next turn (within the same run only; for the last cycle the host just receives the bad output). The harness does not silently rescue the AI by re-prompting it with runtime-authored instructions.

## Sites deleted (8)

| # | File | Symbol / Region | Push-mode behavior deleted |
|---|---|---|---|
| 1 | `src/runtime/action-loop-planner.js` | `resolvePlannerSkillCatalog` | Runtime no longer pre-loads the policy-filtered catalog into `loopState.bundledAgentSkills` on cycle 1. Returns `{ skills: [] }` always. AI must call `list_agent_skills(query)` to populate. |
| 2 | `src/runtime/runtime-finalize.js` | Lines 123–177 (quality-repair injection) | Runtime no longer re-prompts the LLM with `buildFinalResponseRepairInstruction(quality)` after a failed quality check. The first finalizer response is the answer. |
| 3 | `src/runtime/action-loop-session-terminals.js` | `handlePlannerFinalDecision` quality-repair branch (lines 158–197) | Runtime no longer routes `planner_final` through `executeRuntimeFinalize` when its quality check fails. Bad planner_final ships as-is. |
| 4 | `src/runtime/action-loop-session-terminals.js` | `invokeBeforeFinalize` + `applyBeforeFinalizeVeto` | Runtime no longer runs the 5-veto chain (todo-autopilot, research-coverage, citation-coverage, research-quality, research-report-loop) before AI's finalize. AI's finalize is final. |
| 5 | (covered by #4) | — | `maybeCreateTodoAutopilotVeto` stops being called. The function stays exported for hosts who want to wire it via `onBeforeFinalize`. |
| 6 | `src/runtime/planner.js` | `planNextActionWithEnvelope` strict-retry cascade (lines 351–397) | Runtime no longer makes a 3rd API call with hardcoded strict-retry prompt when envelope repair fails. The original repair attempt's `null` decision surfaces, AI re-plans next cycle. Pure envelope repair (`requestPlannerEnvelopeRepair`) stays. |
| 7 | `src/runtime/action-loop-session-loop.js` | `maybeEnforceBudgetBreach` call (line 117) | Runtime no longer force-finalizes on budget breach. Budget signal is exposed via `runState.sessionBudget` so AI can see and self-finalize. If AI ignores, the loop hits `maxSteps` and returns `MAX_STEPS_EXCEEDED`. |
| 8 | `src/runtime/action-loop-plan.js` | `executeStandaloneRecoveredAction` + `createStandaloneMutatorRecovery` (lines 64–76, 237–304) | Runtime no longer auto-extracts a single action from a malformed plan envelope and runs it standalone. Plan validation failure surfaces as observation; AI re-plans. |

## Surfaces preserved

- `analyzeFinalResponseQuality` — runs as a signal-only check; results recorded to `runState.finalResponseQuality.lastIssues`. AI sees codes via `loopState.qualityContext`. No runtime action taken.
- `noteFinalResponseQualityIssues` — same as above; renamed function from earlier ADR-0019 PR 1.
- `requestPlannerEnvelopeRepair` — pure JSON-fix shim. Not push-mode; just one API round-trip to convert malformed JSON to valid JSON for the same intent.
- `maybeEnforceConsecutiveFailureGuard` — kept as a hard fail-safe (5 consecutive failures of the same action → finalize with "couldn't complete" message). Lower priority for ADR-0024+ if it fires inappropriately.
- `requestFinalizerProviderResponse` empty-response retry — kept; runtime asks AI to re-emit non-empty content (one retry only). Borderline push but bounded and only fires on provably empty AI output.
- Skill ranking utilities (`tokenizeSkillCatalogText`, `rankSkillManifests`, `selectSkillCatalogCandidates`) — exported in `src/index.js` for hosts who want a custom ranker. Default planner path no longer uses them.

## Alternatives rejected

1. **Keep all 8 sites, add config flags to opt out** — Multiplies test matrix and leaves AI-first as a non-default path. Rejected: ADR-0019/0020 already showed the patch-by-flag pattern doesn't bring the system to AI-first.
2. **Delete sites #1–#5 only, keep budget+plan-recovery** — Live test will keep showing `runtime_finalize` from budget breach when lite models stall. Rejected: the user's acceptance criteria explicitly require 0 runtime decisions.
3. **Auto-translate user prompt to English before catalog ranking** — Rejected in ADR-0020 already; revisited because it surfaces here. Adds an English-only assumption that breaks for hosts with non-English skill manifests.
4. **Replace runtime decisions with `onBeforeFinalize` host hook** — Already exists. Hosts who need runtime decisions (legacy behavior) can wire the deleted vetoes back via the hook. ADR-0023 only changes the default behavior; host hooks unchanged.

## Acceptance criteria

Verified end-to-end via real LLM run (browser example, `gemini-3.1-flash-lite-preview`, Mandarin 3000-word research prompt).

| # | Acceptance signal | Verification source |
|---|---|---|
| A1 | `git grep -n "invokeBeforeFinalize\|applyBeforeFinalizeVeto\|executeStandaloneRecoveredAction\|createStandaloneMutatorRecovery" src/` returns 0 hits (function definitions deleted) | grep |
| A2 | `git grep -n "buildFinalResponseRepairInstruction" src/runtime/runtime-finalize.js src/runtime/action-loop-session-terminals.js` returns 0 hits | grep |
| A3 | `git grep -n "maybeEnforceBudgetBreach\b" src/runtime/action-loop-session-loop.js` returns 0 hits | grep |
| A4 | `git grep -n "planner-strict-retry-requested\|planner-strict-retry-completed" src/` returns 0 hits | grep |
| A5 | `npm run check` exits 0 | terminal |
| A6 | `npm run build` exits 0 | terminal |
| A7 | Live e2e: `before-finalize-veto` step count = 0 | live-test md |
| A8 | Live e2e: `plan-validation-standalone-recovery` step count = 0 | live-test md |
| A9 | Live e2e: final answer source = `planner_final` (not `runtime_finalize`) | live-test md |
| A10 | Live e2e: AI calls `list_agent_skills(query=…)` ≥ 1 time | live-test md |
| A11 | Live e2e: AI-authored Mandarin output ≥ 3000 chars | live-test md |
| A12 | Live e2e: NO `final-response-quality-repair` step (runtime-injected repair) | live-test md |

A run that meets A1–A12 unblocks the AGRUN-221 audit closure for sites V1–V8.

## Risks

- **Lite models without runtime guardrails may produce empty / malformed final answers.** Acceptable per ADR-0019 / this ADR — host can swap to a stronger model or wire `onBeforeFinalize`. Runtime stays AI-first.
- **Hosts who relied on the deleted vetoes for compliance / coverage** must re-implement via `onBeforeFinalize`. Existing function exports stay (e.g. `maybeCreateTodoAutopilotVeto`) so hosts can call them inside the hook.
- **Plan validation errors now surface as observations** instead of silent recovery. Expect a small bump in cycle count for malformed plans (extra round-trip to AI). This is the AI-first cost.

## Cadence

Single PR. Touches src/ + tests + browser example + ADR + live-test. Acceptance gate is the live e2e run, not just `npm run check`.

## Migration notes for hosts

Hosts upgrading from pre-ADR-0023:

1. If you depend on `before-finalize-veto` behavior (auto-veto on todo / coverage / quality), wire `onBeforeFinalize` and call the still-exported veto helpers inside it.
2. If you read `runState.skillCatalogRanking`, that field is already gone (ADR-0020). No action.
3. If you depend on auto-finalize on budget breach, set a smaller `runtimeConfig.maxSteps` and read `runState.sessionBudget` from the result to detect breach.
4. If you depend on plan-validation-standalone-recovery, listen for `plan-validation-rejected` step events and re-emit a single-action decision via your own logic.
