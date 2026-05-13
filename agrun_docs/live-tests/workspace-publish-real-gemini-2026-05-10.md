# Workspace Publish Real Gemini QA

Date: 2026-05-10

## Goal

Run the Chinese long-form research prompt with a real Gemini provider and verify
whether the new workspace candidate publishing path is used:

`用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告`

Expected path:

1. AI discovers and reads `deep-research-writer`.
2. AI searches/reads evidence.
3. AI writes workspace artifacts.
4. AI writes and marks `final_candidate.md`.
5. AI publishes with `workspace_publish_candidate`.

## Run 1: Before Payload Fix

Result:

- `finalAnswerSource=continuation_required`
- `terminalizedBy=max_steps_continuation`
- maxSteps reached at 80 cycles
- `final_candidate.md` remained empty
- no `workspace_publish_candidate`
- all read_url records were failed/thin in runtime summary

Root cause found in the shorter reproduction:

- Gemini native plan actions emitted correct action payload inside
  `toolArgsJson`, for example:
  `{"url":"https://www.news.cn/..."}`
- The same plan action also emitted `args: {}`.
- Runtime plan parsing/validation only executed `args`.
- `read_url` therefore received an empty URL and failed with
  `invalid_url`.

This was a payload/response wiring issue, not a read_url service failure.
Direct service checks for `https://example.com` and the Velofill AI browser
article succeeded.

## Fix 1: Generic Plan Args Fallback

Changed:

- Native plan parsing now applies `toolArgsJson` / `toolArgs` fallback for all
  plan action names, not only `execute_skill_tool`.
- Envelope plan validation also reads the same fallback shape.
- Added regression tests for normal actions such as `read_url`.

This is generic payload normalization. It does not special-case AI browsers,
Chinese prompts, or one URL.

## Run 2: After Payload Fix

Result:

- `read_url` now received real URLs.
- Examples:
  - `https://en.wikipedia.org/wiki/Arc_(web_browser)` read successfully.
  - `https://developer.chrome.com/docs/ai/built-in` read successfully.
  - some pages remained blocked/thin, which is expected external source
    behavior.
- `readUrlOk=6/7`
- `finalAnswerSource=continuation_required`
- `terminalizedBy=max_steps_continuation`
- `final_candidate.md` still empty
- no `workspace_publish_candidate`

Conclusion:

The payload bug was fixed, but the skill workflow still spent too many cycles on
research and did not move quickly enough from evidence to draft/final candidate.

## Fix 2: Skill Workflow Simplification

Changed `deep-research-writer`:

- Removed numeric "5+ searches / 6+ reads" style evidence exhaustion language.
- After each search/read batch, AI must update workspace before doing more
  research.
- Before another research batch, AI must name the exact evidence gap it is
  closing.
- Once `evidence.json` contains usable facts, the next phase is drafting.
- If `draft.md` already broadly answers the request, the next phase is
  self-review or final candidate publishing, not broad search.

This keeps the runtime AI-first: the skill guides workflow, while runtime does
not judge length/source sufficiency.

## Run 3: After Skill Workflow Fixes

Shorter 45-step real Gemini sanity run:

- `readUrlOk=7/8`
- workspace files created:
  - `questions.md`: 352 chars
  - `evidence.json`: 1640 chars
  - `outline.md`: 1296 chars
  - `draft.md`: 3828 chars
- workspace quality:
  - `outline=pass`
  - `evidence=pass`
  - `draft=pass`
  - `critique=missing`
  - `final_candidate=missing`
- `finalAnswerSource=continuation_required`
- no `workspace_publish_candidate` yet

## HBR

The direct workspace publish path is implemented and unit-covered, and real
Gemini now reaches useful workspace drafting with successful reads. But the real
long-run prompt still did not reach `final_candidate.md` and
`workspace_publish_candidate` within the tested budget. The remaining issue is
AI workflow discipline: after a usable draft exists, the model must self-review,
promote to final candidate, and publish instead of returning to broad research.

The latest skill amendment targets that exact failure, but a full 80-step rerun
after this final amendment was not performed in this pass because the prior real
runs consumed substantial time.
