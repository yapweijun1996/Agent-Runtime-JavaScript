# Browser Multi-turn E2E Live Check - 2026-04-29

## Scope

This live check verifies the browser example after `plannerMode` changed to default `native_tools` and after browser QA hardening added `qa_clean=y`.

It covers:

- OpenAI and Gemini provider settings loaded from `.env.local`.
- Browser runtime startup through the real browser example, not direct Node runtime calls.
- Multi-turn chat continuity with persisted session context.
- Native-tools debug summaries exposed through the browser runtime debug path.
- Provider/action failure hygiene: no `provider-error`, no `action-args-invalid`, and no secret leakage in persisted debug summaries.

## Command

```bash
npm --prefix examples/browser run test:live:browser-multiturn -- --provider all
```

The script starts the browser example through Vite, launches headless Chrome over CDP, opens the app with `debug_yn=y`, `qa=<scenario>`, and `qa_clean=y`, then runs isolated provider scenarios while preserving configured provider settings.

## Result

Status: pass.

Gemini passed a 3-turn continuity scenario:

- Turn 1 started a fresh session and returned `BROWSER_LIVE_GEMINI_TURN1_OK`.
- Turn 2 reused the same session and recalled `BLUE-ORCHID-729`.
- Turn 3 reused the same session, exercised native action/final coverage, executed `list_agent_skills`, and returned `BROWSER_LIVE_GEMINI_TURN3_OK`.

OpenAI passed a 2-turn continuity scenario:

- Turn 1 started a fresh session and returned `BROWSER_LIVE_OPENAI_TURN1_OK`.
- Turn 2 reused the same session and recalled `RED-MAPLE-431`.

The run confirmed:

- `runtimeConfig.plannerMode === "native_tools"`.
- Provider debug summaries use the expected provider names.
- At least one native tool call is observed per provider scenario.
- No persisted debug summary contains provider secrets, API keys, or authorization headers.
- No `provider-error` or `action-args-invalid` step is present in the successful scenarios.

## Non-blocking Environment Noise

Chrome emitted GoogleUpdater, Crashpad, and GCM stderr messages during headless execution. These did not affect the app, provider calls, or E2E assertions. The command exited with status 0.

## Release Usage

Use this check when browser example changes affect provider settings, planner mode, chat/session storage, Inspector/debug output, or multi-turn behavior. If `.env.local` does not contain real OpenAI/Gemini keys, record the live check as skipped rather than passed.
