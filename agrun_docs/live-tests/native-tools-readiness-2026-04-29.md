# Native Tools Readiness Live Checklist

Date: 2026-04-29.

Scope: live provider checklist for deciding whether `plannerMode: "native_tools"` can become the default in a future slice.

This file records the live test plan and the 2026-04-29 provider run. AGRUN-213e does not switch the default planner mode.

## Local Verification

Run without provider credentials:

```bash
node test/unit/planner-tools-schema.test.js
node test/unit/planner-tools-decision.test.js
npm run build
node test/concerns/native-tools.test.js
npm run check
```

## Optional Live Provider Commands

Run only when `.env.local` has provider keys configured:

```bash
npm run test:live:planner
npm run test:live:openai
npm run test:live:gemini
```

## Checklist

| Case | Provider | Expected |
| --- | --- | --- |
| direct final via `final_answer` | OpenAI | completes without envelope fallback |
| single action tool call | OpenAI | action executes and final answer completes |
| clarify via `ask_clarification` | OpenAI | returns clarification output |
| finalize via `finalize` | OpenAI | finalizer runs after evidence |
| direct final via `final_answer` | Gemini | completes without schema/tool-call error |
| single action tool call | Gemini | action executes and final answer completes |
| clarify via `ask_clarification` | Gemini | returns clarification output |
| finalize via `finalize` | Gemini | finalizer runs after evidence |
| server-auth proxy native tools | OpenAI/Gemini | proxy receives safe provider request and does not leak auth headers |
| `type:"plan"` parity | OpenAI/Gemini | native `plan` should parse and enter the existing plan harness |

## Result

Executed with local `.env.local` provider credentials on 2026-04-29.

### Existing Live Suite

Command:

```bash
npm run test:live:planner
```

Observed:

| Case | Result | Notes |
| --- | --- | --- |
| `openai-envelope-mode` | pass | baseline envelope path |
| `openai-native-tools-mode` | pass | native direct final completed |
| `gemini-native-tools-mode` | pass | native direct final completed |
| `direct-answer-no-search` | pass | envelope regression |
| `openai-native-tools-search` | pass with note | completed, but model answered directly without `web_search` |
| `gemini-native-tools-search` | pass with note | after adding a native planner instruction against one-step TodoState planning, the suite completed; model may still answer directly without `web_search` |

### Strict Native Tools Checklist

Command: one-off Node live harness using `dist/agrun.js`, `plannerMode: "native_tools"`, and the same `.env.local` provider models. The harness forced each provider through one native planner response type and verified `planner-native-tool-call.detail.responseType`.

| Provider | Native case | Result | Evidence |
| --- | --- | --- | --- |
| OpenAI | `final_answer` | pass | `responseType: "final"`, output `NATIVE_FINAL_OK` |
| OpenAI | `ask_clarification` | pass | `responseType: "clarify"`, output `WHICH_WORKSPACE?` |
| OpenAI | normal action | pass | `responseType: "action"`, executed `list_agent_skills`, output `NATIVE_ACTION_OK` |
| OpenAI | `finalize` | pass | `responseType: "finalize"`, output `NATIVE_FINALIZE_OK` |
| Gemini | `final_answer` | pass | `responseType: "final"`, output `NATIVE_FINAL_OK` |
| Gemini | `ask_clarification` | pass | `responseType: "clarify"`, output `WHICH_WORKSPACE?` |
| Gemini | normal action | pass | `responseType: "action"`, executed `list_agent_skills`, output `NATIVE_ACTION_OK` |
| Gemini | `finalize` | pass | `responseType: "finalize"`, output `NATIVE_FINALIZE_OK` |

Investigation note: an earlier forced Gemini `finalize` prompt failed because the test `systemPrompt` told both the planner and the later finalizer request to choose a function. Gemini then produced `MALFORMED_FUNCTION_CALL` during the non-tool finalizer call. The harness was corrected to scope tool-choice instructions to planner requests and plain-text instructions to finalizer requests; the corrected run passed for both OpenAI and Gemini.

### Follow-up Matrix

After adding native `plan` and a native planner instruction to avoid `todo_plan` for simple one-step lookup/search requests:

| Provider | Case | Result | Evidence |
| --- | --- | --- | --- |
| OpenAI | native two-action `plan` | pass | `responseType: "plan"`, `plan-executing.actionCount: 2`, two `execute_skill_tool` actions, output `NATIVE_PLAN_OK` |
| Gemini | native two-action `plan` | provider risk | Gemini selected `plan`, but repeatedly omitted nested `execute_skill_tool.args`, causing plan-indexed `action-args-invalid` |
| OpenAI | native two-action flat `plan` | pass | After adding flat `skillName` / `toolName` / `toolArgs` support for `execute_skill_tool`, OpenAI again executed both planned actions and returned `NATIVE_PLAN_OK`. |
| Gemini | native two-action flat `plan` | provider risk | After the flat schema change, Gemini still selected `plan` repeatedly but omitted the required bundled-tool `label`; the runtime returned plan-indexed `action-args-invalid` and no action executed. |
| OpenAI | recursive `propertyOrdering` flat native `plan` | pass | Recheck after recursive `propertyOrdering`: selected `plan`, executed two `execute_skill_tool` actions, no `action-args-invalid`. Final text included `NATIVE_PLAN_OK` plus explanatory/tool-call text. Safe debug shape showed `toolArgs.keys: ["label"]`. |
| Gemini | recursive `propertyOrdering` flat native `plan` | provider risk confirmed | Recheck after recursive `propertyOrdering`: selected `plan` five times, but every safe debug shape showed `toolArgs.keys: []`; no action executed and each attempt emitted `Bundled tool "plan_part" requires argument "label".` |
| OpenAI | native `plan` with `toolArgsJson` | pass | Selected `plan`, executed two `execute_skill_tool` actions, no `action-args-invalid`, final text exactly `NATIVE_PLAN_OK`. Safe debug shape showed `toolArgsJson` string length 17. |
| Gemini | native `plan` with `toolArgsJson` | pass | Selected `plan`, executed two `execute_skill_tool` actions, no `action-args-invalid`, final text exactly `NATIVE_PLAN_OK`. Safe debug shape showed `toolArgsJson` string length 17, proving stringified tool args bypass the empty nested `toolArgs` issue. |
| Gemini | non-forced native `plan` | pass with caveat | On a normal two-part skill task, Gemini first called `read_agent_skill`, then selected native `plan`, executed two `execute_skill_tool` actions for `alpha` and `beta`, and produced `NATIVE_PLAN_OK` with no `action-args-invalid`. This validates the planner prompt can steer Gemini toward `toolArgsJson` without the user prompt naming that field. |
| Gemini | native `plan` with `arg_label` | pass with repair | First native plan emitted empty `args` and failed validation; second native plan self-corrected to `toolArgsJson`, executed two actions, and finalized `NATIVE_PLAN_OK`. Treat `arg_*` as accepted input, not preferred Gemini output. |
| Gemini | native `plan` with direct flat `label` | fail | Gemini repeatedly emitted empty `args`; no actions executed. Direct flat fields remain parser-compatible but not Gemini-live-stable. |
| OpenAI | server-auth native final via local proxy | pass | Local proxy held the API key; browser request used `authMode:"server"` + endpoint. Proxy observed no inbound `Authorization`; native `final_answer` completed with `SERVER_AUTH_NATIVE_OK`. |
| Gemini | server-auth native two-action `plan` via local proxy | pass | Local proxy held the API key; browser request used `authMode:"server"` + endpoint. Proxy observed no inbound `Authorization` and no `x-goog-api-key`; native `toolArgsJson` plan executed two actions and finalized `NATIVE_PLAN_OK`. |
| OpenAI | native approval loop | pass with caveat | approval/resume completed after two approvals (`web_search`, then `read_url`) |
| Gemini | native approval loop | pass with caveat | approval/resume completed after two approvals (`web_search`, then `read_url`) |
| OpenAI | native TodoState before preflight hardening | fail for default readiness | Native calls reached `todo_plan`, but the live run produced empty TodoState items and self-corrected/finalized with an empty plan. This triggered the native TodoState preflight hardening. |
| Gemini | native TodoState before preflight hardening | fail for default readiness | Native calls reached `todo_plan`, but the live run produced empty TodoState items; the stricter run failed after repeated empty plans. This triggered the native TodoState preflight hardening. |
| OpenAI | native TodoState after preflight hardening | pass with caveat | Native `todo_plan` created two labeled items, `todo_run_next` completed the first item, and final output was `TODO_NATIVE_OK`. No empty TodoState mutation occurred. |
| Gemini | native TodoState after preflight hardening | pass with caveat | Native `todo_plan` created two labeled items, `todo_run_next` completed both items, and final output was `TODO_NATIVE_OK`. No empty TodoState mutation occurred. |
| OpenAI/Gemini | server-auth native tools | pass / N/A for real host | OpenAI native final and Gemini `toolArgsJson` native plan passed through local forwarding proxies. Browser-to-proxy requests did not include provider auth headers, and native tool declarations were present on planner requests. There is no real host provider proxy endpoint in this project, so real deployment coverage is deferred and not a current blocker. |
| OpenAI/Gemini | approval live suite | pass | `npm run test:live:approval` printed PASS for OpenAI approve/deny, Gemini approve/deny, and OpenAI chained approvals, then exited cleanly after timeout cleanup. |
| OpenAI/Gemini/Search providers | search live suite | pass with note | `npm run test:live:search` printed PASS for 7/7 cases and exited cleanly. OpenAI/Gemini search-then-finalize may answer directly without `web_search`, which remains acceptable for this smoke. |
| OpenAI/Gemini | formal native TodoState planner suite | pass | `npm run test:live:planner` now includes `openai-native-tools-todo` and `gemini-native-tools-todo`. Both created non-empty structured TodoState through native tools. OpenAI created the target plan directly; Gemini also exercised plan advancement. The suite printed PASS for 8/8 planner cases and exited cleanly after timeout cleanup. |
| OpenAI/Gemini | native hard-fail policy smoke | pass | With `plannerMode: "native_tools"` and `nativeToolsFailurePolicy: "hard_fail"`, intentionally invalid model names produced `runState.status: "failed"` and `error.code: "PLANNER_ERROR"` for both providers. Both emitted `planner-native-tools-failed` and `provider-error`; neither emitted `planner-native-tools-fallback`. Only scrubbed provider/status/reason fields were logged. |
| OpenAI/Gemini | broad native-readiness live suite | pass with caveat | Added `npm run test:live -- --suite native-readiness` as a strict default-readiness gate. After adding the runtime-finalizer empty-response retry, the suite passed OpenAI/Gemini native action, clarify, finalize, approval, search, and TodoState: `executed=12 skipped=0`. Gemini native finalize is still a provider-risk path, but empty text/tool output now retries once and emits `runtime-finalize-empty-response-retry`. |

Conclusion: OpenAI and Gemini pass the focused native final/action/clarify/finalize checklist and the broader `native-readiness` gate. Native `plan` plus flat bundled-tool args normalization closes the structural tool-surface gap for OpenAI and mocked tests. Recursive Gemini `propertyOrdering` did not fix Gemini nested `toolArgs`: safe debug proved Gemini emitted empty `toolArgs` objects. The `toolArgsJson` compatibility shape passed live for OpenAI and Gemini, including Gemini local server-auth proxy and a non-forced Gemini skill-plan prompt. `arg_*` can recover through self-correction but is not preferred; direct flat fields are not Gemini-live-stable. Native TodoState now rejects empty plans before mutation and is covered by the formal live suite. Real host proxy coverage is N/A until a host proxy exists. `native_tools` is the default with caveats; envelope mode remains an explicit opt-out and compatibility fallback.
