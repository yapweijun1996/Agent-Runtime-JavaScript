# Agent Workflow Debuggability Review — 2026-05-09

## Question

User asked whether agrun's current runtime logic is too complex and confusing,
whether the LLM request/response wiring is causing workflow issues, and how
Inspector can monitor the AI agent workflow more clearly.

## Position

The concern is valid. The runtime has accumulated many useful but overlapping
surfaces:

- OODAE cycles
- runtime steps
- planner prompt preview
- provider request/response events
- action history
- tool context
- research state
- virtual workspace
- approval resume context
- Inspector diagnosis cards
- support bundle sections

This is not automatically wrong, but it makes debugging hard because the
current Inspector does not yet present one simple "agent workflow ledger" that
answers:

1. What did the LLM receive?
2. What tool choices were available?
3. What did the LLM return?
4. How was the response parsed/repaired?
5. What action executed?
6. What observation went into the next OODAE cycle?
7. Why did the model decide to finalize, continue, or ask approval?

## Current State

Good existing signals:

- `runState.oodae.cycles` records observe/orient/decide/act/evaluate.
- `planner-requested` exposes current goal/topic, available actions, selected
  skill context, and `plannerPromptPreview`.
- `planner-responded`, `phase-decide-completed`, `action-executing`,
  `action-executed`, `observation-recorded`, and `phase-evaluate-completed`
  provide a step-by-step trace.
- `provider-requested` / `provider-responded` exist for finalizer calls.
- Native tool-call debug already scrubs raw args shape through
  `summarizeToolCallsForDebug`.
- Browser support bundles include research gate, read_url, virtual workspace,
  runtime overrides, and OODAE summaries.

Gaps:

- Planner provider calls do not have a first-class request/response ledger in
  Inspector. We see prompt preview and decision result, but not a compact,
  sanitized packet showing system-prompt family, planner mode, tool schema
  count, tool-choice mode, response type, raw tool-call names, and parse/repair
  outcome.
- OODAE is recorded as runtime phases, but the UI does not make the LLM boundary
  obvious. Users see many runtime steps, not "LLM request -> LLM response ->
  parsed decision -> action -> observation".
- Inspector is strong for postmortem support bundles, but less strong as a live
  workflow monitor for "why did the agent skip workspace_read?".
- There is no single per-cycle "AI packet" that connects prompt state,
  available tools, response shape, parser repair, chosen action, and feedback
  into one row.

## Recommended Debug Model

Add an Inspector "Agent Workflow" or "LLM Packets" section that is derived from
existing runtime data and adds only sanitized, structured metadata:

Per cycle:

- Cycle number and OODAE phase status.
- Planner mode: `native_tools`, `envelope`, or fallback.
- Request packet:
  - provider/model
  - system prompt profile/hash or short preview
  - planner prompt preview hash + key extracted sections
  - available action names
  - native tool count and important tool names
  - active skill name/checksum
  - virtual workspace file count + final candidate stats
  - readSources count and latest status
- Response packet:
  - response type: tool_call, envelope JSON, text, empty, invalid
  - native tool-call names and sanitized args shape
  - parsed decision type/action name
  - repair path: none, repair, invalid hook, fallback
  - finalReadiness if present
- Action packet:
  - action executing/executed
  - action result kind/control
  - approval gate result
  - observation summary
- Evaluation packet:
  - outcome
  - reason
  - next visible signal to AI
  - runtime override/rejection if any

## Engineering Principle

Do not make runtime do AI work. Improve debug by making the boundary visible:

- Runtime should not decide "the answer is long enough".
- Runtime should expose exact `textStats`, tool results, and planner feedback.
- AI should decide whether to continue or finalize.
- Inspector should make it easy to see whether AI had enough state/tool
  visibility to make that decision.

## Proposed Next Implementation

1. Add a `planner-packet` debug step around planner provider calls.
   - Before request: capture sanitized request metadata.
   - After response: capture sanitized response metadata and decision parse
     result.
   - Do not store secrets or full prompts by default.
2. Add a support bundle section `[oodae_packet_ledger]`.
3. Add an Inspector panel/table for the same packets.
4. Add tests that prove:
   - native_tools request packet includes tool count/action names;
   - native tool response packet includes sanitized tool-call shape;
   - envelope response packet includes repair status;
   - workspace textStats are visible when final_candidate exists;
   - no API key/header secrets leak.

## Implemented First Slice

Status: completed for planner request/response packet observability.

Files:

- `src/runtime/agent-workflow-packets.js`
- `src/runtime/planner.js`
- `examples/browser/src/components/inspector-debug-report.ts`
- `examples/browser/test/inspector-debug-report.smoke.ts`

What changed:

- Added sanitized `agent-workflow-packet` runtime steps around planner provider
  calls.
- Request packets expose planner mode, provider/model, available action count,
  native tool count/names, prompt/system-prompt hashes and short previews,
  active skill, read source count, and virtual workspace final-candidate stats.
- Response packets expose finish reason, response type, repair path, parsed
  decision/action, finalReadiness summary, and sanitized tool-call names/arg
  shapes.
- Browser Inspector now renders these rows under
  `[oodae_packet_ledger]`, so debugging can follow:
  `planner_request -> planner_response -> decision/action/observation`.
- Existing support-bundle packet counts continue to work from the same derived
  ledger.

Verification:

- `node test/concerns/native-tools.test.js`
- `node test/unit/english-codebase.test.js`
- `npm --prefix examples/browser run test:smoke`
- `npm --prefix examples/browser run lint`
- `npm run build:lib`
- `npm run dist:check`
- `npm test`
- `git diff --check`

## HBR

The first slice makes the LLM boundary visible, but it is not yet a full live
workflow monitor panel. There is still no dedicated UI table with filtering by
cycle/action, and this change has not yet been validated with a fresh real API
Chinese long-research run.

## 2026-05-10 Follow-up: Read URL Window Inspector + Service Forwarding

Status: completed for source-window observability and service range forwarding.

Problem found after the first source-window pass:

- `read_url` action supported `textStart` / `textLength`, but the browser
  read-url service adapter did not forward those fields to `/read-url`.
- If a future service applied the requested window server-side, runtime would
  have cropped the already-windowed body again.
- Inspector could show raw read sources only through support/debug text; it did
  not have a first-class `read_url` window panel.
- Support initially misclassified AI-requested source windows as Tool/Read URL
  issues because windowed reads set `truncated=true`.

Implemented changes:

- Service fetch payload forwards `maxBytes`, `timeoutMs`, `textStart`, and
  `textLength`.
- Synthetic service responses can carry `textRange` metadata and
  `x-agrun-read-url-window-applied=true`.
- Runtime honors service-applied windows and skips local double-cropping when
  that metadata is present.
- Inspector Evidence renders `Read URL Windows` rows with range, next offset,
  status, text length, title, and URL.
- Support/debug report summaries include `text_range`.
- Support classification excludes AI-selected source windows from read-url
  blocking errors when the source succeeded.

Harness boundary:

- Runtime exposes continuation coordinates and transport metadata.
- Runtime does not decide whether the first window is enough.
- AI chooses whether to read `nextTextStart`, read a different source, or
  finalize with limitations.

Verification:

- `node test/unit/read-url-window.test.js`
- `node test/concerns/bundled-skills-and-read-url-service.test.js`
- `npm --prefix examples/browser run lint`
- `npm --prefix examples/browser run test:smoke`
- `npm --prefix examples/browser run build`
- `npm run build:lib`
- `npm run dist:check`

Live QA:

- Direct `example.com` run with `textLength=80` completed Healthy Run.
- Inspector Evidence showed `READ URL WINDOWS`, `range:0-80/149`, `next:80`,
  and `more:yes`.
- Support changed from the initial false `Tool/Read URL Issue` to
  `Healthy Run` after excluding successful AI-selected windows from blocking
  classification.
- Broad web-search/read prompt completed in about 14s after the wait condition
  was corrected to use actual idle state instead of relying on a case-sensitive
  LLM Trace heading check.

HBR:

- Broad web-search/read output still did not visibly include the literal
  `finalReadiness.decision` string requested by the QA prompt, even though
  Inspector showed AI-declared `finalReadiness=ready`. This is a model/planner
  instruction-following issue to handle separately; runtime should not
  synthesize that field into the user's answer.

## 2026-05-10 Follow-up: Finalizer Source Windows + LLM Trace Compare

Status: completed for the next payload-optimization pass.

Problem found by LLM Trace:

- After planner evidence projection, the finalizer still showed
  `large_session_context_source` around 20k chars after `read_url`.
- Simply trimming read evidence is not enough. If the AI only sees chars
  `0..1800`, it must still be able to request later page text when the missing
  answer may be after the first window.

Implemented changes:

- `read_url` accepts optional `textStart` and `textLength`.
- `read_url` returns `textRange` with `start`, `end`, `totalChars`,
  `hasAfter`, and `nextTextStart`.
- Planner/native guidance tells AI to call `read_url` again with the same URL
  and `textStart=nextTextStart` when later page text may matter.
- Finalizer uses a compact session-context projection that keeps goal/topic,
  confirmed memory, and read-source metadata while dropping raw history and
  duplicated read_url body text.
- Final answer prompt labels windowed evidence and warns the finalizer not to
  invent unseen page text.
- Inspector LLM Trace now shows first-to-latest request comparison and JSON/CSV
  copy export, so payload/response optimization can be reviewed run-to-run.

Harness boundary:

- Runtime does not decide whether a source window is enough.
- Runtime exposes `textRange` and continuation coordinates.
- AI chooses whether to read another window, read another source, or finalize
  with limitations.

Verification:

- `node test/unit/read-url-window.test.js`
- `node test/unit/session-context-projection.test.js`
- `node test/unit/final-response-prompt.test.js`
- `node test/unit/planner-native-system-prompt.test.js`
- `npm --prefix examples/browser run test:smoke`
- `npm --prefix examples/browser run lint`
- `npm --prefix examples/browser run build`
- `npm run build:lib`
- `npm run dist:check`
- `npm test`

Live QA:

- Narrow direct-read run completed Healthy Run against `https://example.com`.
- Finalizer request dropped to `chars=5,486`, `message=1,812`,
  `session=1,117`.
- LLM Trace showed `compare:first->latest`, `JSON`, and `CSV`.

HBR:

- A broader real web-search/read/finalize prompt timed out after 240s. This is
  model/workflow behavior, not a payload-visibility failure; it should be
  handled as a separate planner/skill quality improvement.

## LLM Payload Optimization Slice

Status: completed for short-task planner payload reduction.

Root cause found by LLM Trace:

- The first real short-task run exposed a 49,750-char first request.
- Compact envelope examples alone reduced synthetic envelope examples by about
  59%, but real first-request savings were only around 2k chars.
- The dominant payload was the planner system prompt, not action examples.
- The browser example also injected the `globe3-erp-support` role by default,
  which added customer-specific Globe3/TNO context to the general demo and
  increased every planner request.

Implemented changes:

- Added compact planner envelope examples for normal planner calls while
  keeping repair paths able to use full examples.
- Added a compact planner system profile for simple runtime state.
- The planner selects compact profile from structured harness state, not
  lexical prompt matching.
- The planner falls back to the full profile when active skill, active
  TodoState, todo state block, or virtual workspace content is present.
- Removed the browser example's default `globe3-erp-support` role.
- LLM Trace request rows now show `systemChars` and `messageChars`, and emit
  `large_system_prompt` / `large_message_text` optimization signals.

Real Chrome/Gemini QA:

- Prompt: short web-search/read request for AI browser agents in 2026.
- v2 before compact system profile: first request `chars=34,172`,
  `systemChars=20,236`, `messageChars=6,631`; signals included
  `large_payload` and `large_system_prompt`.
- v3 after compact system profile: first request `chars=19,970`,
  `systemChars=6,034`, `messageChars=6,631`; `large_system_prompt`
  disappeared.
- The run stayed Healthy Run, used `web_search -> read_url -> finalize`, cited
  the read source, and produced `finalReadiness.decision: limited`.

HBR:

- Later planner cycles still had large message text after search/read evidence:
  cycle 2 `messageChars=52,550`, cycle 3 `messageChars=29,214`.
- Runtime finalizer still had `large_session_context` after read_url:
  `sessionChars=20,375`.

## Streaming Debug Snapshot Correction

Status: completed for browser Inspector streaming visibility.

Root cause:

- While a turn was running, the browser example attached a pending debug
  placeholder to the assistant message.
- `onStep` updated only shallow fields (`lastAction`, `phase`, `runId`,
  `status`, `stepCount`), so Support Bundle could show `mode=provider`,
  `agrun_session_id=n/a`, `selectedSkill=n/a`, and no Research Gate even while
  agrun `session.run()` was actively executing.

Fix:

- Runtime `onStep` snapshots now include a read-only debug projection of
  `runState` fields needed by Inspector: mode, selected skill, planner,
  research state, research finalize contract, virtual workspace, TodoState,
  OODAE, and related counters.
- Browser streaming steps synthesize a real `MessageDebugSnapshot` from the
  current runtime steps + snapshot.
- The browser session updates `agrunSessionId` during streaming once the
  runtime session is known.
- Abort UI now marks the latest debug snapshot `status=interrupted` so Support
  Bundle does not keep reporting `running` after the user stops the run.

Harness boundary:

- This adds observability only.
- It does not decide source sufficiency, report length, or next action.
- It lets humans see whether AI saw `readSources`, workspace stats, and
  readiness contract state while the run is still active.

## Plan Default Continue Correction

Status: completed for AI-first action-loop direction.

Root cause:

- `type:"plan"` executed its actions and then defaulted into
  `executeRuntimeFinalize`.
- A model could return a plan containing `read_url` actions and still be
  terminalized by runtime immediately after plan execution.
- In real QA, the AI returned `type:"plan"` to continue reading sources, but
  because the plan envelope included `finalReadiness`, runtime observed a
  planner finalize contract and called the finalizer provider.

Fix:

- Normal plans now execute actions and return a `plan_result` observation to the
  next decision cycle.
- AI must explicitly choose `type:"finalize"` to terminate through the finalizer.
- `synthesize_per_action:true` remains the explicit plan-synthesis path.
- Planner envelope examples no longer show `finalReadiness` on `type:"plan"`;
  finalReadiness guidance is scoped to `finalize`.

HBR:

- Real QA still showed poor task-progress behavior: AI completed visible
  workspace/search work but did not call `todo_advance` / `todo_run_next`, so
  Task progress stayed at `Step 1/4`.
- Prompt guidance now tells AI to advance TodoState after completed visible work
  actions, but runtime still does not auto-complete TodoState items.

## AI-first Readiness Inspector Correction

User review found that adding Inspector warning rows such as
`length_below_requested` was still too close to runtime doing AI work.

Corrected design:

- AI Workflow is now a factual ledger only.
- Runtime does not add `runtime_warning` rows to explain or score AI decisions.
- Inspector does not parse prompt length or decide whether a final report is
  long enough.
- Support Bundle keeps raw values visible: AI finalReadiness declaration,
  missing readiness status, successful `read_url` count, and workspace
  `finalCandidateStats`.
- Diagnosis text may say readiness is missing or a direct final bypassed the
  readiness contract, but it does not make a sufficiency judgment.

Related UX fix:

- After a provider/fetch failure, browser state now returns to `idle` instead of
  staying stuck in `evaluating`, so the user can continue debugging from the
  same session.

Verification:

- Production source and built dist grep clean for `runtime_warning`,
  `length_below_requested`, prompt length parsing, and requirements warning
  fields.
- `npm --prefix examples/browser run test:smoke`
- `npm --prefix examples/browser run lint`
- `npm run build`
- `npm run dist:check`
- `git diff --check`

HBR:

- Inspector is now less judgmental, but that means weak AI behavior is still
  possible. The fix gives clear evidence for debugging without converting
  runtime into a quality judge.

## Deep Review: Terminal Tool Surface Was Too Loose

Finding:

- Native planner mode exposed `final_answer` even during research, active skill,
  read_url, and virtual workspace workflows.
- That made the terminal protocol ambiguous:
  - `finalize` means contract-bound synthesis with optional/required
    `finalReadiness`.
  - `final_answer` means simple direct answer with no tool workflow.
- Relying on prompt wording alone was not enough. Harness should not expose a
  simple-answer terminal tool when the current workflow requires a research
  finalize contract.

Fix:

- `buildOpenAITools` / `buildGeminiTools` now accept
  `suppressFinalAnswerTool`.
- `planNextActionWithNativeTools` suppresses `final_answer` when runtime state
  shows a contract-bound workflow:
  - research quality gate required,
  - active/read agent skill,
  - virtual workspace enabled,
  - or existing `read_url` evidence.
- `finalize` remains available and carries AI-owned `finalReadiness`.

Why this is still AI-first:

- Runtime is not judging report quality.
- Runtime is not choosing search/read/finalize direction.
- Runtime is only presenting the correct action API for the workflow class,
  so the AI's decision must go through the inspectable research contract.
- Next optimization should target evidence/message compaction and finalizer
  session-context projection, not more runtime decision logic.

## Real API Validation Slice

Status: completed for support-bundle postmortem visibility.

Chrome real API rerun:

- URL: `http://127.0.0.1:3000/?debug_yn=y&skill_provider=public&qa=real-api-cn-3000-oodae-ledger-v1-2026-05-09&qa_clean=y&qa_auto_approve_tier1=y`
- Prompt: `用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告`
- Provider/model: `gemini / gemini-3.1-flash-lite-preview`
- Result: completed after 42 cycles.
- Skill: `deep-research-writer`.
- Approval gate: tier-1 auto approval worked through host policy; `actionPolicy=read_url:allow, web_search:allow`.

Observed debug quality:

- Support bundle showed planner request/response packets, plan validation
  feedback, action execution, observations, and research finalize contract in
  one cycle-aligned ledger.
- The ledger made it clear that the AI repeatedly emitted invalid mutating
  actions inside `plan.actions`; runtime rejected those contracts and returned
  feedback instead of executing or rewriting them.
- Runtime did not decide source sufficiency and did not choose the next
  research direction. It only exposed state and rejected invalid action shape.

Real HBR:

- Final report quality failed the user request: `final_candidate.md` was 1518
  chars, far below a 3000 Chinese-character deep report.
- `read_url` evidence was unusable: one 502 (`toutiao`) and one blocked origin
  403 (`zhihu`), leaving `successful_read_url_count=0`.
- The AI declared `finalReadiness.ready` despite `research_state.final_allowed=false`
  and gaps `insufficient_relevant_sources,no_strong_source,weak_sources_only`.
- Runtime overrides were high: 26 total, all from plan validation failed/rejected
  pairs for `skill_mutator_in_plan`.

Interpretation:

This is the desired AI-first failure shape for debugging: the support bundle now
shows exactly what the AI saw and returned, why runtime rejected invalid
contracts, and why the final report was weak. The next improvement should be
planner/skill/model behavior, not runtime hardcoded sufficiency judgment.

## Plan Contract SSOT + OODAE Ledger Cleanup

Status: completed for removing the separate hardcoded standalone-action list
from plan validation.

What changed:

- `src/runtime/action-plan-contract.js` is now the SSOT for plan-action
  metadata (`allowedInPlan: false` and standalone-only detail text).
- Mutating workspace, todo, and skill-loading actions carry
  `plan: STANDALONE_PLAN_ACTION` in their action definitions.
- Plan validation reads `session.actionRegistry.get(actionName).plan` instead
  of checking a separate fixed array.
- Planner/native/envelope guidance derives the current standalone-only action
  names from the registered action metadata.
- Browser Inspector moved packet classification into
  `examples/browser/src/runtime/oodae-packet-ledger.ts`, and the Support Bundle
  section is now `[oodae_packet_ledger]`.

Fresh Chrome real API validation:

- URL: `http://127.0.0.1:3011/?debug_yn=y&skill_provider=public&qa=real-api-cn-3000-ssot-ledger-v4-2026-05-09&qa_clean=y&qa_auto_approve_tier1=y`
- Prompt: `用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告`
- Provider/model: `gemini / gemini-3.1-flash-lite-preview`
- Result: completed after about 2m45s.
- Selected skill: `deep-research-writer`.
- `research_finalize_contract`: `successful_read_url_count=2`,
  `ai_declared_ready=yes`.
- Plan validation feedback detail was metadata-derived:
  `workspace_write is marked standalone-only by its action metadata...`

Fresh HBR:

- The final report still failed the 3000 Chinese-character request:
  `final_candidate.md` was only 1468 chars.
- Runtime overrides remained high: 24 plan-validation failed/rejected entries.
- The Inspector classified the run as `Healthy Run`. That is acceptable only
  as a harness-contract status; it must not imply the runtime judged the
  response quality or length as sufficient. The support bundle should expose
  the AI's own readiness declaration and raw workspace `textStats` so a human
  or the next AI step can inspect the mismatch without runtime judging it.

Interpretation:

This cleanup removes the validation hardcode that the user challenged. It does
not make runtime decide research or length sufficiency. Runtime still only
validates action contracts and exposes observable state; the AI still chooses
whether the requested length and content quality are satisfied, whether to
search, read, draft, revise, or finalize with limitations. The remaining bad
result is an AI self-evaluation / skill-following issue, not a runtime gate to
add.

## LLM Trace / Provider IO Inspector Slice

Status: completed for safe provider payload/response observability.

Why this slice was needed:

- The OODAE packet ledger made planner workflow visible, but request payload
  optimization still required guessing because OpenAI/Gemini provider adapters
  returned `requestBody: null`.
- Long, multi-turn agent issues often depend on what was actually sent to the
  provider: message count, session context size, tool schema size, omitted image
  bytes, provider options, and response envelope shape.
- Codex needs this trace to optimize payload and response handling without
  adding runtime-owned quality judgments.

What changed:

- Added `src/runtime/llm-trace.js` as the SSOT for safe trace creation:
  `createProviderRequestTrace`, `createProviderResponseTrace`,
  `summarizeTraceText`, and stable trace hashing.
- Planner request/response packets now carry `requestPayload` and
  `responsePayload` summaries for both native-tools and envelope planner modes.
- OpenAI/Gemini browser providers now return a sanitized request trace derived
  from the actual AI SDK call ingredients instead of `requestBody: null`.
- OpenAI/Gemini browser skill finalizer steps and runtime finalizer steps now
  attach response traces.
- Browser Inspector derives an `[llm_trace]` report section, a raw `LLM Trace`
  tab, and support-bundle `trace.llmTraceLedger` / `llmTraceCount`.

Trace fields:

- Request trace: provider, model, API variant, auth mode, call kind, endpoint
  path, provider option shape, system/prompt/message summaries, tool count and
  schema size, tool choice, session context summary, estimated char count,
  message text chars, omitted image count, and stable hash.
- Response trace: status, finish reason, response text summary, tool-call names
  and argument-shape summary, usage metrics, raw envelope shape preview, and
  stable hash.

Safety contract:

- Redacts secret-like keys such as API keys, authorization, bearer tokens,
  cookies, credentials, passwords, secrets, and tokens.
- Redacts bearer/API-key-like string values and image data URLs.
- Caps deep object traversal, array length, text preview size, and JSON preview
  size so support bundles stay bounded.
- Exposes only summaries and shapes, not full raw prompts or replayable provider
  payloads.

Verification:

- `node test/unit/llm-trace.test.js`
- `npm exec tsx ./test/inspector-debug-report.smoke.ts` from
  `examples/browser/`
- `npm --prefix examples/browser run lint`
- `npm --prefix examples/browser run test:smoke`
- `npm --prefix examples/browser run build`
- `npm run build:lib`
- `npm run dist:check`
- `npm test`
- `node test/unit/english-codebase.test.js`

HBR:

- A fresh real-provider rerun was not repeated for this slice; validation was
  deterministic unit/smoke/build coverage.
- The trace is intentionally summarized, not a full raw payload replay. That
  protects secrets and bundle size, but means ultra-low-level provider debugging
  may still require a controlled local repro with explicit host-side logging.

## LLM Trace Table + Token/Latency Slice

Status: completed for Codex-owned payload/response optimization.

What changed after the first LLM Trace slice:

- Added a dedicated Inspector `LLM Trace` section with metric tiles, row-level
  request/response summaries, and filters for all rows, requests, responses,
  and rows with optimization signals.
- Provider response traces now include normalized metrics:
  `inputTokens`, `outputTokens`, `totalTokens`, `latencyMs`, `textChars`, and
  `toolCallCount`.
- OpenAI and Gemini browser providers measure request latency for both
  streaming and non-streaming calls.
- Browser support bundles derive advisory optimization signals from trace
  summaries: large payload, large tool schema, large session context, omitted
  image payloads, slow provider, high token usage, empty response, and tool-call
  response.
- The advisory signals are UI diagnostics only. They do not block, rewrite, or
  score the AI response.

Real provider QA:

- URL:
  `http://127.0.0.1:3013/?debug_yn=y&skill_provider=public&qa=llm-trace-real-provider-v3-2026-05-09&qa_auto_approve_tier1=y`
- Provider/model: `gemini / gemini-3.1-flash-lite-preview`.
- Prompt class: short web-search/report request.
- Result: completed in about 11 seconds and Inspector classified the harness run
  as healthy.
- LLM Trace surfaced 2 requests, 2 responses, 14,832 total tokens, and 4.6s
  total provider latency.
- First request was unexpectedly large for the simple task:
  49,750 estimated chars, 9,789 input tokens, and `large_payload` signal.
- This gives a concrete next optimization target: reduce planner
  envelope/session/workflow payload size for short tasks without removing the
  observability that long tasks need.

Bug found during real QA:

- A longer Gemini run returned final JSON with top-level `finalReadiness`, but
  envelope planner repair normalized the response to `type: "final"` while
  dropping `finalReadiness`.
- That caused the research-finalize contract to treat AI readiness as missing
  and continue until `max_steps_continuation`.
- Fixed by preserving normalized `finalReadiness` through envelope final,
  finalize, and plan repair paths, and through native `final_answer` /
  `finalize` / `plan` tool parsing.

Fresh HBR:

- The live QA prompt was duplicated by the browser automation fill/type path,
  which inflated the measured request size. Even with that caveat, the trace
  still proved the first request envelope is heavy.
- The completed short run searched and answered from search results but did not
  use `read_url` despite the prompt asking to read one useful source. This is an
  AI/tool-selection quality issue visible in Inspector, not a runtime fallback
  to add.
- Raw usage objects still redact keys containing `token`; normalized
  `usageSummary` and `metrics` preserve numeric token counts for optimization.

## AI-First Requirements Assessment Cleanup

Status: completed for removing runtime-authored sufficiency judgment from
Inspector workflow diagnostics.

User concern:

- Runtime/Inspector must not hardcode the 3000-character request.
- Runtime must not decide the final answer is too short or source evidence is
  insufficient.
- AI must decide whether to continue search/read, revise, or finalize with
  limitations.

What changed:

- `finalReadiness.requirementsAssessment` remains AI-authored.
- Runtime `finalReadinessAssessment` now records only:
  - the AI assessment object,
  - raw observed research/workspace state,
  - `status=declared|missing`.
- Removed runtime-derived warning rows and fields from Inspector/support bundle.
- Removed the synthesized AI Workflow row titled `Why finalize is suspicious`.
- Inspector still shows raw `finalCandidateStats`, successful read_url count,
  finalReadiness decision, and the AI's own requirement summary/decision.

Verification:

- `rg` shows no production references to `length_below_requested`,
  runtime-derived `promptLengthRequest`, `actualLengthForRequest`, or
  `requirements_assessment_warnings`.
- `node test/unit/action-loop-session-terminals.test.js`
- `node test/unit/planner-prompt-envelope-lines.test.js`
- `node test/unit/planner-tools-decision.test.js`
- `node test/unit/planner-tools-schema.test.js`
- `node test/unit/planner-native-system-prompt.test.js`
- `npm --prefix examples/browser run test:smoke`

HBR:

- Real API output can still be bad or short. The cleanup deliberately does not
  fix that with a runtime gate.
- The correct failure shape is now visible: AI can declare
  `requirementSatisfied=false` / `finalReadiness=limited`, while runtime only
  displays the declaration and raw evidence.

## LLM Payload Delta and Evidence Projection

Status: completed for the next payload optimization slice.

Problem found by LLM Trace:

- The first compact-system QA fixed `large_system_prompt`, but later planner
  cycles still had `large_message_text`.
- Root cause was not the static prompt. `loopState.lastObservation` projected
  full action output into the next planner request, including raw web-search
  provider payloads.
- The Inspector also could not quickly show whether a later request grew or
  shrank versus the previous request.

What changed:

- Added a planner prompt projection module for compact `searchResults` and
  `lastObservation` evidence.
- Web-search observations now expose query/count/status/top result summaries,
  not provider `raw` payloads or full `searchPasses.items`.
- Read-url observations expose URL/status/title and a capped text preview.
- LLM Trace request metrics now include deltas against the previous request:
  `deltaChars`, `deltaSystem`, `deltaMessage`, and `deltaSession`.
- Request `estimatedChars` now reflects provider payload ingredients instead
  of double-counting debug prompt/session-source fields.
- The finalizer signal is now `large_session_context_source`, which is more
  accurate because session context is a source object used to build the system
  prompt, not a separate provider payload part.

Real Chrome/Gemini result:

- Before this slice, cycle 2 planner request had `messageChars=52,550`; after
  projection it is `9,228`.
- Before this slice, cycle 3 planner request had `messageChars=29,214`; after
  projection it is `11,318`.
- Runtime finalizer estimated chars improved from `41,504` to `12,956`.
- Inspector showed request deltas directly, e.g. cycle 2 `Delta chars=+2,519`
  and `Delta message=+2,519`.

Harness boundary:

- Runtime still does not decide whether a request is "too large" or rewrite AI
  strategy.
- Runtime exposes compact, truthful evidence state and payload deltas so Codex
  or the user can optimize the harness with facts.

HBR:

- `large_session_context_source` remains at about `20,591` source chars after a
  successful read. The payload estimate is now much lower, but source-context
  projection still deserves a future compacting pass.

## Runtime Lifecycle and Action Result Envelope Inspector

Status: completed for the Inspector no-guess trace slice.

Problem:

- OODAE Cycles, AI Workflow, and LLM Trace showed planner/provider flow, but a
  developer still had to infer lifecycle state across `runtime_steps`, task
  progress, policy blocks, provider errors, and action rows.
- The Activity panel could say a tool was drafting/running while task progress
  remained unchanged, without one compact lifecycle projection explaining
  whether the run was waiting, blocked, interrupted, terminal, or merely missing
  Todo progress.

What changed:

- Added `buildRuntimeLifecycleTrace()` as a browser-side projection over
  existing `runtime_steps` plus current debug snapshot state.
- Added `buildActionResultEnvelopes()` to normalize action execution,
  completion, policy block, and action error rows into stable action envelopes.
- Added a visible Inspector `Runtime Lifecycle` section with event count,
  action count, warning/bad signal count, last action status, and latest
  lifecycle rows.
- Debug Report now includes `[runtime_lifecycle]` and
  `[action_result_envelopes]`.
- Support Bundle now includes `trace.runtimeLifecycle`,
  `trace.actionResultEnvelopes`, `userReport.runtimeLifecycleCount`,
  `userReport.actionResultEnvelopeCount`, and Debug Index summaries for both.
- Raw Inspector tabs now include `Runtime Lifecycle` and `Action Results`.
- Follow-up: Support now also has `Copy Lifecycle`, a small bundle focused on
  `runtimeLifecycle`, `actionResultEnvelopes`, Debug Index, and Todo progress.
- Follow-up: Debug Index now promotes stale Todo progress to the first signal
  when work actions occurred after the last Todo progress action. This makes
  "Activity is drafting/running but task progress did not advance" visible
  without runtime auto-advancing or blocking AI finalize.
- Follow-up: Raw Inspector tabs include `Todo Progress Debug`, and `Inspect
  First` points there when the stale-progress signal is present.

Harness boundary:

- This is projection only. It does not change runtime decisions.
- Runtime still does not judge report/source/length sufficiency.
- Protocol, lifecycle, policy, provider, and action-result facts are exposed so
  Codex can debug from evidence instead of guessing.

Verification:

- `npx tsx examples/browser/test/inspector-debug-report.smoke.ts`
- `npm --prefix examples/browser run lint`
- `npm --prefix examples/browser run build`
- Real headless Chrome/CDP Gemini QA on
  `用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告`;
  evidence recorded in
  `agrun_docs/live-tests/runtime-lifecycle-inspector-real-cn-2026-05-10.md`.

HBR:

- Chrome DevTools MCP returned `selected page has been closed`, so real browser
  QA used local headless Chrome CDP instead of the MCP tool.
- Two earlier QA attempts found test-script issues: unsafe regex escaping during
  DOM state extraction, then an unconditional Inspector click that closed the
  already-open panel. The final v4 run passed after checking the panel state
  before clicking.

## LLM Payload/Response Optimization Inspector

Status: completed for the payload growth and source-window debug slice.

What changed:

- LLM Trace request rows now show `system`, `message`, `session`, and `schema`
  character metrics plus `Delta system`, `Delta message`, `Delta session`, and
  `Delta schema` against the previous request.
- Each request row now exposes a `growth:<source> <delta>` chip so a developer
  can quickly see whether payload growth came from messages, session context,
  system prompt, or tool schema.
- LLM Trace CSV export includes `deltaSystemChars`,
  `deltaMessageTextChars`, `deltaSessionContextChars`,
  `deltaToolSchemaChars`, and `topGrowthSource`.
- Evidence `READ URL WINDOWS` now renders `Copy next args` when a source has
  `hasAfter=true`, copying `{ url, textStart: nextTextStart, textLength, mode }`
  for the next `read_url` call.
- Finalizer post-processing now preserves a requested visible
  `finalReadiness.decision: ready|limited` line when readiness intent is
  explicit. It prefers AI structured `finalReadiness.decision`; if that is
  missing in native finalize, it accepts only explicit ready/limited wording
  such as `finalReadiness.decision: limited`, `decision limited`, or
  `limited decision`.

Harness boundary:

- Runtime still does not judge whether the answer is good enough, long enough,
  or source-sufficient.
- Runtime only exposes payload/response facts and preserves a user-visible
  readiness line from explicit AI/user readiness intent.

Verification:

- `node test/unit/final-response-prompt.test.js`
- `node test/unit/planner-native-system-prompt.test.js`
- `npm --prefix examples/browser run test:smoke -- inspector-debug-report`
- `npm --prefix examples/browser run lint`
- `npm run build:lib`

HBR:

- Repeated real Chrome/OpenAI QA confirmed `LLM TRACE`, `READ URL WINDOWS`,
  `Copy next args`, `Delta schema`, and `growth:*` were visible, but also
  exposed native finalize variants that omitted the visible
  `finalReadiness.decision` line. The last full live assertion failed before
  the final `limited decision` regex amendment was rerun; unit coverage now
  pins that exact observed phrasing.
