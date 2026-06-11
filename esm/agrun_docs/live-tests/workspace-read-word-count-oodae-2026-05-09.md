# Workspace Read / Word Count / OODAE Payload Review — 2026-05-09

## Trigger

User asked why the AI agent did not read its virtual workspace, did not
check word/character count, and appeared not to follow the standard OODAE
agentic runtime workflow for a Chinese 3000-character deep research report.

## Findings

The workspace tools existed:

- `workspace_list`
- `workspace_read`
- `workspace_write`
- `workspace_replace`
- `workspace_remove`
- `workspace_finalize_candidate`

The problem was not missing tools. The problem was weak planner payload
guidance and weak workspace observability:

1. Envelope planner prompts had workspace guidance, but the native-tools
   system prompt did not include the same explicit workspace workflow. Gemini
   Lite often uses native tool surfaces or falls back across planner modes, so
   workspace review was not consistently present in the strongest prompt
   channel.
2. Workspace outputs exposed `chars` in summaries, but did not expose a
   deterministic `textStats` object. For Chinese `3000 字` requests, the agent
   had no clean tool-output field for `cjkChars` / non-whitespace character
   count; it had to infer manually from draft text.
3. The `deep-research-writer` skill said to read `draft.md`, but finalization
   only said to mark `final_candidate.md` ready and finalize. It did not
   require reading the final candidate back and checking exact stats before
   finalization.
4. Runtime OODAE exists as host orchestration (`observe -> orient -> decide ->
   act -> evaluate`). The provider response contract is still "choose one next
   action", not "return all OODAE phases". That is acceptable for AI-first
   runtime, but the planner payload must make the next action options and
   state facts concrete enough for the model.

## Fix

- `src/runtime/virtual-workspace.js`
  - Adds deterministic `textStats` for workspace files:
    - `chars`
    - `nonWhitespaceChars`
    - `cjkChars`
    - `words`
  - Adds `finalCandidateStats` to workspace quality.
  - Renders stats in the virtual workspace prompt block.

- `src/runtime/actions/virtual-workspace-actions.js`
  - `workspace_read` and summarized file outputs now include `textStats`.
  - The action summary includes stats for quick Inspector/debug reading.

- `src/runtime/planner-prompt.js`
  - Envelope planner guidance now tells AI to inspect draft/final_candidate
    `textStats` before finalizing from workspace.

- `src/runtime/planner-native-system-prompt.js`
  - New pure module for native-tools system prompt construction.
  - Native prompt now includes the same workspace review and `textStats`
    guidance as envelope mode.

- `src/runtime/planner.js`
  - Uses the new pure native system prompt module.

- `skills/deep-research-writer/SKILL.md`
  - Requires `workspace_read final_candidate.md` after
    `workspace_finalize_candidate`.
  - Tells AI how to use `cjkChars`, `nonWhitespaceChars`, and `words` for
    requested length checks.
  - Keeps final decision AI-owned: revise when evidence supports more; finalize
    limited when evidence is thin.

## Verification

Passed:

- `node test/unit/workspace-actions.test.js`
- `node test/unit/planner-native-system-prompt.test.js`
- `node test/unit/english-codebase.test.js`
- `npm run skills:index`
- `npm run skills:copy:browser`
- `npm run build:lib`
- `npm --prefix examples/browser run test:smoke`
- `npm test`
- `npm run dist:check`
- `git diff --check`

Build note: Rollup emitted existing third-party warnings, but build completed.

## HBR

No new real API rerun was performed after this payload/tool-output fix. The
fix makes the right next action and text counts visible to the model, but a
weak model can still choose to ignore guidance. A follow-up Chrome real API run
should verify whether Gemini Lite now reads `final_candidate.md` and uses
`textStats` before finalizing.
