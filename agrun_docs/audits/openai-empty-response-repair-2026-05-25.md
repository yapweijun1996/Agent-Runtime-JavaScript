# OpenAI Responses Empty Text Repair

Scope: browser example and shared OpenAI browser provider.

## Issue

The example browser Default provider can receive an OpenAI Responses API object
with `status: "completed"` but an empty `output_text`. The observed response
had `max_output_tokens: null`, `reasoning.effort: "low"`, `output_tokens: 176`,
and `output_tokens_details.reasoning_tokens: 170`.

This is not caused by agrun setting `max_output_tokens`. Provider request
normalization currently rejects `max_output_tokens`, `maxOutputTokens`, and
`maxTokens` as unsupported generation tuning parameters. The empty output is a
reasoning-model failure mode: hidden reasoning tokens are still output tokens,
and a response can spend almost all generated output on reasoning before
returning no visible assistant text.

OpenAI's Responses API reference defines `max_output_tokens` as an upper bound
that includes both visible output and reasoning tokens. The reasoning guide also
states that reasoning tokens are billed as output tokens and can consume output
budget before visible text appears.

## Fix

`src/skills/providers/openai-browser.js` now treats an empty OpenAI Responses
result as a provider transport recovery case:

- first request preserves the host's configured reasoning options;
- if the result has no assistant text and no tool calls, the single repair
  retry adds `metadata.agrun_empty_response_repair = "true"`;
- for Responses API only, the repair retry lowers `reasoningEffort` to
  `"minimal"` and removes `reasoningSummary`.

This keeps content generation AI-owned. The runtime does not synthesize a user
answer, does not hardcode prompt-specific text, and does not add runtime answer
quality gates.

## Verification

- `node test/unit/openai-transport.test.js`
  - Added a regression where the first Responses API result has empty
    `output_text` and `170/176` output tokens spent on reasoning.
  - Asserted the repair retry sends `reasoning.effort = "minimal"`, omits
    `reasoning.summary`, and tags `metadata.agrun_empty_response_repair`.
- `npm --prefix examples/browser run build`
  - Verified the example browser production bundle still builds.
- `npm test`
  - Verified the repair regression inside the full smoke/concern suite.
- `npm run build`
  - Verified root library, example browser, long-task-lab, and copied dist
    artifacts build successfully.
- `npm run dist:check`
  - Verified generated distribution markdown links after adding this audit doc.
- `git diff --check` and `task.jsonl` JSONL parse
  - Verified diff whitespace and task ledger syntax.

## HBR

No real browser gateway rerun was completed in this slice. The fix is pinned by
mocked Responses API transport coverage and browser build verification, but a
live Default-provider browser turn should still be run before calling the
gateway behavior fully closed.
