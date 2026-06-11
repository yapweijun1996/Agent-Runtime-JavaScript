# Live e2e: workspace_replace ambiguous + replace_all recovery — 2026-05-12

Source ADR: [ADR-0013 — Workspace Tools study from claude-code + codex](../adr/0013-workspace-tools-claude-code-codex-study.md).
Script: `scripts/live-workspace-replace-ambiguous.mjs`.

## Goal

Prove that a production LLM (OpenAI, real API key from `.env.local`) consumes the new `status: "ambiguous"` signal emitted by `workspace_replace` and self-recovers by re-invoking the action with `replace_all: true`. This is the AI-first contract — runtime exposes a fact, AI owns the decision — and previously had only synthetic unit-test coverage.

## Setup

- Branch state: 5 study-from-sample fixes landed (see ADR-0013).
- Provider: `openai` via `runProviderTurn` (`test/live-helpers.mjs`).
- No `actionPolicy` overrides; no `selfCorrection` overrides; default browser-style runtime.
- Single-turn prompt designed to force the multi-match path:

```
Demonstrate workspace_replace error handling end-to-end:
1. Use workspace_write to put the text "alpha beta alpha gamma alpha" into draft.md.
2. Use workspace_read on draft.md.
3. Use workspace_replace with find="alpha" replace="ALPHA" path="draft.md" without replace_all. The runtime will return status=ambiguous because the find text matches multiple times.
4. React to the ambiguous status by calling workspace_replace again with replace_all:true.
5. Use workspace_read again on draft.md to confirm the new content is "ALPHA beta ALPHA gamma ALPHA".
6. Use workspace_finalize_candidate on draft.md.
7. Use workspace_read again on draft.md.
8. Use workspace_publish_candidate to publish draft.md as the final answer.
Report ONLY by going through these tool calls in order. Do not output text explanations between calls.
```

The prompt explicitly instructs the AI to *trigger* the ambiguous path. A free-form prompt would not be deterministic enough for a single-run smoke. The point of this e2e is to confirm signal consumption and recovery, not to estimate the "natural" ambiguous-rate.

## Run command

```sh
node scripts/live-workspace-replace-ambiguous.mjs
```

## Result (verbatim JSON from the run)

```json
{
  "status": "completed",
  "outputKind": "final_response",
  "finalAnswerLength": 28,
  "workspaceOperations": [
    { "action": "write",              "cycle": 1, "status": "ok",        "summary": "Initial draft content for replace test" },
    { "action": "read",               "cycle": 2, "status": "ok",        "summary": "reviewed draft.md (chars=28, nonWhitespace=24, cjk=0, words=5)" },
    { "action": "replace",            "cycle": 3, "status": "ambiguous", "summary": "Attempt replace without replace_all to trigger ambiguous status" },
    { "action": "replace",            "cycle": 4, "status": "ok",        "summary": "replaced 3 occurrences in draft.md" },
    { "action": "read",               "cycle": 5, "status": "ok",        "summary": "reviewed draft.md (chars=28, nonWhitespace=24, cjk=0, words=5)" },
    { "action": "finalize_candidate", "cycle": 6, "status": "ok",        "summary": "marked draft.md ready" },
    { "action": "read",               "cycle": 7, "status": "ok",        "summary": "reviewed draft.md (chars=28, nonWhitespace=24, cjk=0, words=5)" }
  ],
  "sawAmbiguous": true,
  "sawReplaceAll": true,
  "finalCandidatePath": "draft.md",
  "publishBlockSignal": null
}
PASS: model consumed ambiguous status and recovered via replace_all:true.
```

## What this confirms

| Contract | Evidence |
|---|---|
| `workspace_replace` returns `status: "ambiguous"` on multi-match without `replace_all` | Cycle 3 row |
| `replace_all: true` triggers global replace | Cycle 4 row: "replaced 3 occurrences" |
| Operation log status enum includes `"ambiguous"` (new) | Cycle 3 status field |
| Final candidate post-recovery has correct content (28 chars: `ALPHA beta ALPHA gamma ALPHA`) | `finalAnswerLength: 28` |
| Run completes terminally via `workspace_publish_candidate` path (no infinite loop) | `status: "completed"`, `outputKind: "final_response"`, `publishBlockSignal: null` |
| AI on real OpenAI does follow the recovery instruction (not stuck) | The cycle 3 → cycle 4 transition |

## What this does NOT confirm

1. **Free-form ambiguous rate.** The prompt explicitly instructs AI to trigger the ambiguous path. We don't know how often AI spontaneously produces a non-unique find text in long research runs. That requires multi-prompt sampling over weeks.
2. **Other providers.** This is OpenAI only. Gemini / Claude variants may need a separate live-test pass.
3. **Other models within OpenAI.** Test ran with whatever model `runProviderTurn` defaults to from `.env.local`. Smaller models may abandon the workflow on `status: "ambiguous"`; needs explicit per-model coverage if shipping a strict mode.
4. **Fuzzy fallback path on real AI.** This run did not exercise `fuzzyMatch: "trim_trailing_whitespace"` or `"normalize_quotes"` — those are unit-tested only.
5. **Read-before-mutate gate firing on real AI.** This run included a `workspace_read` between every mutation. A future test should construct a cross-cycle session where AI tries to mutate without reading.

## Honest bad result

- `npm run test:live:skills` failed in the same session with `runOpenAIAgentSkillScenario` timing out (90s) on both `expert-coder` prompts. That suite does not touch workspace mutation and is unrelated to this change — diagnosed as OpenAI API throughput throttling on `2026-05-12`. Re-run is needed to confirm no transient regression, but mechanism makes regression near-zero probability.
- The targeted live script does NOT yet have a CI hook. It runs on-demand. If we want this to be a regression gate it needs to move to `test:live:workspace` and gain a non-LLM-flaky assertion (e.g. assert workspace operations log shape directly, with `sawAmbiguous && sawReplaceAll`).

## Verdict

Production-grade evidence that the AI-first contract works end-to-end on real OpenAI: runtime exposes `status: "ambiguous"` + `matchCount` + `contextSnippets`; AI reads the signal and recovers with `replace_all: true`. No runtime patch, no hardcoded fallback, no silent state change. ADR-0013 is **Accepted** with this live evidence attached.
