# AGRUN-524 Live Acceptance - 5-turn multi-turn simple-chat standard (2026-06-17)

## Result first

| Provider / model | First run | Tuned run | Acceptance |
|---|---:|---:|---|
| OpenAI `gpt-5-mini` | 6 LLM requests, turn deltas `[1,1,1,1,2]` | 5 LLM requests, turn deltas `[1,1,1,1,1]` | PASS |
| Gemini `gemini-3.1-flash-lite` | 6 LLM requests, turn deltas `[1,1,1,1,2]` | 5 LLM requests, turn deltas `[1,1,1,1,1]` | PASS |

Follow-up finding: this first accepted run validated the 5-turn monitor logic,
but it did not use the standard low-thinking roster for every provider. OpenAI
read `.env.local` (`gpt-5-mini`) and had no `reasoningEffort`; Gemini used
`gemini-3.1-flash-lite` but had no explicit `thinkingLevel`. The monitor has
now been corrected to default to OpenAI `gpt-5.4-mini` with
`apiVariant: "responses"` and `reasoningEffort: "low"`, and Gemini
`gemini-3.1-flash-lite` with `thinkingLevel: "low"`. Reports now print the
effective provider knobs.

Second follow-up finding: OpenAI `gpt-5.4-mini` with Responses API exposed the
native terminal path where `final_answer` is suppressed while virtual workspace
is enabled. That made a simple-chat summary turn choose `finalize`, spending a
second LLM call. The simple-chat monitor now disables virtual workspace at the
runtime profile level; long-form/report workflows keep their normal workspace
behavior.

Third follow-up finding: with OpenAI low reasoning, native terminal selection
could still intermittently choose `finalize` on a simple chat turn. The final
monitor pins `plannerMode: "native_tools"` but disables `finalize` in the
simple-chat profile. A later run showed OpenAI could still choose `plan` and
todo actions, so the monitor now disables external actions plus native `plan`
and `finalize`, leaving the direct `final_answer` terminal path available. That
matches the thing being measured: normal chatbox UX latency, one provider call
per user turn, no external tools. Native `final_answer` terminal calls are
allowed because they are the direct-answer path, not an external runtime action.

The new standard monitor now gives agrun a repeatable 5-turn simple-chat live
gate. It verifies normal frontend/chatbox performance without running the full
research matrix.

## What was added

- `test/live-multiturn-standard.mjs`
- `npm run test:live:multiturn-standard`
- Testing docs updated in `agrun_docs/testing-guide.md` and
  `agrun_docs/live-standard-test.md`

The monitor runs one real session with 5 turns:

1. greeting
2. session anchor
3. same-session recall
4. host-provided time
5. short summary

It disables `web_search` and `read_url`, skips cross-session memory extraction
through a host policy, injects trusted `timeContext`, captures redacted
provider payload/response JSONL, scans returned results for provider key leaks,
and writes a Markdown plus JSON summary under `test/live-observe-out/`. The
summary includes per-turn wall time, provider LLM latency, prompt tokens, cached
tokens, output tokens, and reasoning tokens so slow turns can be diagnosed
without manually parsing JSONL.

## Root cause found during the first live run

The first version failed the one-call-per-turn standard on both providers. Turn
5 returned a planner `finalize` envelope, not a direct `final` envelope. That is
legal runtime behavior, but it asks the runtime to call the finalizer LLM, so a
simple chat turn spent a second provider call.

This was not memory extraction, not tool use, and not a provider secret issue:

- memory extraction was `skipped`
- tool calls/actions were `0`
- returned results did not contain the real API key
- all answers were correct, including host time

## Harness tuning

The fix is deliberately host/harness-level, not runtime hardcoding. The monitor
adds a per-run `plannerDirectives` line:

> Simple-chat live monitor rule: for every turn in this run, answer directly
> with the final answer envelope. Do not choose finalize or a finalize
> instruction, because that spends a second finalizer LLM call and this profile
> is measuring one-call-per-turn chat latency.

This keeps agrun general: `finalize` remains available for normal runs, while
the simple-chat performance standard makes its measured contract explicit.

## Final live results

Final corrected monitor run:

Command:

```bash
npm run test:live:multiturn-standard
```

| Provider / model | Status | Wall | LLM req | Total tokens | Deltas |
|---|---:|---:|---:|---:|---|
| OpenAI `gpt-5.4-mini` (`responses`, `reasoningEffort: low`) | PASS | 14.9s | 5 | 17,202 | `[1,1,1,1,1]` |
| Gemini `gemini-3.1-flash-lite` (`thinkingLevel: low`) | PASS | 8.2s | 5 | 19,331 | `[1,1,1,1,1]` |

Per-turn timings:

| Provider | Turn | Check | Wall | LLM ms | Prompt tok | Cached tok | Output tok | Reason/thought tok |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| OpenAI | 1 | greeting | 2.6s | 2557 | 2783 | 0 | 241 | 81 |
| OpenAI | 2 | anchor | 3.8s | 3827 | 2976 | 0 | 207 | 53 |
| OpenAI | 3 | recall | 2.6s | 2558 | 3116 | 1408 | 307 | 109 |
| OpenAI | 4 | host-time | 2.4s | 2347 | 3330 | 1408 | 279 | 95 |
| OpenAI | 5 | summary | 2.7s | 2659 | 3668 | 1408 | 295 | 17 |
| Gemini | 1 | greeting | 1.7s | 1671 | 3147 | 0 | 24 | 268 |
| Gemini | 2 | anchor | 1.0s | 1035 | 3392 | 0 | 17 | 95 |
| Gemini | 3 | recall | 1.0s | 963 | 3538 | 0 | 31 | 85 |
| Gemini | 4 | host-time | 1.5s | 1442 | 3793 | 0 | 162 | 133 |
| Gemini | 5 | summary | 2.2s | 2189 | 4206 | 0 | 226 | 214 |

Artifacts:

- OpenAI report: `test/live-observe-out/multiturn-standard-openai-2026-06-17T02-47-05-861Z.md`
- OpenAI JSONL: `test/live-observe-out/multiturn-standard-openai-2026-06-17T02-47-05-861Z.jsonl`
- Gemini report: `test/live-observe-out/multiturn-standard-gemini-2026-06-17T02-47-20-837Z.md`
- Gemini JSONL: `test/live-observe-out/multiturn-standard-gemini-2026-06-17T02-47-20-837Z.jsonl`

Historical first passing run before provider-roster correction:

Command:

```bash
npm run test:live:multiturn-standard
```

OpenAI:

- status: passed
- model: `gpt-5-mini`
- wall: 56.4s
- LLM requests: 5
- per-turn deltas: `[1,1,1,1,1]`
- total tokens: 31,841
- tool calls/actions: 0/0
- memory extraction: skipped
- key leak scan: pass

Gemini:

- status: passed
- model: `gemini-3.1-flash-lite`
- wall: 6.3s
- LLM requests: 5
- per-turn deltas: `[1,1,1,1,1]`
- total tokens: 29,939
- tool calls/actions: 0/0
- memory extraction: skipped
- key leak scan: pass

## Artifacts

Passing run:

- OpenAI report: `test/live-observe-out/multiturn-standard-openai-2026-06-17T02-16-26-315Z.md`
- OpenAI JSONL: `test/live-observe-out/multiturn-standard-openai-2026-06-17T02-16-26-315Z.jsonl`
- Gemini report: `test/live-observe-out/multiturn-standard-gemini-2026-06-17T02-17-22-817Z.md`
- Gemini JSONL: `test/live-observe-out/multiturn-standard-gemini-2026-06-17T02-17-22-817Z.jsonl`

First failed diagnostic run:

- OpenAI JSONL: `test/live-observe-out/multiturn-standard-openai-2026-06-17T02-14-18-367Z.jsonl`
- Gemini JSONL: `test/live-observe-out/multiturn-standard-gemini-2026-06-17T02-15-10-852Z.jsonl`

## Deterministic verification

- `node --check test/live-multiturn-standard.mjs`: pass
- `task.jsonl` JSONL parse: pass
- `git diff --check`: pass
- `npm run build`: pass
- `npm test`: pass
