# ADR-0031: Envelope is the default planner mode

Date: 2026-05-16
Status: Accepted
Supersedes: ADR-0003 (native_tools default readiness)

## Context

- ADR-0003 (2026-04-29) made native_tools the default effective planner mode through `resolvePlannerMode()` in `src/runtime/provider-capabilities.js`, with envelope reserved for compatibility cases (notably Gemini lite + complex native plan surfaces).
- During the 2026-05-16 Node real-API live verification of the canonical 3000-word "What is Harness Engineering" research scenario, sustained native-tools requests against `gemini-3-pro-preview` produced repeated provider-side failures: PLANNER_ERROR timeouts mid-run, and exit-144 signal kills with no harness artifact. The same fixture under `plannerMode: "envelope"` on OpenAI `gpt-5-mini` produced two consecutive PASS runs (3112 and 3123 words, decision=ready, all Success Criteria satisfied). The pro-model envelope run also passed cleanly when the endpoint was responsive (3243 words, 20 steps total).
- The user has asked that envelope be made the default so production hosts do not hit the same Gemini native instability we observed today. The instruction was explicit: "we dont want to use native anymore, default use the envelope ... no need to spend more time in native, see future can resolve or not then we try again."
- Affected modules and docs: `src/runtime/provider-capabilities.js`, `test/unit/provider-capabilities.test.js`, `test/node-agrun-3000-live.mjs`, `agrun_docs/native-tools-readiness.md`, `agrun_docs/planner-architecture.md`, `agrun_docs/public-runtime-api.md`, `agrun_docs/learnings-from-sample-projects.md`, `agrun_docs/README.md`, and the live-test report `agrun_docs/live-tests/node-agrun-3000-double-baseline-2026-05-16.md`.

## Decision

- `plannerMode: "auto"` and any omitted / unknown configuredMode resolve to `effectiveMode: "envelope"` with `reason: "default_envelope"`. The resolver no longer inspects provider, model, or action surfaces for the auto path.
- `plannerMode: "envelope"` and `plannerMode: "native_tools"` are still honored explicitly with `reason: "explicit"`.
- Envelope is the canonical PASS path for all production scenarios.
- Native tools remains a supported advanced/debug opt-in. `nativeToolsFailurePolicy` retains its current meaning: it only applies when the effective mode is `native_tools`.
- The Node live fixture `test/node-agrun-3000-live.mjs` default is also envelope so the canonical scenario runs the canonical PASS path out of the box; `NODE_AGRUN_LIVE_PLANNER_MODE=native_tools` still overrides for diagnostic purposes.
- Removed helpers (`hasComplexNativePlanSurface`, `hasNestedObjectSchema`, `isGeminiLiteModel`, `readModelId`) and unused parameters (`actions`, `model`, `provider`) from `resolvePlannerMode()`. `getPlannerProviderCapabilities()` and its provider-specific native-plan capabilities are kept because they are still consumed when a host explicitly opts into native_tools.

## Alternatives

1. Keep native_tools as the default and rely on `nativeToolsFailurePolicy: "fallback_to_envelope"` to recover. Rejected: today's failures are infrastructure-side (timeouts, signal kills with no harness artifact), which fallback cannot rescue; the host still pays the timeout cost and observes a degraded run.
2. Keep the auto-resolver but add a "default to envelope on provider=gemini" rule. Rejected: brittle and provider-specific, violates the no-patch-logic spirit, and does not benefit from envelope's verified PASS path on OpenAI.
3. Leave the runtime default alone and only change the fixture. Rejected: hides the real production risk; downstream hosts that consume `dist/agrun.js` would still default to native and hit the same gemini-side outage.

## Consequences

- Pros:
  - Production hosts get the live-verified PASS path by default. The harness signal stack works under envelope mode without runtime patches.
  - Removes a 50-line provider-specific resolver branch that only existed to route Gemini lite away from a broken native surface. Less code to maintain.
  - Aligns with the live evidence collected on 2026-05-16: envelope passes on both OpenAI and Gemini pro (when the pro endpoint is responsive); native is unreliable on Gemini today.
- Cons:
  - Hosts that previously enjoyed native tools' richer structured-tool semantics on OpenAI must opt in explicitly (`plannerMode: "native_tools"`).
  - Default coverage moves away from native tool calling, so any future Gemini native fix will need a fresh live run to revisit the trade.
- Risks:
  - If a future scenario only passes under native tools (none observed today), hosts must remember to flip the mode. Mitigation: the resolver reason `default_envelope` is exposed in debug snapshots so hosts can confirm what they got.

## Rollback

- Restore the previous `resolvePlannerMode()` body (the gemini-lite envelope branch + native-tools fallback) and helpers, restore the previous unit-test assertions, and flip the fixture default back to `"native_tools"`. Update `agrun_docs/native-tools-readiness.md`, `agrun_docs/planner-architecture.md`, `agrun_docs/public-runtime-api.md`, and `agrun_docs/README.md` to drop the ADR-0031 references. The previous behavior is fully described in ADR-0003.
