# Changelog

All notable changes to `agrun.js` are aggregated here. Per-release details live in [`agrun_docs/release-notes-*.md`](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/); this file is the entry point.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project uses single-number semantic versions (`MAJOR.MINOR.PATCH`).

---

## [Unreleased]

Active work on `main` that has not shipped to a version tag.

### Added
- **`remember` action — model-initiated durable memory (AGRUN-613).** New
  tier-0 built-in action: the model itself stores a durable user preference,
  fact, or decision (`{kind, slot, text}`, last-wins per slot) the moment the
  user states one — no extra LLM call, no keyword matching, works even when
  the host disables per-turn extraction (`memoryExtractionPolicy`). Entries
  use the extractor's shape, so evidence classification, Confirmed
  Preferences prompt injection, working-memory projection, and global-memory
  promotion all apply unchanged. New `memoryDirectives` prompt section
  (host-overridable) plus native-door lines teach the model to honor
  Confirmed Preferences as standing instructions and when to call `remember`.

### Fixed
- **Preference entries no longer vanish behind thread scoping (AGRUN-613).**
  `filterMemoryEntriesByThread` treats `kind: "preference"` entries as
  session-scoped — the user is the same person on every topic thread, so
  "always reply in Mandarin" survives the router opening a new thread.
  Facts/decisions stay thread-scoped (cross-thread recall remains their
  escape hatch). The session layer also stamps missing thread/turn
  provenance onto model-initiated memory entries before persisting them.

- **Free-form clarification replies now promote the topic (AGRUN-614).** A
  typo'd or near-match reply to a clarification question (e.g. "tno systen
  pte ltd" answering "Do you mean TNO System Pte Ltd?") fell through every
  exact-match branch to the AGRUN-595 catch-all, which unconditionally kept
  the stale prior topic. It now promotes the reply itself when the reply is
  topic-shaped (short, non-question), matching the structural check
  `topic_refinement`/breakout already use, and only preserves the stale topic
  for sentence/instruction-shaped replies.

- **The graceful "deny" policy path works again on both dispatch doors (AGRUN-615).**
  AGRUN-588 correctly stopped OFFERING policy-denied actions to the planner,
  but its own decision-validator (`normalizeActionName`, shared by the
  single-action and plan-array doors) only recognized action names that were
  still in that filtered list — so a policy-denied name a model still emits
  (envelope mode has no structural tool-schema constraint against this) was
  misclassified `unknown_action_name` and burned a repair cycle instead of
  reaching the execution-side `handlePolicyDenied` safety net AGRUN-588's own
  comment promised. The plan-batch re-validator had the same bug from another
  angle: a generic "hidden by the runtime action surface" rejection ran
  before the dedicated `action_policy_denied_in_plan` feedback ever got a
  chance to fire, leaving that AGRUN-562 code path unreachable. Both doors
  now recognize a policy-denied name as real (just forbidden) and route it to
  the correct graceful-denial contract.

- **A brand-new session now inherits promoted global memory (AGRUN-616).**
  `promoteToGlobalMemory` always wrote confirmed preferences/facts/decisions
  to the cross-session store correctly, and `handle.js` read them back
  correctly — but only into `resolvedMemory`, the facade used by in-loop
  memory tools, never into the actual prompt. The prompt's "Confirmed
  Preferences" block is built by `compaction.js`'s
  `prepareProviderSessionContext`, which read only session-scoped memory —
  so a preference promoted from one session (e.g. "always reply in
  Mandarin") was durably stored yet invisible to a brand-new session's own
  prompt. `prepareProviderSessionContext` now accepts the caller's already-
  fetched global memory and merges it in via the same
  `mergeGlobalIntoSessionMemory` rule `resolvedMemory` already uses (no new
  merge policy invented). `handle.js` reads global memory once and reuses it
  for both consumers; the approval-resume door was wired too (two-door
  parity, AGRUN-474 precedent). Live-verified across openai/gemini/deepseek:
  a preference remembered in session A reaches session B's outbound request
  body (fetch-intercepted) and session B replies in the requested language.

`npm run check` is fully green again (verified twice); `main` had been
carrying the research-flows.test.js failure above and the AGRUN-614
topic-promotion failure since earlier the same day.

## [4.1.0] — 2026-07-03 (production-ready hardening)

The 2026-07-02 → 07-03 arc: native-tools default planner (ADR-0058), 2-5×
faster turns at half the LLM calls, first-token streaming, and a day of
live-e2e-driven fixes. Details:
[`agrun_docs/release-notes/2026-07-02-performance-arc-native-default.md`](./agrun_docs/release-notes/2026-07-02-performance-arc-native-default.md),
task board AGRUN-568…AGRUN-598.

### Added
- **Standard live e2e suite** ([`agrun_docs/standard-live-e2e.md`](./agrun_docs/standard-live-e2e.md)):
  short-150 / long-1500 / deep-research-1200 / 8-turn conversation (with a
  real web_search news turn) × 3 providers, plus agrun-vs-OpenAI-Agents-SDK
  single-turn and multi-turn benchmarks. Tuned agrun beats the SDK on the
  same 7-turn conversation (20.9 s vs 32.9 s).
- **Production deployment guide** ([`agrun_docs/production-deployment.md`](./agrun_docs/production-deployment.md)):
  key-security shapes, the 5.6× production chat profile, pause semantics.
- `createRuntime({ actionHistoryLimit })` — opt-in heap cap (D2).
- Cross-thread recall verdict: memory questions get the whole-session view
  while topic threads stay scoped (AGRUN-593).

### Fixed
- Session silently forgot anything older than 3 exchanges (AGRUN-586).
- Guaranteed-rejection cycles: standalone-only actions in native parallel
  batches; policy-denied tools on the model surface (AGRUN-588).
- Clarification loop: a reply to a pending clarification now resolves it;
  web_search no longer trusts model-guessed provider names (AGRUN-595).
- Proportionality: headline-style asks answer from search results directly
  instead of paying a read-every-cited-page tax (AGRUN-597).
- gemini streaming tool-call double-extraction blanked tool names (AGRUN-585).

### Hardening
- web-search endpoints must be http(s) and parse (D4); ESM entry verified
  with `dist/esm/package.json` type marker (D3); default model ids verified
  live (D5).

### Security
- **AGRUN-523 — provider `apiKey` no longer leaks on approval turns.** A
  blocked / `approval_required` result previously embedded the host provider
  `apiKey` verbatim in the resume token, riding back on
  `result.output.pendingApproval.resumeToken.request.apiKey` **and**
  `result.runState.pendingApproval.resumeToken.request.apiKey` (universal, any
  provider). Every secret-keyed field is now redacted from the resume token
  before it is signed, so the whole result is secret-free while `sign → verify`
  still validates on resume.

### Breaking
- **Approval resume now REQUIRES client-auth hosts to re-supply `apiKey`.**
  Because the resume token no longer carries the provider key, a client-auth
  `approval_resolution` must pass `apiKey` (and any `fetch`/endpoints) back in:
  `runtime.run({ type:"approval_resolution", decision:"approve", apiKey, resumeToken })`.
  The runtime no longer falls back to a key embedded in the token. Server-auth
  (`authMode:"server"`) resumes are unaffected (they never carried a client
  key). The reference browser host already re-supplies its key on every approve.
  See [`agrun_docs/approval-flow.md`](./agrun_docs/approval-flow.md#resume-token).

## [1.0.0] — 2026-05-27 (AGRUN-274 final — ADR-0040)

Major version bump. The legacy `canHandle` skill-loop router and its 6
deprecated Set A skill exports are removed. agrun is now action-loop-only:
`runtime.run()` requires a tool-loop provider request (`{prompt, provider,
apiKey, model, …}`) or an approval resolution; any other input returns an
`INVALID_RUN_INPUT` failed result.

### Breaking
- **`runtime.run("string")` no longer routes** through a `canHandle()`
  skill router. Returns `INVALID_RUN_INPUT`. Migrate to a tool-loop
  provider request, or register a `customAction` via `defineAction`.
- **`{type:"web_search",…}` (or any typed object without
  `prompt + provider + apiKey + model`)** is similarly rejected. Use
  the action-loop's built-in `web_search` action via a planner-driven
  tool-loop input.
- **6 Set A skill exports removed** from `src/index.js`: `echoSkill`,
  `fallbackSkill`, `memorySkill`, `newsBriefSkill`, `timeSkill`,
  `webSearchSkill`. `geminiBrowserSkill` and `openaiBrowserSkill` are
  retained (they are provider-adapter wrappers, not Set A skills per
  ADR-0040 §"Disposition per Set A skill").
- **`legacySkillLoop` createRuntime option removed**. The 1-minor
  deprecation window through AGRUN-274d-1/2/3 has closed. Hosts that
  still pass `legacySkillLoop:"silent"` see the option silently
  ignored; `runtime.run("string")` now always rejects.
- **`fallbackSkill` createRuntime option removed**. Skills marked
  `isFallback:true` in the `skills:` array are no longer treated
  specially.
- **`skills:` createRuntime option is now backwards-compat only**. The
  skill-loop router that consumed it is deleted; the array is still
  validated for shape (each entry must be an object with non-empty
  `name`) but its `canHandle` / `orient` / `evaluate` / `execute` are
  never invoked. The array may be empty or omitted.

### Added
- New `ERROR_CODES.INVALID_RUN_INPUT` for the rejection path; new
  `invalid-run-input` step type emitted alongside the failed result.

### Removed
- `src/runtime/run-skill-loop.js` (skill-loop driver)
- `src/runtime/router.js` (`selectSkill` first-match router)
- `src/runtime/skill-probe.js` (`findDirectSkillMatch`)
- `src/runtime/cycle-outcome.js` (orphan after run-skill-loop)
- `src/runtime/skill-hooks.js` (orphan after run-skill-loop)
- `src/skills/echo-skill.js` / `fallback-skill.js` / `memory-skill.js`
  / `news-brief-skill.js` / `news-brief-utils.js` / `time-skill.js`
  / `web-search-skill.js`
- `extractFallbackSkill` and `normalizeLegacySkillLoopConfig` helpers
  in `config.js`; `fallbackSkill` plumbing in `runtime.js` /
  `session/handle.js` / `oodae.js`.
- `test/concerns/runtime-basic.test.js` and
  `test/concerns/skills-hooks-limits.test.js` (entire concerns —
  they tested the deleted OODAE / canHandle machinery).
- `test/concerns/session.test.js` first sub-test (the `remember:`
  skill-loop flow); `test/concerns/providers.test.js` custom-skill
  short-circuit sub-test.
- `legacy-skill-loop-used` step type (was a 274d-1 deprecation marker
  that no longer applies).

### Fixed
- `test/unit/skill-loader.test.js` no longer runs its async tests
  fire-and-forget at module load. The chain mutated `global.fetch`
  and could leak into later in-process tests' `withMockedFetch`
  windows, manifesting as compaction.test failing with `401 auth`
  errors from real openai. Now exports `run()` and `smoke.test.js`
  awaits it up-front.

### Migration
- Replace any `runtime.run("plain string")` or
  `runtime.run({type:"web_search",…})` call with a tool-loop provider
  request: `runtime.run({prompt, provider:"openai", apiKey, model})`
  (or `"gemini"`).
- For host-specific routing previously expressed as a `skills:` entry
  with `canHandle`, register it as a `customAction` via
  `defineAction(...)` + `createRuntime({customActions})`. See
  `agrun_docs/authoring-skills.md`.
- The 5-sub-test `web_search` skill-loop coverage moved fully into
  `test/concerns/research-flows.test.js` (planner-driven action-loop
  `cycles[N].decide.actionName === "web_search"`) and the
  `test/unit/web-search-endpoint.test.js` provider helper unit.

Reference: [ADR-0040](./agrun_docs/adr/0040-unify-skill-loaders.md) +
[ADR-0042](./agrun_docs/adr/0042-collapse-run-skill-loop.md). Ticket
chain: AGRUN-269 (RFC) → 270 (defineSkill) → 271 (customActions) →
272 (host plugin) → 273 (@deprecated) → 274a (provider-adapter
canHandle) → 274b-1/2 (test migration) → 274d-1/2/3/4 (gate +
deletion) → 274e (this commit).

### Added
- Native tools default switch (AGRUN-213k, 2026-04-29): `plannerMode` now defaults to `"native_tools"` for runtimes that do not explicitly configure a planner mode. Existing hosts can opt out with `createRuntime({ plannerMode: "envelope" })`. `nativeToolsFailurePolicy` still defaults to `"fallback_to_envelope"` so native planner/provider/tool-call failures retry through envelope mode for compatibility; `"hard_fail"` remains opt-in.
- Native tools default-readiness gate (AGRUN-213j, 2026-04-29): new strict live suite via `npm run test:live -- --suite native-readiness` covers OpenAI/Gemini native action, clarify, finalize, approval, search, and TodoState. The gate now passes 12/12 with `.env.local`. Gemini native finalize is hardened by a runtime-finalizer empty-response retry: when the planner selects native `finalize` but the provider returns no text/tool output, agrun emits `runtime-finalize-empty-response-retry` and retries once with a non-empty final-answer instruction.
- Runtime finalizer empty-response retry (AGRUN-213j, 2026-04-29): `executeRuntimeFinalize()` now treats provider empty text/tool output as recoverable once, without changing provider fallback behavior or exposing raw provider payloads. Concern coverage pins the retry step and recovered final answer.
- Native tools failure policy (AGRUN-213i, 2026-04-29): new advanced `createRuntime({ nativeToolsFailurePolicy })` option for `plannerMode: "native_tools"`. Default `"fallback_to_envelope"` preserves compatibility by emitting `planner-native-tools-fallback` and retrying the planner cycle through envelope mode. Opt-in `"hard_fail"` emits `planner-native-tools-failed` and returns the normalized planner/provider error without envelope retry, useful for native-mode debugging and strict host surfaces. Provider SDK wrapper errors without HTTP status now still normalize to safe provider errors instead of falling back to generic planner messages.
- TodoState integration guide (2026-04-28): new `agrun_docs/todo-state-integration.md` consolidates the host-facing contract surface for AGRUN-212a — 7 config knobs (`enabled` / `autostart` / `maxItems` / `maxVetoes` / `maxConsecutiveInspects` / `finalizationPattern` / `verificationPattern` / `actionProgressRules` / `promptStrings`), 5 planner actions (`todo_plan` / `todo_advance` / `todo_cancel` / `todo_run_next` / `todo_inspect`), full state shape, persistence/thread semantics, complete `onStep` event table (`todo-state-mutated`, `todo-plan-items-truncated`, `todo-plan-goal-anchored`, `todo-plan-verifier-nudge`, `todo-autopilot-*`, `todo-placeholder-plan-required`, `todo-plan-required-before-tools`, `todo-inspect-loop-vetoed`, `before-finalize-veto`), `inspectTodoState` debug helper, `promptStrings` deep-merge override rules, regex policy override rules, common recipes, and troubleshooting matrix. Bundled into `dist/agrun.md` via `agrun_docs/manifest.cjs` (`bundle: true`). Closes the largest DX gap identified in the 2026-04-28 third-party-engineer review — integrators no longer need to read source comments to wire TodoState.
- TodoState evidence-exhausted redirect (AGRUN-212a Amendment 2L, 2026-04-28): fixes finalize-veto infinite loop discovered via user Support Bundle. When `read_url` is structurally blocked (browser CORS without proxy) and `runState.autoReadStoppedReason` becomes `auto_read_limit_reached`, the autopilot fallback veto now redirects the planner to `todo_run_next` with an "evidence-limited" note instead of pure-block. Each redirect advances one TodoState item; plan drains naturally; finalize is then allowed. Replaces the pure-block path that produced 75 wasted veto cycles in production (real research prompt completed in 10 cycles after fix vs 80 cycles + `max_steps_continuation` before). New SSOT template `autopilot.evidenceExhausted({activeLabel,reason})` in `todo-prompt-strings.js`. Pinned by 3 new cases in `test/unit/todo-autopilot.test.js`. ADR-0010 amendment 2L.
- TodoState verifier nudge (AGRUN-212a Amendment 2K, 2026-04-28): `todo_run_next` now attaches an optional `verifierNudge: string` to its result and emits a `todo-plan-verifier-nudge` step when a 3+ item plan transitions to `completed` and no item label/note matches `DEFAULT_VERIFICATION_PATTERN` (`verify`/`test`/`check`/`validate`/`qa`/`smoke`/`regression`/`e2e`). Mirrors the claude-code `TodoWriteTool` `verificationNudgeNeeded` structural reminder. Threshold (3 items) skips trivial 1-2 step plans. Terminal_noop / advance / promotion calls do not fire — nudge is a one-shot signal at the transition-to-completed moment. SSOT layered: pattern in `src/runtime/todo-autopilot-rules.js` (`DEFAULT_VERIFICATION_PATTERN` + `normalizeVerificationPattern`); text template in `src/runtime/todo-prompt-strings.js` (`autopilot.verifierNudge({ itemCount })`); host overrides via `runtimeConfig.todoAutopilot.{verificationPattern,promptStrings.autopilot.verifierNudge}`. ADR-0010 amendment 2K. Pinned by 4 new cases in `test/unit/todo-actions.test.js` (10e/10f/10g/10h).
- TodoState runtime harness (AGRUN-212a, shipped 2026-04-26 across 5 phases, with amendments 2A–2K through 2026-04-28): structured per-thread `TodoState` (id/goal/items/activeItemId/status/version) replaces prose-extracted task tracking. Five planner-visible actions: `todo_plan` / `todo_advance` / `todo_cancel` / `todo_run_next` / `todo_inspect`. Mutation discipline locked through `applyTodoPlan` / `applyTodoAdvance` / `applyTodoCancel` (single-active-item invariant; ALLOWED_ITEM_TRANSITIONS table; terminal-state mutation rejection). Per-cycle ACTIVE TODO PLAN block (active ±2 with omitted counts) injected into planner prompt; `<1500` char budget regardless of plan length. Persistence rides `sessionRecord.threads[i].todoState` via AGRUN-206 CAS; compaction-window trim exempt. Browser UI consumes structured state directly with prose fallback. Anti-drift backstops: goal-anchor recovery from `observationSummary.prompt` when planner omits goal (Amendment 2I); consecutive `todo_inspect` veto (default cap 1 per task); verifier nudge on completion (Amendment 2K). Policy/Mechanism separation: all LLM-facing strings extracted to `todo-prompt-strings.js` SSOT with deep-merge override (Amendment 2H). Public API: `TODO_STATE_CONSTANTS` + `inspectTodoState` debug helper. ADRs: 0010 (locked schema + amendments).
- Self-improvement harness (AGRUN-210, shipped 2026-04-26 across 5 phases): `ImprovementPlan` 5-record schema with write-time validations; 5-layer lifecycle gate; 4 reflection rules; 3 fixtures. ADR-0011 (locked).
- Goal-anchor injection (AGRUN-142): three-layer verbatim-anchor model (`runState.originalQuery` run-scope · `thread.goalAnchor.text` thread-scope · mirrored to `runState.threadGoalAnchorText` on hydration) pipes a fixed `[ORIGINAL USER QUERY — DO NOT REINTERPRET]` / `[GOAL ANCHOR]` block into both `buildPlannerSystemPrompt` (right after `roleBlock`, before dynamic system prompt — stays prompt-cacheable) and `executeRuntimeFinalize` (between role and final-response system prompts). `captureOriginalQuery` seeds once per run and is immutable; `applyRouterVerdict` seeds `thread.goalAnchor` on `new_thread` and `bumpThread` lazy-seeds legacy threads without overwriting. Enabled by default (`runtimeConfig.goalAnchor.enabled: true`); disabled → block is `""` and prompts are byte-identical. Same-text layers dedupe to a single block. See [agrun_docs/context-and-continuity-model.md](./agrun_docs/context-and-continuity-model.md#goal-anchor-injection-agrun-142) and [agrun_docs/live-tests/agrun-142-goal-anchor-browser-smoke.md](./agrun_docs/live-tests/agrun-142-goal-anchor-browser-smoke.md).
- Goal-drift detector (AGRUN-146): per-cycle `detectDrift` harness in `src/runtime/drift-detector.js` — compares `turnState.goalAnchorText` against the last N `actionHistory` entries via default Jaccard (reuses `tokenizeTopicText` + `topic-scoring.js`) or a pluggable `runtimeConfig.driftDetection.similarityFn` hook. Severe drift (`similarity < severeThreshold`) → `force_replan` reminder; mild (`severe ≤ similarity < mild`) → `inject_reminder`. Verdict is stashed on `runState.driftSignal`, appended last into `plannerDirectives` by `action-loop-planner.js`, and cleared immediately so the reminder cannot snowball. Disabled by default (`enabled: false`); threshold / cadence config-driven; a throwing `similarityFn` degrades silently to no-verdict. See [agrun_docs/context-and-continuity-model.md](./agrun_docs/context-and-continuity-model.md#goal-drift-detector-agrun-146) and [agrun_docs/live-tests/agrun-146-drift-detector-browser-smoke.md](./agrun_docs/live-tests/agrun-146-drift-detector-browser-smoke.md).
- Thread-aware compaction (AGRUN-145): summary store keyed by `${sessionId}::${threadId}`; compaction pipeline filters messages per thread; post-compaction `filterByThreadWindow` harness + `hydrateRunStateWithThread({ compactionWindow })` auto-trim `toolContext.history` / `researchContext.readSources` against the persisted `oldestPreservedTurnId`. Threads-disabled sessions produce byte-identical compaction prompts. See [agrun_docs/context-and-continuity-model.md](./agrun_docs/context-and-continuity-model.md#thread-aware-compaction-agrun-145) and [agrun_docs/live-tests/agrun-145-slice-d-browser-smoke.md](./agrun_docs/live-tests/agrun-145-slice-d-browser-smoke.md).
- Thread isolation end-to-end (AGRUN-144): topic router, `threadId` / `turnId` stamping on memory entries, thread-scoped semantic recall. See [agrun_docs/adr/0002-long-running-multi-topic-architecture.md](./agrun_docs/adr/0002-long-running-multi-topic-architecture.md).
- Composite session budget with action-fingerprint repeat detection (AGRUN-141) — prevents infinite retry loops.
- Provenance fields on evidence entries (AGRUN-143).

### Known Gaps
_None — AGRUN-141..146 roadmap fully shipped._

---

## [0.2.0] — 2026 (final)

Global memory policy work — host hooks + domain-neutral extractor.

- Promotes [0.2.0-rc.2](./agrun_docs/release-notes-v0.2.0-rc.2.md) after host-integrator smoke-test confirmed all gates passed.
- Full notes: [agrun_docs/release-notes-v0.2.0.md](./agrun_docs/release-notes-v0.2.0.md).

### Added
- `createRuntime({ globalMemory })` options block.
- `sessionStore.updateGlobalMemory(id, patch)`.
- `onStep` step types: `global-memory-recalled`, `global-memory-written`, `global-memory-filtered`, `global-memory-purged`.
- Host hooks: `sensitivityFilter`, `promotionValidator` (fail-closed, 2s default timeout).
- Design principle #6 "Stay Domain-neutral." ([agrun_docs/spec.md](./agrun_docs/spec.md))
- Design principle #7 "Domain-neutral Memory Policy." ([agrun_docs/runtime-state-and-memory-architecture.md](./agrun_docs/runtime-state-and-memory-architecture.md))
- "Multi-tenant Deployment Pattern" section in root [README.md](./README.md).
- "Global Memory Configuration" section in [agrun_docs/public-runtime-api.md](./agrun_docs/public-runtime-api.md).
- `test/corpus/` redacted regression samples.

### Changed
- Extractor prompt rewritten for cross-session-durability scope with continuous confidence rubric.
- Hard-rejection rules for transient intents, time-scoped results, negative searches, speculative restatements, data dumps, and business identifiers — including when wrapped in natural-language prose.

---

## [0.2.0-rc.2] — 2026

Patch on top of rc.1. No API changes. Prompt-only tightening of the semantic memory extractor. No migration required.

Full notes: [agrun_docs/release-notes-v0.2.0-rc.2.md](./agrun_docs/release-notes-v0.2.0-rc.2.md).

### Changed
- `src/runtime/semantic-memory.js` `systemPrompt`: identifier-in-prose rejection rule, confidence ceiling adjustments.

### Fixed
- Closed leak class where hallucinated identifiers framed as "please remember X" passed `sourceTurn` grounding and polluted durable memory.

---

## [0.2.0-rc.1] — 2026

First RC for the global memory policy work. Non-breaking; new capability is opt-in.

Full notes: [agrun_docs/release-notes-v0.2.0-rc.1.md](./agrun_docs/release-notes-v0.2.0-rc.1.md).

### Added
- `createRuntime({ globalMemory })` options (`minConfidence`, `maxEntries`, `hookTimeoutMs`, `sensitivityFilter`, `promotionValidator`).
- Multi-tenant deployment documentation.
- Extractor tightening v1.

---

## [0.1.x] and earlier

No aggregated changelog exists for pre-0.2 versions. Reconstruct from git history:

```bash
git log --oneline --decorate --tags
```

---

## Release Process

See [agrun_docs/release-process.md](./agrun_docs/release-process.md) for how to cut a new version and where each artifact (dist bundle, release notes, this changelog) gets updated.
