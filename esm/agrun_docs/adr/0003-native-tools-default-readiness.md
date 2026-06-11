# ADR-0003: Auto Planner Mode with Native Tools as Preferred Encoding

Status: Amended, 2026-04-29.

## Context

agrun.js supports two planner modes:

- `native_tools`: the default provider-native tool/function calling path for single actions, terminal planner decisions, and the native `plan` tool
- `envelope`: JSON envelope parser with repair and `type:"plan"` support, retained as an explicit opt-out

AGRUN-213e evaluated whether `plannerMode: "native_tools"` can become the future default. AGRUN-213j made the native-readiness gate pass 12/12 with `.env.local`. Globe3 production feedback later showed that exposing `plannerMode` as a normal host knob leaks provider encoding details into host code. Hosts know their provider/model/tool intent; agrun owns the provider compatibility matrix.

## Decision

Switch the default to `plannerMode: "auto"`. In auto mode, agrun resolves the effective planner mode through `src/runtime/provider-capabilities.js`.

Initial static resolver:

- Gemini lite model + complex native plan surface, including `execute_skill_tool` -> `envelope`
- Explicit `plannerMode: "envelope"` -> `envelope`
- Explicit `plannerMode: "native_tools"` -> `native_tools`
- Other supported provider/model surfaces -> `native_tools`

`nativeToolsFailurePolicy` remains `"fallback_to_envelope"` by default when the effective mode is `native_tools`.

## Reasons

- `native_tools` supports single action, `ask_clarification`, `finalize`, `final_answer`, and a native `plan` tool.
- The native `plan` tool reuses the existing plan validation/execution harness rather than introducing a second plan executor.
- OpenAI live two-action native plan passed, including the flatter `skillName` / `toolName` / `toolArgs` shape for `execute_skill_tool`.
- Gemini still omits required bundled-tool args such as `label` in complex native plan calls, even after the flatter schema reduced `args.args` nesting.
- Gemini schemas now include recursive `propertyOrdering` and native tool-call debug records safe raw args shape only. Live recheck proved `propertyOrdering` alone is diagnostic/mitigation, not a fix: Gemini still emitted empty `toolArgs` for native plan bundled-tool actions. A follow-up `toolArgsJson` compatibility shape passed live for OpenAI and Gemini.
- The later strict `native-readiness` gate passed OpenAI/Gemini native action, clarify, finalize, approval, search, and TodoState after adding a one-shot runtime-finalizer empty-response retry for Gemini native finalize.
- Server-auth proxy native tools passed local forwarding-proxy sanitation. Real host proxy live verification is N/A until the host project adds such an endpoint; it is not a blocker for the current opt-in support level.
- Envelope mode remains the compatibility opt-out and fallback path for native planner/provider failures.

## Consequences

- Hosts get `plannerMode: "auto"` by default.
- Hosts can still force `plannerMode: "native_tools"` or `plannerMode: "envelope"` as advanced/debug overrides.
- Runtime debug surfaces expose configured mode, effective mode, and resolver reason.
- Gemini native plan stays on the `toolArgsJson` compatibility path for bundled-tool payloads.
- Native failure/fallback policy remains compatibility-first: `"fallback_to_envelope"` by default and `"hard_fail"` by opt-in.
- If a real host proxy is added later, it should run the same native_tools matrix through that endpoint before being treated as production-covered.
- Future readiness work should use the matrix in `agrun_docs/native-tools-readiness.md` as the default-decision harness.
