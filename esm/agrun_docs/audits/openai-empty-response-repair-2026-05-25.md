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
  `"none"` and removes `reasoningSummary`.

Correction: the first implementation used `reasoningEffort: "minimal"`, but
`gpt-5.4-mini` rejected it with `Unsupported value: 'minimal' ... Supported
values are: 'none', 'low', 'medium', 'high', and 'xhigh'`. The repair level is
therefore `"none"` for the browser gateway path.

This keeps content generation AI-owned. The runtime does not synthesize a user
answer, does not hardcode prompt-specific text, and does not add runtime answer
quality gates.

## Verification

- `node test/unit/openai-transport.test.js`
  - Added a regression where the first Responses API result has empty
    `output_text` and `170/176` output tokens spent on reasoning.
  - Asserted the repair retry sends `reasoning.effort = "none"`, omits
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
- Chrome DevTools against `examples/browser` preview at
  `http://127.0.0.1:4173/?qa_provider=default&qa_auto_approve_tier1=1`
  - Prompt: `hi, reply one short sentence`.
  - Result: UI returned visible assistant text `Hi!`.
  - Network: three `POST https://gpt.yapweijun1996.com/v1/responses` requests,
    all HTTP 200.
  - Console: no messages.

## HBR

The real browser rerun was intentionally short and verified that the built
Default-provider route can return visible text through the gateway. The original
long `Find the latest AI browser news...` style task was not rerun, so long
multi-step gateway behavior remains a follow-up stress check.
