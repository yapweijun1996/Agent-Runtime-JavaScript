# X2 Research Phase Contract Notes — 2026-05-20

## Scope

Fix weak-model long-research failures before terminal repair:

- repeated `web_search` after candidate URLs exist but no `read_url` has succeeded;
- unnecessary `ask_clarification` when no open ambiguity exists;
- shrinking `workspace_write` / `workspace_replace` while a length deficit remains.

The fix stays AI-first: runtime projects facts and blocks invalid moves, but does not choose sources, write report prose, or publish on behalf of the AI.

## Changes Under Test

- Added focused `research_phase_contract_focused` prompt projection before `User request:`.
- Added `long_research_clarification_preflight_block` for clarification without open ambiguity after research progress.
- Added `long_research_search_read_handoff_block` when search candidates exist, two search passes have happened, and no successful `read_url` exists.
- Kept the existing length-deficit rewrite guard active for weak-model shrinking rewrites.
- Added `scripts/debug-x2-harness.mjs` to reproduce X2 failure states offline with Node.

## Node Debug Tool

Command:

```bash
node scripts/debug-x2-harness.mjs
```

Scenarios:

- `early-search-clarify` -> blocks `ask_clarification`, suggests `read_url`.
- `search-candidates-before-read-url` -> blocks more broad `web_search`, suggests `read_url`.
- `draft-shrinking-rewrite` -> blocks shrinking `workspace_write`, suggests append/insert growth.

## Verification

- `node --check src/runtime/action-loop-action.js`
- `node --check src/runtime/planner-prompt.js`
- `node --check scripts/debug-x2-harness.mjs`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/x2-research-phase-contract.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/planner-prompt-terminal-repair-focused.test.js`
- `node test/unit/action-pattern-convergence.test.js`
- `node test/unit/terminal-repair-state.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/lite-tier-compact-policy.test.js`
- `npm test`
- `npm run build:lib`

`npm run build:lib` passed with existing Rollup warnings from `@opentelemetry/api` `this` rewrite and `zod` circular dependency.

## HBR

This is not a live success proof yet. X2 closes the Node-reproduced weak-model failure classes, but the required live gate remains:

- `gemini-3.1-flash-lite`;
- `test/node-agrun-3000-live.mjs`;
- raw JSONL inspection, not summary only;
- candidate must beat X1.5.b baseline `648 candidateWords`;
- publish must not be blocked by the same terminal-repair contract issues.

## Next Gate

Run one live E2E only after the Node debug suite stays green. If candidateWords are still below 648 or publish blocks for a new reason, inspect raw JSONL and update this note before adding another runtime guard.
