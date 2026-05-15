# Node agrun.js Real API 3000-word Live Test — 2026-05-15

## Goal

Run `dist/agrun.js` directly from Node with real provider API, real SearXNG web search, and real Mac mini `read_url`, bypassing browser UI state. This gives a cleaner runtime-level regression test for the 3000-word AI agent harness engineering report flow.

## Added Test Entry

Command:

```bash
npm run build:lib
npm run test:live:node-3000
```

Script:

```text
test/node-agrun-3000-live.mjs
```

The script loads `.env.local`, imports `dist/agrun.js`, creates a browser-style runtime in Node, wires `createReadUrlServiceFetch()` with the configured `READ_URL_ENDPOINT` / `READ_URL_API_KEY`, and asserts runtime facts from `runState`:

- no maxSteps terminalization
- no `planner_finalize` bypass
- meaningful workspace expansion occurred
- clean `ready` only when length and source minimum pass
- valid `limited` includes concrete `remainingGaps`
- final candidate structure audit passes
- consecutive `workspace_publish_candidate` attempts stay low

## Live Result 1

Status: failed, but useful.

Observed:

- Provider: Gemini (`gemini-3-flash-preview`)
- Candidate words: `3438`
- Candidate chars: `23938`
- Source minimum: passed (`readSources=6/3`, `relevantSources=5/2`)
- Max consecutive publish attempts: `1`
- Final structure: failed
- Structure issues: `duplicate_headings`, `duplicate_section_numbers`
- Action pattern: heavy `workspace_read` / `todo_inspect` repetition before terminal attempt
- Terminal result: runtime failed near max steps after `workspace_publish_candidate` then `workspace_finalize_candidate`

Conclusion:

The Node run proved `read_url` and source collection were not the blocker. The remaining bad result was report structure repair: once the final candidate had duplicate headings/section numbers, terminal repair did not stay active strongly enough to force meaningful structure rewrite before more terminal/read-only loops.

## Fix Applied

File:

```text
src/runtime/terminal-repair-state.js
```

Change:

```text
Do not clear active terminalRepairState merely because observable progress happened.
Only clear it when progress happened AND active observable deficits are resolved.
```

Why:

Workspace progress such as `workspace_finalize_candidate` or a version bump is not enough if `finalCandidateStructure.ok=false` still exists. Structure deficit must remain active until the candidate is actually repaired.

Regression:

```bash
node test/unit/terminal-repair-state.test.js
node test/unit/action-loop-session-terminals.test.js
node test/unit/workspace-actions.test.js
node test/unit/planner-action-surface.test.js
```

All targeted tests passed.

## Live Result 2

Status: manually stopped to avoid unnecessary real API cost.

Observed:

- The run started successfully through Node and real API.
- It reached `web_search`, skill actions, `workspace_write`, and TodoState actions.
- It then began repeating `web_search` / `todo_plan` / TodoState planning actions before reaching final report QA.

Conclusion:

After the repair-state fix, the next HBR is no longer specifically terminal publish/finalize. The newly exposed efficiency issue is earlier loop convergence: repeated planning/search/todo actions can still consume live budget before report QA. This points to a follow-up for generic read-only / planning no-progress convergence, especially around `todo_plan`, `todo_inspect`, `todo_run_next`, `web_search`, and `workspace_read`.

## HBR

Node real API testing is easier to debug than Chrome UI testing and successfully isolated runtime-level bad results. However, the latest real API proof is not yet a pass:

- First run: source and length passed, but structure failed.
- Fix applied: terminal repair no longer clears while unresolved structure deficit remains.
- Second run: stopped early due repeated planning/search/Todo loops to avoid burning more provider tokens.

## Next Recommendation

Add a planner-visible read-only/planning convergence mode:

- repeated `todo_plan` with no TodoState progress should require `todo_advance`, `todo_run_next`, workspace work, or a different action
- repeated `workspace_read` with unchanged candidate and active structure deficit should be suppressed earlier
- repeated `web_search` with no new source/read progress should require refined query, alternate `read_url`, or honest limited
- support bundle should surface `read_only_no_progress_active` as firstBadSignal when applicable
