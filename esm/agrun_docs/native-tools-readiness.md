# Native Tools Default-Readiness Matrix

Status: **Native mode is no longer the default.** Updated 2026-05-16.

Decision (2026-05-16): `plannerMode: "auto"` now resolves to `effectiveMode: "envelope"` for every provider/model/action surface. `envelope` is the canonical PASS path; `native_tools` remains available as an explicit advanced/debug opt-in via `createRuntime({ plannerMode: "native_tools" })`. The change was driven by repeated `gemini-3-pro-preview` provider-side instability during long-running real-API live tests on 2026-05-16 (PLANNER_ERROR timeouts and exit-144 signal kills under sustained native-tools requests), while the same prompts under envelope mode passed cleanly twice in a row on OpenAI `gpt-5-mini`. See `agrun_docs/live-tests/node-agrun-3000-double-baseline-2026-05-16.md` and ADR-0031 for the full evidence trail. The formal `native-readiness` live suite (when run) still exercises native paths via `plannerMode: "native_tools"`; the harness contract has not changed, only the auto default.

Earlier decision (2026-04-29): `plannerMode` defaulted to `"auto"` with `native_tools` as the resolver fallback. That decision is superseded by ADR-0031.

Native planner failures still default to `nativeToolsFailurePolicy: "fallback_to_envelope"` for compatibility when a host explicitly opts into native mode; hosts can opt into `"hard_fail"` when they want native-mode debugging to fail fast instead of retrying envelope mode.

## Current Capability

`native_tools` currently supports these planner decisions through provider tool calls:

- single action: any planner-visible action emitted as a provider tool, for example `web_search` or `list_agent_skills`
- clarify: `ask_clarification`
- final: `final_answer`
- finalize: `finalize`
- plan: `plan`, which maps to the existing envelope `type:"plan"` decision shape and then reuses `validatePlan()` / `executePlan()`

The native `plan` tool carries multiple action entries, `partial_ok`, `synthesize_instruction`, `synthesize_per_action`, `stitch`, and `result_budget`. Runtime validation still owns all action availability, policy, argsSchema, and preflight checks.

For `execute_skill_tool` entries, the native `plan` schema supports flatter provider shapes:

```json
{
  "name": "execute_skill_tool",
  "skillName": "reports",
  "toolName": "build_report",
  "toolArgs": { "label": "summary" }
}
```

The parser normalizes that into the existing canonical action args shape:

```json
{
  "skillName": "reports",
  "toolName": "build_report",
  "args": { "label": "summary" }
}
```

For Gemini compatibility, the parser also accepts:

```json
{
  "name": "execute_skill_tool",
  "skillName": "reports",
  "toolName": "build_report",
  "toolArgsJson": "{\"label\":\"summary\"}"
}
```

and flat tool-specific fields:

```json
{
  "name": "execute_skill_tool",
  "skillName": "reports",
  "toolName": "build_report",
  "arg_label": "summary"
}
```

or:

```json
{
  "name": "execute_skill_tool",
  "skillName": "reports",
  "toolName": "build_report",
  "label": "summary"
}
```

All accepted provider shapes normalize back to canonical `args`. This reduces the earlier `args.args` nesting pressure without creating a second executor or changing the runtime action contract.

Gemini tool schema projection also adds recursive `propertyOrdering` for every object schema. Required fields are ordered first, then remaining properties follow the registry/schema definition order. For `execute_skill_tool`, the emitted order is `skillName`, `toolName`, then `args`; for native `plan.actions[]`, the emitted order starts with `name`, `skillName`, `toolName`, `toolArgsJson`, and `toolArgs` before the legacy `args` fallback. This is a Gemini mitigation only; runtime validation remains the contract. The Gemini `toolArgsJson` requirement is tracked in `src/runtime/provider-capabilities.js`, so prompt guidance and provider tool schema descriptions read the same provider capability instead of hardcoding separate rules.

Native TodoState planning is also guarded by runtime preflight in native mode: `todo_plan` must include at least one item with a non-empty label before it mutates `runState.todoState`. Empty native plans now emit `action-args-invalid` and can enter the self-correction loop instead of silently creating an empty progress state.

When debug logging is enabled, native tool calls also emit a safe raw-args shape log. The log records tool names, object keys, primitive types, string lengths, array lengths, and sensitive-key counts. It does not record raw argument values, headers, `Authorization`, bearer tokens, API keys, cookies, passwords, or secrets.

## Auto Mode Matrix

`plannerMode: "auto"` is the default host contract. The host declares provider/model/tools; agrun chooses the effective planner encoding.

Current static rules (ADR-0031, 2026-05-16):

| Configured mode | Effective mode | Reason |
| --- | --- | --- |
| Omitted / `undefined` / unknown value / `"auto"` | `envelope` | `default_envelope` |
| Explicit `plannerMode: "envelope"` | `envelope` | `explicit` |
| Explicit `plannerMode: "native_tools"` | `native_tools` | `explicit` |

The previous provider/model/tool-surface heuristics (`gemini_lite_complex_native_plan_surface`, `provider_default_native_tools`) were removed because (i) repeated Gemini-side native instability on 2026-05-16 made native an unsafe default for any provider, and (ii) the harness signal stack works correctly under envelope mode for every provider/model that satisfied Success Criteria during live verification.

Debug snapshots, Inspector Summary, Debug Report, and Support Bundle should still show both configured mode (`auto` unless overridden) and effective mode (`envelope` by default, `native_tools` when explicitly opted in) so hosts can observe the runtime decision.

The terminal-envelope guard that previously kicked in for Gemini lite + envelope auto-resolution remains available; it now applies whenever the effective mode is `envelope` (which is the new default), so planner prompt examples omit `type:"finalize"` while TodoState has unfinished active/pending items, validation rejects stray `finalize` envelopes in that context, and envelope repair / strict retry reuses the same guard.

## Readiness Matrix

| Capability | Envelope | Native tools | Status | Notes |
| --- | --- | --- | --- | --- |
| Default planner mode | auto-selected | auto-selected | ready with caveat | Default is `auto`; agrun resolves the effective mode through `src/runtime/provider-capabilities.js`. Explicit `native_tools` / `envelope` remain advanced/debug overrides. |
| OpenAI direct final | yes | yes | ready | `final_answer` native tool parses into `type:"final"`. |
| OpenAI clarify | yes | yes | ready | `ask_clarification` native tool parses into `type:"clarify"`. |
| OpenAI single action | yes | yes | ready | Native action tool calls execute through the same action loop. |
| OpenAI finalize | yes | yes | ready | `finalize` native tool maps to the finalizer path. |
| Gemini direct final | yes | yes | ready with risk | Focused live checklist passed; keep provider risk because Gemini native behavior is less stable on complex schemas. |
| Gemini clarify/action/finalize | yes | partial | ready with caveat | Broad native-readiness live suite passed Gemini action, clarify, and finalize. Runtime finalizer now retries once on empty provider text/tool output and emits `runtime-finalize-empty-response-retry` before returning a recovered final answer. |
| `type:"plan"` multi-action envelope | yes | partial | `toolArgsJson` required for Gemini | Native `plan` exists and OpenAI live two-action plan passed. Flat `skillName` / `toolName` / `toolArgs`, `toolArgsJson`, `arg_*`, direct flat-field normalization, and Gemini `propertyOrdering` are supported. Gemini still emits empty nested `toolArgs`, but live `toolArgsJson` executed the two-action native plan successfully in client and server-auth modes. Non-forced Gemini live also selected native `plan` after reading the skill and executed both actions through `toolArgsJson`. `arg_*` recovered through self-correction; direct flat fields failed live. |
| Approval policy | yes | partial | ready with caveat | Native actions enter the same policy path; live approval loop completed after multiple approvals. |
| Invalid args and self-correction | yes | partial | ready with caveat | Runtime-side `argsSchema` validation still runs after native parsing, including plan-indexed `action-args-invalid`. Gemini plan bundled-tool args remain a provider-risk case. |
| Repair/fallback | yes | partial | ready with caveat | Native provider/tool failures default to `nativeToolsFailurePolicy: "fallback_to_envelope"`, emit `planner-native-tools-fallback`, and retry envelope mode, except `CIRCUIT_OPEN`. `nativeToolsFailurePolicy: "hard_fail"` emits `planner-native-tools-failed` and returns the planner/provider error without envelope retry. |
| TodoState actions | yes | partial | ready with caveat | Native `todo_plan` now rejects empty item plans before mutation. Formal native-readiness live coverage passes OpenAI/Gemini TodoState; OpenAI created the target plan directly and Gemini exercised plan advancement. |
| Browser client-auth | yes | yes | ready | OpenAI/Gemini browser providers can receive native tool declarations. |
| Server-auth proxy | yes | partial | N/A until host proxy exists | OpenAI native final and Gemini native two-action `toolArgsJson` plan passed through local server-auth proxies with provider auth headers stripped from browser-to-proxy requests. There is no real host proxy in the current project, so real deployment proxy testing is deferred and is not a current readiness blocker. |
| Native schema from `argsSchema` | yes | yes | ready | OpenAI and Gemini tool schemas now use planner `argsSchema` before falling back to `argsExample`; Gemini schemas add recursive `propertyOrdering`. |

## Default-Switch Guardrails

1. Keep Gemini native `plan` marked `toolArgsJson`-required; do not rely on nested `toolArgs`, `arg_*`, or direct flat fields for Gemini default readiness.
2. Keep `nativeToolsFailurePolicy: "fallback_to_envelope"` as the compatibility default; use `"hard_fail"` only for host/debug surfaces that require native-mode fail-fast behavior.
3. Keep the runtime-finalizer empty-response retry covered by concern and live tests; do not treat it as provider fallback.
4. Keep envelope mode covered as the explicit override and fallback path.
5. If a production host proxy is added later, run the same native_tools matrix through that endpoint.
6. Keep `plannerMode: "auto"` rules deterministic and static unless a future ADR explicitly accepts adaptive/session-level mode memory.

## Tests Added

- `test/unit/planner-tools-decision.test.js`
  - parses `final_answer`
  - parses `finalize`
  - parses `ask_clarification`
  - parses a normal action tool call
- `test/unit/planner-tools-schema.test.js`
  - confirms OpenAI/Gemini native schemas prefer `argsSchema`
- `test/concerns/native-tools.test.js`
  - mocked OpenAI native `final_answer`
  - mocked OpenAI native `ask_clarification`
  - mocked OpenAI native single action
  - mocked OpenAI native `plan` executing through the existing plan harness
  - mocked OpenAI native failure falling back to envelope by default
  - mocked OpenAI native failure hard-failing when `nativeToolsFailurePolicy: "hard_fail"` is configured

## Conclusion

`native_tools` is the default mode with caveats. The earlier structural `type:"plan"` gap is now partially closed by the native `plan` tool and flat bundled-tool args normalization. Gemini native `plan` is viable only through the `toolArgsJson` compatibility shape today. Native TodoState no longer accepts empty plans in native mode and is covered by the formal native-readiness suite. Envelope mode remains an explicit opt-out and fallback path. Native failure policy is explicit: compatibility defaults to envelope fallback, with `hard_fail` available for native-mode debugging.

2026-04-29 broad native-readiness update: the formal `native-readiness` live suite passed OpenAI/Gemini native action, clarify, finalize, approval, search, and TodoState: `executed=12 skipped=0`. Gemini native finalize is covered by a runtime-finalizer empty-response retry, which retries once with a non-empty final-answer instruction when the provider returns no text/tool output.
