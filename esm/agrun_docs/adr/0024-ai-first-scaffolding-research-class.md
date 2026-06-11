# ADR-0024 — AI-first scaffolding: research-class prompt encourages tool use

- **Status:** Accepted (2026-05-08)
- **Owner:** AGRUN-231
- **Related:** ADR-0013 (skill discovery is a tool), ADR-0023 (harness is tool provider only)
- **Live-test predecessor:** [`agrun_docs/live-tests/harness-as-tool-provider-only-2026-05-08.md`](../live-tests/harness-as-tool-provider-only-2026-05-08.md)

## Context

ADR-0023 deleted 8 runtime push-mode sites and made the runtime a pure tool provider. Live e2e on `gemini-3.1-flash-lite-preview` × Mandarin × 3000-word research prompt confirmed: 0 vetoes, 0 quality-repair, AI in full control. **Honest bad result**: AI took the path of least resistance — emitted a `plan` envelope with `synthesize_per_action: true` + a single `todo_plan` action, then finalized from training data. Result: 2092-char output (vs 3000 target), 0 tool calls, 0 real source URLs, hallucinated entity references ("Globe3 ERP" / "TNO Systems") not in the user's prompt.

This is the AI-first cost: without runtime forcing tool use, lite models on weak-evidence prompts substitute `todo_plan` for actual research. ADR-0023 surfaced this real ceiling; ADR-0024 raises the ceiling without putting push-mode back.

The fix is **prompt-level scaffolding**, not runtime-level enforcement:

- Tell the AI explicitly that for substantial output requests, the recommended workflow is `list_agent_skills` → relevant skill / `web_search` → `finalize`.
- Warn the AI that using `todo_plan` as a substitute for evidence gathering produces lower-quality answers.
- Keep this as **guidance**, not as runtime veto. AI can still author from training data if it judges that is correct — but the prompt makes it the obviously inferior path.

## Decision

Add one new line to the planner system-prompt's `buildSystemPromptLines` directive list (only when `list_agent_skills` action is available — same gate as the existing skill-discovery line). The new line:

```
For substantial output requests (research reports, deep analysis, code reviews, multi-step plans), the recommended workflow is: list_agent_skills (find a relevant skill) → read_agent_skill / use_agent_skill (load it) → execute_skill_tool or web_search / read_url (gather evidence) → finalize. Do not substitute todo_plan for actual evidence gathering. Without tools, your final answer can only restate training-data knowledge, which is often outdated and lacks the source links the user requested.
```

Pure prompt change. No runtime logic added. No veto. AI decides.

## Why prompt scaffolding (and not runtime detection)

| Approach | Push-mode? | ADR-0023 compatible? | Effective on lite models? |
|---|---|---|---|
| Detect "research_loop" execution class → force `list_agent_skills` first | YES (runtime decides) | NO (re-introduces push) | YES |
| Detect prompt complexity → inject hardcoded research workflow | YES (runtime decides) | NO | YES |
| **Add prompt directive** (this ADR) | NO (runtime suggests; AI decides) | YES | TBD — verified by live e2e |
| Do nothing; let AI fail | N/A | YES | Already verified to fail (ADR-0023 live test) |

Prompt directives respect AI agency. If a stronger model picks up the agrun runtime later, the directive still applies but doesn't constrain a model that knows better.

## Surfaces preserved

- All ADR-0023 deletions stay (no veto re-introduced).
- `list_agent_skills` budget per turn (5 calls) unchanged.
- `executionClass` heuristic unchanged.
- All other planner-prompt directives unchanged.

## Acceptance criteria

| # | Criterion | Verification |
|---|---|---|
| A1 | New directive appears in `buildSystemPromptLines` output when `list_agent_skills` action available | unit test |
| A2 | Directive does NOT appear when `list_agent_skills` is absent (legacy mode) | unit test |
| A3 | `npm run check` exits same as ADR-0023 baseline (no new failures) | terminal |
| A4 | `npm run build` exits 0 | terminal |
| A5 | Live e2e: same Mandarin 3000-word prompt → AI calls `list_agent_skills(query=…)` ≥ 1 time | live-test md |
| A6 | Live e2e: AI's tool history length ≥ 1 (any tool, not just list_agent_skills) | live-test md |
| A7 | Live e2e: 0 vetoes, 0 quality-repair, 0 plan-recovery (ADR-0023 invariants preserved) | live-test md |
| A8 | Live e2e: AI-authored output ≥ 2500 chars (closer to 3000 target than ADR-0023 baseline of 2092) | live-test md |

## Alternatives rejected

1. **Detect research-class via `executionClass === "research_loop"`** and inject specialized prompt — Rejected: `classifyExecutionClass` returns `research_loop` for ALL non-clarification turns. Too coarse; would fire on simple Q&A.
2. **Detect long-prompt heuristic** (e.g., `prompt.length > 200`) and inject — Rejected: hardcoded length threshold is patch logic; brittle across languages (Mandarin chars are 3x denser than English).
3. **Add the line as a `runtimePlannerDirectives` config** — Rejected: hosts who want to opt out can still override via the existing config mechanism. Default surface should reflect the project's AI-first philosophy without requiring host opt-in.
4. **Make `todo_plan` itself less attractive** by deleting / disabling it — Rejected: `todo_plan` IS legitimate for actual multi-step plans. Discouraging it as a finalize-substitute is the right surgical fix; deleting it removes a useful tool.

## Risks

- **Stronger models may not need the directive.** Acceptable; the directive is short and explicit, doesn't constrain a model that already knows better.
- **AI may still ignore the directive on lite models.** If so, ADR-0024 escalation = ADR-0025 (tighter language, examples, possibly tool-output feedback hints — but still pull-mode).
- **Token cost.** ~250-char addition to system prompt. Negligible.

## Cadence

Single PR. Prompt change + unit test + live e2e re-run + live-test md.
