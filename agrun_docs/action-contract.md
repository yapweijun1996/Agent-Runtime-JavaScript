# agrun.js Action Contract

## Purpose

This document defines the MVP action contract for the planner/action path in `agrun.js`.

Actions are runtime-owned units used by the planner-driven OODAE loop.
They are not the same thing as skills.

Use this document when working in:

```text
src/runtime/action-registry.js
src/runtime/actions/*
src/runtime/planner.js
src/runtime/action-loop*.js
```

For bundled `skills/*/SKILL.md` instruction packages, see `agrun_docs/agent-skills.md`.
For host-facing runtime/result/UI contracts, see:

- `agrun_docs/public-runtime-api.md`
- `agrun_docs/result-schema.md`
- `agrun_docs/webui-integration-contract.md`

## When Actions Are Used

`agrun.js` should converge on a single runtime loop.

The project no longer wants a separate `legacy skill loop` as a long-term architecture.
If current code still contains `legacy_*` naming or compatibility branches, treat those as transitional implementation details to be removed, not as the target design.

In the intended runtime model, the planner/action path is used for requests that require runtime-owned action selection, such as provider-driven or research-style turns.

In that route, the runtime runs:

```text
observe
orient
decide
act
evaluate
```

The `decide` phase is planner-driven.
The `act` phase executes one runtime action.

When bundled agent skills exist, the planner/action path may work through:

- `list_agent_skills`
- `read_agent_skill`
- `use_agent_skill`
- `handoff_to_skill`
- `execute_skill_tool`
- `web_search`
- `read_url`

## Boundary: Skill vs Action

Skills are capability modules selected by the skill router.

Actions are planner-facing runtime operations selected inside the unified runtime loop.

Keep the boundary explicit:

- skills use the skill contract in `agrun_docs/skill-system-architecture.md`
- actions use the action contract in this document
- skills are not actions
- actions are not registered as skills
- planner metadata belongs to actions, not to skills
- `read_url` is a runtime action, not a `src/skills/*.js` executable skill
- `read_url` may reuse browser-safe provider helpers under `src/skills/providers/*`, but that does not change its ownership boundary

## Planner Decision Contract

The planner must return exactly one JSON envelope.

Supported envelopes:

```json
{"type":"action","name":"list_agent_skills","args":{},"reasoning":"..."}
{"type":"action","name":"read_agent_skill","args":{"skillName":"expert-coder"},"reasoning":"..."}
{"type":"action","name":"use_agent_skill","args":{"skillName":"expert-coder"},"reasoning":"..."}
{"type":"action","name":"handoff_to_skill","args":{"skillName":"expert-coder","handoffContext":"Research complete. Implement the fix.","inputFilter":{"actionHistory":{"keepLast":3},"toolHistory":{"keepLast":0}}},"reasoning":"..."}
{"type":"action","name":"execute_skill_tool","args":{"toolName":"worldtime_now","args":{"timezone":"Asia/Tokyo"}},"reasoning":"..."}
{"type":"action","name":"web_search","args":{"query":"...","limit":5},"reasoning":"..."}
{"type":"action","name":"read_url","args":{"url":"https://example.com/article","mode":"html_text"},"reasoning":"..."}
{"type":"plan","actions":[{"type":"action","name":"execute_skill_tool","args":{"skillName":"report-skill","toolName":"count_rows","args":{}},"section":{"title":"## Count","prompt":"Write this result as a complete markdown section."}}],"synthesize_instruction":"Render the combined report.","synthesize_per_action":false,"partial_ok":false,"reasoning":"..."}
{"type":"clarify","question":"...","reasoning":"..."}
{"type":"final","answer":"...","citations":["..."],"reasoning":"..."}
```

Rules:

- `type: "action"` must name a registered action
- `type: "plan"` runs a batch of independent `type: "action"` envelopes in one planner cycle
- `args` must be an object when present
- `type: "clarify"` maps to the `ask_clarification` action at runtime
- `type: "final"` bypasses action execution and completes the run directly
- `list_agent_skills` exposes the bundled skill catalog
- `read_agent_skill` loads one bundled skill document into run state
- `use_agent_skill` activates the last-read bundled skill for the current run
- `handoff_to_skill` transfers phase ownership to another bundled skill, may trim history through `inputFilter`, and halts with `agent_handoff_cycle_detected` if the requested target already appears in `agentSkillContext.handoffChain`
- `execute_skill_tool` executes one browser-safe tool from the active bundled skill
- `web_search` gathers search summaries from the configured web search endpoint
- `read_url` reads one public `http/https` page directly when search summaries are not enough or the user provided a URL

### Plan Envelope

Use `type: "plan"` only when the planner already knows multiple independent actions that can run in parallel before one synthesis step.

Rules:

- `actions[]` must be non-empty and may contain only `type: "action"` envelopes
- nested plans, `final`, `finalize`, and `clarify` are not valid inside a plan
- `list_agent_skills`, `read_agent_skill`, `use_agent_skill`, and `handoff_to_skill` are planner-state mutators and are not valid inside a plan; run them as standalone actions before planning
- every action is validated up front against the same registry, disabled-action, policy, and action preflight checks used for single actions
- `execute_skill_tool` actions are preflighted against bundled skill/tool resolution and required tool args before any plan action runs
- any non-`allow` action policy rejects the whole plan; v1 does not support plan-level approval/resume
- `maxPlanActions` defaults to `10`; runtime config rejects values above the hard ceiling `20`
- actions execute with bounded parallelism from `maxPlanParallel` (default `8`)
- successful action outputs are written to `runState.toolContext.history` in declaration order, not completion order
- `partial_ok: false` rejects the whole plan on validation failure and returns execution failures to the planner without finalizing
- `partial_ok: true` records failed actions as structured error results and continues to synthesis
- `synthesize_instruction` replaces the default plan finalizer instruction
- `synthesize_instruction: "direct"` skips runtime finalize and continues to the next planner cycle
- if any planned `execute_skill_tool` result has `resultKind: "final"` with non-empty `markdown`, the existing direct-final path is used; when multiple planned actions do this, declaration order wins
- telemetry records `plan-validating`, `plan-validation-failed`, `plan-executing`, and `plan-executed`; per-action execution steps include `planIndex`

#### Per-Action Synthesize

Set `synthesize_per_action: true` when a long-form report should be synthesized section by section instead of with one large finalizer call.

Rules:

- every planned action must include `section.prompt`
- `section.title` is optional and falls back to `## Section N`
- each section synthesize call receives only the original user request, that action's result, and that action's section prompt
- `maxSectionParallel` controls bounded section synthesize concurrency and defaults to `4`
- a tool result with `resultKind: "final"` and non-empty `markdown` is used directly as that section markdown
- failed or empty section synthesize output becomes `<!-- section failed: reason -->` and the run continues
- optional `stitch.intro_prompt` and `stitch.outro_prompt` run as separate synthesize calls over compact action-result summaries
- optional `stitch.provenance`, `stitch.followups`, and `stitch.drill_hints` are appended after all sections
- `stitch.drill_hints` must be an array of objects with string `match_header`, `label`, and `prompt`
- section, intro, outro, and per-section direct-final markdown are stripped of `g3-followups` and `g3-drill-hints` fenced blocks before stitching; those UI extension blocks are stitch-level concerns
- section prompts must not ask the LLM to emit followups or drill hints; use `stitch.followups` and `stitch.drill_hints` for canonical UI extension metadata
- inline/table markers such as `[[show-percent]]` and `[[no-sum]]` are preserved in stitched markdown so host table renderers can process them after the final answer is emitted
- final markdown is stitched deterministically and emitted directly with `finalAnswerSource: "plan_synthesize"`; no legacy single-call finalize runs
- hosts should treat `plan_synthesize` as a normal final markdown answer and run the same post-processing pipeline used for `runtime_finalize`
- telemetry records `synthesize-per-action-start`, `synthesize-section-done`, and `synthesize-stitch-done`

## Action Definition Contract

Each action module should expose one small action object:

```text
name
description
tier
planner?
execute(context, args)
```

Field meaning:

| Field | Purpose |
| --- | --- |
| `name` | stable runtime identifier |
| `description` | short planner-facing description |
| `tier` | default policy tier |
| `planner` | planner metadata or `false` to hide from planner |
| `permission` | normalized permission metadata exposed to hosts, planner surfaces, and policy decisions |
| `execute` | perform the action |

### Permission Metadata Contract

Every action returned by `createActionRegistry()` is normalized with
permission metadata:

```js
{
  effect: "external_network",
  interruptBehavior: "abort_safe",
  isConcurrencySafe: true,
  isDestructive: false,
  isReadOnly: true,
  needsApproval: true,
  source: "built_in_metadata"
}
```

Rules:

- built-in actions use deterministic registry metadata as the first SSOT
- host-defined/dynamic actions may provide their own `permission` object before
  registration; missing fields fall back conservatively
- `actionRegistry.list()` and `actionRegistry.listForPlanner()` both expose
  the normalized `permission` object
- `evaluateActionPolicy()` returns the same permission snapshot with
  `{ action, actionName, tier, source, reason, permission }`
- default policy behavior is unchanged: explicit `actionPolicy` wins; otherwise
  tier `1`/`2` asks, tier `3` denies, and tier `0` allows
- `actionPolicy` entries may now be strings (`"allow"`, `"ask"`, `"deny"`) or
  reasoned objects such as `{ action: "allow", reason: "server_proxy_approved" }`
- optional `actionPermissionJudge` is only for dynamic/untrusted actions that
  lack trusted metadata; classifier errors or uncertainty fail closed to
  approval, not hidden execution
- optional `actionGuardrail` records repeated failure/no-progress facts as
  action steps and `loopState.actionGuardrail`; preflight blocks are mechanical
  repeat guards and the AI still owns the next recovery action
- permission metadata is observational and policy-supporting; it must not make
  the runtime invent task-specific AI decisions or hidden retries

### Planner Metadata Contract

`planner` may define:

```text
aliases
argsExample
argsSchema      (optional)
decisionType
guidance
```

Field meaning:

| Field | Purpose |
| --- | --- |
| `aliases` | planner repair aliases such as `search` -> `web_search` |
| `argsExample` | JSON example used in the planner system prompt |
| `argsSchema` | optional validation map `{ key: { type, required, aliases? } }`; checked via [`validateActionArgs()`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-args-validation.js) before execute. Missing required keys or type mismatches short-circuit into the self-correction loop with an `action-args-invalid` step. Actions without `argsSchema` are unaffected. Each entry may declare `aliases: string[]` — planner-emitted keys matching an alias are rewritten to the canonical name *before* required/type checks and *before* `execute()` is called (e.g. absorbs `documentNo` → `document_no` LLM drift). The same rewrite runs on the bundled-tool path via [`validateToolArgs()`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/actions/execute-skill-tool-action.js). Rewrites emit an `action-args-alias-rewrite` trace step. If both canonical and an alias are present with different values the canonical wins and the alias is dropped (collision flagged in trace). Alias rewriting is strictly opt-in per property — there is no global camelCase→snake_case fallback, so intentionally camelCase params (`pageSize`, `sortField`) are never touched unless listed. **Registration invariant:** `aliases` must survive both [`normalizeToolParameters()`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/agent-skills.js) (registration-level) and [`cloneToolParameters()`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/agent-skills.js) (compactor). Both call `copySchemaAliases()` on top-level and nested properties so the runtime schema matches the wire schema. |
| `argsSchemaOptOut` | explicit opt-out object `{ reason }` for planner-visible actions that intentionally have no schema. New planner-visible actions must declare either `argsSchema` or a non-empty opt-out reason; `planner:false` hidden actions are exempt. |
| `decisionType` | planner envelope kind, usually `action` or `clarify` |
| `guidance` | short instruction for when the action should be chosen |

Rules:

- planner metadata is part of the contract, not optional prompt decoration
- every planner-visible action must declare `argsSchema` or `argsSchemaOptOut.reason`; this is checked when the action registry is created
- `type:"plan"` actions use the same `validateActionArgs()` path as single actions before any action-specific `preflight` runs
- `action-args-invalid` step details are stable across single-action and plan paths: `{ actionName, key, reason, error }`; plan path also includes `planIndex`
- `actionRegistry.listForPlanner()` is the source of truth for planner-visible actions
- `actionRegistry.list()` is for public runtime state only

### Virtual Workspace Patch Contract

`workspace_propose_patch` and `workspace_apply_patch` are a two-step
mutation contract for risky long-report repair.

Rules:

- `workspace_propose_patch` is preview-only. It writes `runState.virtualWorkspace.pendingPatch` but does not change file content, file version, workspace version, or publish protocol.
- Patch v1 uses structured operations, not unified diff text:
  `replace`, `append`, `insert_after_section`, and `normalize_headings`.
- Valid operation shapes are:
  `append { content, separator? }`,
  `insert_after_section { heading, content, separator? }`,
  `replace { find, replace, replace_all? }`, and
  `normalize_headings { headings:[{ lineNumber, text }] }`.
- `replace` is an exact-current-text operation. It must not be used as
  `{ type: "replace", content: "full document" }`; that shape is
  preview-blocked and the AI should either provide `find` + `replace` or
  switch to `append` / `insert_after_section`.
- `normalize_headings` is for structure-only duplicate heading/section-number
  repair. The AI supplies `lineNumber` and replacement heading text; runtime
  only verifies that the line exists, is currently a Markdown heading, and that
  the preview does not worsen structure. Runtime must not choose the new
  heading text.
- The propose result exposes `patchId`, `baseVersion`, `beforeWords`,
  `afterWords`, `deltaWords`, `changed`, `status`, `riskFlags`, and
  `previewSummary`. Action output may include compact `structureBefore` /
  `structureAfter` summaries and a short `suggestion` for blocked previews. It
  must not expose the full preview text.
- Blocking `riskFlags` are `not_found`, `ambiguous`, `no_growth`, and
  `structure_maybe_worse`. AI must revise the patch or choose
  `workspace_append` / `workspace_insert_after_section` instead of
  finalizing when these appear.
- `workspace_apply_patch` applies only the latest valid pending patch. It
  refuses stale `baseVersion`, `patchId` mismatch, invalid previews, and
  previews whose stored hash no longer matches.
- Apply success records one workspace operation with
  `action: "apply_patch"`, increments the target file version, refreshes
  workspace quality/text stats, and clears `pendingPatch`.
- Runtime validates and applies AI-authored patch operations; runtime must
  not invent the patch content.
- During WMG hard-veto terminal repair, a blocked pending patch can
  temporarily remove `workspace_propose_patch` / `workspace_apply_patch`
  from the next action surface so the AI must use observable growth
  actions (`workspace_append` / `workspace_insert_after_section`) or an
  honest limited publish instead of repeating the same invalid preview.

### Native Tool Schema Contract

When `plannerMode: "native_tools"` is active, provider tool/function schemas are generated from the same planner action contract:

- `planner.argsSchema` is the first source of truth for OpenAI/Gemini native tool parameters
- `argsExample` is only a backward-compatible fallback for actions that do not expose `argsSchema`
- required fields in native tools come from `argsSchema[key].required === true`
- `web_search.query` and `read_url.url` remain optional in native tools because the runtime still has safe fallback behavior for those fields
- aliases are not included in native provider schemas; the provider should emit canonical keys, and runtime alias rewrite remains a defensive validation layer
- built-in planner tools `ask_clarification`, `finalize`, and `final_answer` keep their explicit internal schemas
- Gemini tool declarations reuse the OpenAI-style schema projection before converting stable JSON types (`object`, `array`, `string`, `number`, `boolean`) into Gemini format

This keeps envelope mode, native tools mode, single-action execution, and `type:"plan"` validation on one schema SSOT instead of drifting through separate required/type inference rules.

## Action Execute Contract

`execute(context, args)` must return:

```text
control
output
summary
```

Current shape:

```js
{
  control: "continue" | "complete",
  output: {},
  summary: "short trace string"
}
```

Rules:

- `control: "continue"` means the loop continues into another planner cycle
- `control: "complete"` means the action produces the terminal output
- `summary` should be short and readable for action history
- action modules should not mutate runtime state directly

## Action Context Contract

The current runtime passes a narrow action context:

```text
context
├ agentSkills
├ agentSkillContext
├ activeAgentSkill
├ request
├ runState
├ searchResults
├ toolContext
└ webSearchEndpoint
```

Rules:

- keep the context narrow
- add fields only when they are stable runtime capabilities
- do not pass the whole runtime object through to actions
- bundled agent skill actions should use `agentSkills` and `agentSkillContext` instead of reaching through runtime internals

## Bundled Skill Tool Rules

`execute_skill_tool` is a generic runtime action.
It is not one action per tool.

Rules:

- the planner must activate a bundled skill before calling `execute_skill_tool`
- `execute_skill_tool` may optionally include `skillName`, but it must match the active bundled skill when present
- the tool must exist in the active skill's bundled `tools.mjs`
- tool args must be an object
- required args must be present
- provided args should match the declared primitive type contract when `parameters.properties[*].type` is present
- successful tool execution returns `control: "continue"`
- the runtime writes the structured tool result into `runState.toolContext`
- `execute_skill_tool` is currently treated as a low-risk direct tool surface
- default policy for `execute_skill_tool` is `allow` because it is a tier `0` action
- hosts may still override `actionPolicy.execute_skill_tool` when they want stricter behavior
- **auto-heal for flattened args**: when smaller LLMs place tool parameters as siblings of `skillName`/`toolName` instead of nesting them inside `args.args`, the runtime automatically lifts any non-control keys (`skillName`, `toolName`, `args`, `reasoning`) into `toolArgs`. This prevents silent parameter loss. When `args.args` exists and is non-empty, auto-heal does nothing.
- **harness metadata passthrough (`resultKind` / `_meta`)**: tools may return `{ ..., resultKind: "resolution" | "evidence" | ..., _meta: {...} }`. The runtime hoists both fields onto the tool output envelope (alongside `kind`, `result`, `skill`, `tool`), so the planner sees them as first-class structured fields in `toolContext.lastResult` instead of buried inside `result`. Tools may also declare a default `resultKind` on their schema (`tool.resultKind`); the explicit per-call value wins. When `resultKind` is any declared non-terminal kind (`resolution`, `lookup`, `preparatory`, `intermediate`, `partial`, `other`), the runtime automatically skips the single-tool fast path (the call is treated as a preparatory step, not terminal evidence) and the built-in planner prompt tells the planner to continue with the next evidence-gathering call instead of finalizing. Omitting `resultKind` keeps fast-path-eligible (legacy default). AGRUN-115.
- **direct final tool results (`resultKind: "final"`)**: a trusted bundled tool may return `{ ok: true, resultKind: "final", markdown: "..." }` when the `markdown` field is already the canonical user-facing answer. The runtime skips the synthesize/finalize LLM call, emits `markdown` directly as `output.text`, sets `finalAnswerSource` / `terminalizedBy` to `direct_final`, and records a `direct-final-emitted` step with `reason: "direct-emit-final"`. Optional `provenance` is appended after the markdown. Optional `followups: string[]` and `drill_hints: array` are appended as `g3-followups` and `g3-drill-hints` fenced JSON blocks. Other fields such as `sections`, `date_range`, or `filters_applied` are not rendered by the runtime but remain preserved in `runState.toolContext.lastResult`. If `resultKind: "final"` is present but `markdown` is missing or empty, the runtime records `direct-final-skipped` and falls back to existing finalize behavior.

## Read URL Rules

`read_url` is a generic runtime action for direct page inspection.
It is not a general browser automation system and not a normal executable skill.

Rules:

- `read_url` is intended for the planner/action path on provider-backed or research-style turns
- the planner should prefer `read_url` when the user gives a URL directly or when `web_search` snippets are insufficient
- after `web_search` returns candidate result URLs, the runtime may automatically continue with up to 2 sequential `read_url` actions before finalizing
- `args.url` must be a valid public `http/https` URL
- if `args.url` is omitted, planner repair may populate it from the first URL in `request.prompt`
- supported methods are `GET` and `HEAD` only
- supported modes are `auto`, `text`, `html_text`, and `json`
- `auto` derives the mode from response content type
- non-text responses should fail with a structured `read_url_result` instead of returning binary content
- successful results should be written into `runState.researchContext.readSources`
- failed results should still be written into `runState.researchContext.readSources` with `ok: false`
- browser-safe adapters may attach optional screenshot evidence for downstream multimodal reasoning
- final answering should treat successful read sources as evidence, not as already-finalized user-facing prose
- when finalizing from research evidence, the runtime should expose source URLs in `output.citations` and may append a user-visible `Sources:` section to the answer text

Current default runtime limits:

- timeout: `10000ms`
- max body size: `200000` bytes

Current default planner-facing args shape:

```json
{
  "url": "https://example.com/article",
  "method": "GET",
  "mode": "html_text",
  "maxBytes": 200000,
  "timeoutMs": 10000,
  "headers": {
    "Accept-Language": "en"
  }
}
```

Current `read_url_result` shape:

```json
{
  "kind": "read_url_result",
  "ok": true,
  "url": "https://example.com/article",
  "status": 200,
  "statusText": "OK",
  "contentType": "text/html; charset=utf-8",
  "mode": "html_text",
  "text": "page body converted to text",
  "title": "Example Article",
  "screenshotDataUrl": "data:image/jpeg;base64,...",
  "screenshotMimeType": "image/jpeg",
  "bytes": 1234,
  "truncated": false
}
```

Failure shape notes:

- failures still use `kind: "read_url_result"`
- failures set `ok: false`
- failures may include `error`, `reason`, `message`, `platform`, `status`, and `url`
- screenshot evidence is optional and may be omitted entirely
- current failure categories include invalid URL, invalid method, HTTP errors, timeout, browser fetch/CORS failure, unsupported content type, blocked page, and empty readable content

## Policy Contract

Each action has a `tier`.

Default policy behavior:

- tier `0` -> `allow`
- tier `1` or `2` -> `ask`
- tier `3` -> `deny`

Runtime config may override this per action name.

## Result Ownership

Actions own their domain `output`.

The runtime owns:

- observation
- policy blocking state
- OODAE cycle records
- final result envelope
- structured failure records

That keeps action logic separate from runtime bookkeeping.
