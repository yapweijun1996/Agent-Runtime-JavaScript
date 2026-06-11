# AI-First Self-Check

A one-page litmus checklist to run **before merging any change to `src/runtime/`**, so nobody re-introduces push-mode by accident.

> Companion to [harness-engineering-principles.md](./harness-engineering-principles.md) (the HOW of debugging a harness) and [architecture-ssot.md](./architecture-ssot.md). This doc is the WHO-DECIDES gate.

---

## The one discriminator

AI-first is **not** "the AI uses tools to fetch info and write a reply." That is only the surface. The real test is **who owns the decision**:

| Owner | Owns |
|---|---|
| **AI (the model)** | policy · what to query · which action · **when to finalize** · **the final answer prose** |
| **Runtime (the harness)** | mechanism · state · **gates / loop-safety** · observability (read-only signals) |

> **Litmus question for every new code path:**
> *"Is the runtime making this decision FOR the AI, or only exposing a signal so the AI decides?"*
> If it decides for the AI → push-mode → not allowed. If it exposes a signal and hands control back → AI-first → fine.

---

## Forbidden (push-mode) vs Allowed (harness)

| ❌ Forbidden — runtime decides for the AI | ✅ Allowed — runtime is mechanism/gate |
|---|---|
| Runtime **writes the final answer text** (hardcoded prose, templates, "Based on…") | Runtime passes through the AI's `response.text`, only scrubbing internal markers |
| Runtime **force-finalizes** (on budget, on plan success, on "enough" heuristic) | Runtime exposes the budget/progress signal; AI chooses finalize; `maxSteps` ends the loop if AI ignores |
| Runtime **synthesizes / summarizes** content on the AI's behalf | Runtime assembles citations from real evidence facts (claimGraph / read sources) |
| Runtime **invents a requirement** by regexing the user prompt | Requirement comes from AI (`finalReadiness` / `requirementsChecklist`) or host (`options`) — never prompt-regex |
| Runtime **skips the planner** with a fast-path it chose | Planner always owns the next action; runtime only routes what the AI requested |
| A `veto` that **substitutes a runtime answer** and ends the run | A loop-safety gate that blocks a *repeated non-productive action*, returns `control:"continue"` + `allowedNextMoves`, and lets the AI re-plan |

The veto row is the subtle one. A gate may **block** — but after blocking it must **hand the wheel back to the AI**, never write the answer itself.

---

## Where the contract is enforced today (anchors)

Verified live in code on 2026-06-04 (branch `agrun-298`). Use these as the reference shape when reviewing new code:

- **No force-finalize** — [`action-loop-session-loop.js:58-98`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-session-loop.js): three push-mode sites deleted with comments (regex force-finalize bypass; ADR-0023 budget-breach finalize; ADR-0028 continuity preempt).
- **Loop gate hands control back** — [`action-loop-action.js:1061-1149`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-action.js): `maybeBlockTerminalRepairAction` returns `output.control = "continue"` + `allowedActions` + `requiredArgsExample`; never authors an answer. Escape valve `publishLoopEscapeGranted` (line 1082) lets the AI's real publish through.
- **Final answer = AI prose** — [`action-loop-terminal.js:265-285`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-terminal.js): `output.text = normalizeTerminalFinalText(response.text, …)` — scrub-only via [`final-response-scrubber.js`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/final-response-scrubber.js); no hardcoded answer template.
- **Readiness is AI-declared, not runtime-judged** — [`final-readiness.js:25-57`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/final-readiness.js): `createFinalReadinessAssessment` returns `{ ai: <AI's declared assessment>, observed: <objective facts only>, status }`. Runtime counts facts; the AI declares `decision: ready|limited`.
- **Research finalize is non-blocking observation** — [`research-finalize-contract.js:20-67`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/research-finalize-contract.js): records `ai_first_research_contract_observation`; the missing-readiness message says verbatim *"Runtime is not judging source, length, or content sufficiency."*
- **TodoState: annotate, never rewrite** — [`todo-state-finalize-sync.js:1-74`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/todo-state-finalize-sync.js): adds read-only `terminatedAt`/`terminatedBy`; keeps items' honest status; *"runtime never pretends the AI completed unfinished items."*
- **Citations from evidence SSOT** — [`final-response-sources.js`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/final-response-sources.js): `collectFinalResponseSources` / `reconcileCitations` build the Sources list from real read evidence, not inferred from prose.

Governing ADRs: [0023 harness-as-tool-provider-only](./adr/0023-harness-as-tool-provider-only.md), [0024 ai-first-scaffolding](./adr/0024-ai-first-scaffolding-research-class.md), [0025 terminal-source-labels (AI vs runtime)](./adr/0025-terminal-source-labels-ai-vs-runtime.md), [0028 no-runtime-auto-read](./adr/0028-simple-research-no-runtime-auto-read.md), 0033 (terminal-repair tiers / `hard_veto`), [0034 invalid-action-observation-surface](./adr/0034-invalid-action-observation-surface.md). AGRUN-294G: no prompt-regex requirements.

---

## Pre-merge checklist

Run all six before merging a `src/runtime/` change. Any "no" → it is push-mode; fix before merge.

- [ ] **No authored answer.** The change never writes user-facing prose/templates; final text still comes from the AI's `response.text`.
- [ ] **No forced terminal.** It does not force finalize/publish. It exposes a signal and lets the AI (or `maxSteps`) decide.
- [ ] **Gates return control.** Any new block/veto sets `control:"continue"` and supplies `allowedNextMoves` — it does not end the run with a runtime answer.
- [ ] **Requirements from AI/host only.** No requirement is invented by lexically parsing the user prompt (no English-only regex over `request.prompt`).
- [ ] **Signals are read-only.** New state is exposed for the planner prompt / inspector; it informs the AI, it does not steer the next turn by fiat.
- [ ] **Planner still owns the action.** No fast-path picks the next action instead of the planner.

> Reminder (P5 in harness-engineering-principles): for a rule the AI **must** obey, enforce it as a runtime *gate* — but a gate blocks-and-returns-control; it never authors policy or prose.

---

## Honest caveat

A loop-safety `hard_veto` does constrain the AI's *action choice-set* for one cycle (it refuses a repeated non-productive action). That is a gate, defensible like `maxSteps` — but it is not a pure read-only signal. AI-first ≠ "runtime never intervenes"; it means **runtime never authors policy or the answer**. Don't round the verdict up to "zero intervention."
