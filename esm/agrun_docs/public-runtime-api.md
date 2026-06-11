# agrun.js Public Runtime API

## Purpose

This document defines the public host-facing runtime contract for `agrun.js`.

It is written for Web UI hosts, SDK wrappers, and debug tools that need a stable way to:

- create a runtime
- submit a turn
- inspect read-only runtime state
- consume structured results

For the returned result envelope, see [agrun_docs/result-schema.md](./result-schema.md).
For Web UI consumption and activity derivation, see [agrun_docs/webui-integration-contract.md](./webui-integration-contract.md).
For a tutorial-style entry point (concepts, install, real chatbot), see [agrun_docs/usage-quickstart.md](./usage-quickstart.md).
For every supported on/off knob in one page, see [agrun_docs/feature-toggles.md](./feature-toggles.md).
For a visual end-user flow map of the runtime, see [FLOWCHART.md](../FLOWCHART.md).

## Public Surface

The host-facing runtime standard is centered on these APIs:

```js
createRuntime(options)
runtime.run(input)
runtime.createSession(options?)
runtime.openSession(sessionId)
runtime.getState()
runtime.getMemory()
runtime.getRuntimeConfig()
runtime.getRuntimeConfigState()
runtime.getMessageStorageState()
runtime.reloadRuntimeConfig(optionsOrLoader, options?)
runtime.getAgentSkills()
runtime.getActionRegistry()
runtime.subscribeEvents(callback, options?)
```

The bundle also exports the crash-recovery serialization helpers
`exportState(input, options?)`, `importState(envelope)`, and the
`STATE_ENVELOPE_VERSION` constant (see **Crash Recovery** below), plus browser
provider adapters such as `openaiBrowserSkill`, `geminiBrowserSkill`, and
`deepseekBrowserSkill`. Deleted Set A skill-loop exports (`echoSkill`,
`fallbackSkill`, `memorySkill`, `newsBriefSkill`, `timeSkill`,
`webSearchSkill`) are not part of the v1.0.0 public surface.

## Runtime Creation

### `createRuntime(options)`

Creates one runtime instance.

Minimal shape:

```js
const runtime = createRuntime({
  skills: [openaiBrowserSkill]
});
```

### Options Contract

| Option | Required | Stability | Meaning |
| --- | --- | --- | --- |
| `skills` | no | stable compatibility | Provider adapter skills for the runtime instance, such as `openaiBrowserSkill`, `geminiBrowserSkill`, or `deepseekBrowserSkill`. Hosts may omit this when they only use runtime-owned actions, custom actions, or agent skill providers. |
| `memory` | no | stable | Custom append-only memory store with `readAll()` and `append()`. |
| `sessionStore` | no | stable | Async session persistence adapter for session history, summaries, and session-scoped memory. |
| `storage` | no | stable advanced | Optional per-message JSON storage adapter. When present, session turns are written as message records plus per-part records using the typed runtime event stream. Omit it to preserve current in-memory/browser Inspector behavior. |
| `onStorageError` | no | stable advanced | Optional callback for per-message storage write failures. Storage errors are recorded on `runtime.getMessageStorageState()` and do not crash the runtime. |
| `sessionPolicy` | no | stable | Session prompt-window and compaction policy such as `contextWindowTokens`, `compactAtTokens`, and `recentMessages`. |
| `compactionPolicy` | no | stable advanced | Host hook for in-flight provider history trimming: `{ maxTurns?, onCompact? }`. It does not rewrite persisted session messages. |
| ~~`fallbackSkill`~~ | no | removed in v1.0.0 | Legacy Set A skill-loop fallback. The option is ignored; register host behavior through `customActions` / `agentSkills` instead. |
| `maxSteps` | no | stable advanced | Upper bound for multi-cycle runtime execution. |
| `maxCostUsd` | no | stable advanced | Opt-in whole-run USD budget, same hard-stop class as `runDeadlineMs`/`maxSteps`. Requires `costPricing` (validated at `createRuntime` — without pricing the cost ledger never computes USD totals and the cap could never trigger). The action loop checks the ledger's already-recorded USD total at each cycle boundary: a one-time `cost-budget-warning` step fires at `costWarnRatio` of the cap (default 80%), and on breach the run returns a structured `COST_BUDGET_EXCEEDED` failure carrying `runState.costLedger` so the host sees exactly what was spent. Cost is never exposed to the AI/prompt; enforcement lives at the loop boundary and `cost-ledger.js` stays a pure recorder. |
| `costWarnRatio` | no | stable advanced | Fraction of `maxCostUsd` at which the one-time `cost-budget-warning` step fires. Default `0.8`. Must be strictly between 0 and 1 (at 1 the warning would coincide with the breach, at 0 it would fire on the first recorded cost); invalid values throw at `createRuntime`. The warning step detail carries the configured threshold as `warnRatio`. Inert when `maxCostUsd` is unset. |
| `hostHookTimeoutMs` | no | stable advanced | Defense-in-depth timeout (default `10000`) racing the awaited loop-scope host hooks — `onPlannerDecision`, `onToolResult`, `onInvalidPlannerOutput`, `onBeforeFinalize`. A hook that exceeds the budget is ignored (the run proceeds with the original value; a debug log records the timeout) so a hung host callback can never freeze the run. Code inside `action.execute()` (including output guardrails run by workspace publish) is already covered by the per-action timeout race; the non-awaited `onCheckpoint` cannot block by construction. Invalid values fall back to the default. |
| `historyCompaction` | no | stable advanced | Prompt-side compaction of the action-loop history block: `{ triggerTokens = 4000, protectHeadEntries = 5, protectTailEntries = 15, enabled = true }`. When the projected planner-prompt history crosses `triggerTokens` (~4 chars/token), entries between the protected head and tail are folded into an observer-LLM observation log rendered as `Earlier steps (compressed observations):`, with one `history-compaction` step recorded (`{ mode: "observer" \| "fallback", entriesCompacted, approxTokensBefore, approxTokensAfter }`). The in-memory `session.actionHistory` always stays FULL — only the prompt projection is compacted, so denied-action/failure/budget/drift consumers are unaffected. Observer failure degrades to a mechanical `[N earlier steps omitted — compaction unavailable]` marker and the run continues. Under the threshold the prompt is byte-identical; `enabled: false` restores the full raw history block exactly. Invalid values throw at `createRuntime`. |
| `maxPlanActions` | no | stable advanced | Maximum number of actions allowed in one planner `type: "plan"` envelope. Defaults to `10`; hard ceiling is `20`. |
| `maxPlanParallel` | no | stable advanced | Maximum concurrent actions inside one planner `type: "plan"` envelope. Defaults to `8`. |
| `maxSectionParallel` | no | stable advanced | Maximum concurrent section synthesize calls for `type: "plan"` with `synthesize_per_action: true`. Defaults to `4`. |
| `actionPolicy` | no | stable advanced | Per-action policy overrides for planner/action execution paths. |
| `actionPermissionJudge` | no | experimental advanced | Optional classifier for dynamic/untrusted actions that lack trusted permission metadata. Disabled by default. When enabled and uncertain/failing, the decision fails closed to the normal approval flow. |
| `actionGuardrail` | no | experimental advanced | Optional repeated-action/no-progress guardrail state. Emits observable loop signals and optional preflight blocks for exact repeated failures; it does not write task content or choose recovery actions. |
| `disabledActions` | no | stable advanced | Array of action names to permanently exclude from the planner surface (e.g., `["read_url"]`). Merged with per-run `disabledActions` from `runtime.run(input, { disabledActions })`. |
| `agentSkills` | no | stable advanced | Agent instruction packages to expose to planner/action flows. Omitted means `[]` in core: a generic loop with no domain skills. |
| `agentSkillIndexProvider` | no | stable advanced | Manifest-first agent skill provider with `listManifests()`, `getManifest()`, and `loadSkill()` for lazy full-skill loading. Takes priority over `agentSkills` when provided. |
| `skillCatalogTopK` | no | stable advanced | Number of ranked skill manifests exposed to the planner when the catalog is larger than this value. Defaults to `10`; `0` hides skill candidates from the planner prompt. |
| `skillCatalogMaxK` | no | stable advanced | Hard ceiling for `skillCatalogTopK`. Defaults to `30`; host values above this are clamped. |
| `skillCatalogRanker` | no | stable advanced | Optional custom ranker hook for replacing the built-in deterministic lexical skill ranking. |
| `skillPolicy` | no | stable advanced | Skill/tool-level allow/ask/deny and availability gate. Filters denied skills before Top-K and uses the existing approval flow for ask-gated `execute_skill_tool`. |
| `virtualWorkspace` | no | stable advanced | Browser-safe virtual draft workspace for complex final responses. `false` disables it; `{ enabled: true }` forces it; default `{ enabled: "auto" }` enables workspace state for complex/long-run prompts without exposing chain-of-thought or touching real files. |
| `longResearchQualityGate` | no | stable advanced | Compatibility alias for long-run research quality observation settings. Supports report-loop values such as `minReadSources`, `minRelevantSources`, `maxResearchLoopVetoes`, and `allowFinalWithLimitationsOnBudgetExhausted`; these surface diagnostic signals and do not install kernel-seam hooks or force report quality. |
| `repoFileTools` | no | stable advanced | Optional host-provided read-only repo/file adapter. Disabled by default; when `{ enabled: true, readFile, search }` is provided the planner can use tier-1 `repo_read_file` and `repo_rg`, which still pass through `actionPolicy`. |
| `plannerMode` | no | stable advanced | Planner decision encoding: `"auto"` (default), `"envelope"`, or `"native_tools"`. Since ADR-0031 (2026-05-16), `"auto"` and any omitted/unknown value resolve to `effectiveMode: "envelope"` with `reason: "default_envelope"`. `"envelope"` is the canonical PASS path; `"native_tools"` is an explicit advanced/debug opt-in only and was demoted from default after sustained Gemini-side native instability during long-running real-API live tests. |
| `nativeToolsFailurePolicy` | no | stable advanced | Native planner failure behavior when the effective planner mode is `"native_tools"`. Default `"fallback_to_envelope"` emits `planner-native-tools-fallback` and retries the same cycle through envelope mode. `"hard_fail"` emits `planner-native-tools-failed` and returns the provider/planner failure without envelope fallback. |
| `selfCorrection` | no | stable advanced | LLM self-correction on action errors. `true` (default), `false`, or `{ enabled, maxRetries }`. |
| `circuitBreaker` | no | stable advanced | Per-provider circuit breaker. `true` (defaults: 5 failures, 60s cooldown), `false` (default, disabled), or `{ threshold, cooldownMs }`. Fast-fails provider calls when a provider is consistently down. |
| `providerRetry` | no | stable advanced | Bounded retry for **transient** provider errors (timeout / rate-limit / network / 5xx) on the non-streaming completion path. `{ maxRetries, backoffMs }`, default `{ maxRetries: 1, backoffMs: 500 }` (linear backoff, retries capped at 5); `{ maxRetries: 0 }` disables. Streaming calls are never retried (emitted tokens cannot be unemitted). The circuit breaker stays authoritative: every failed attempt records a breaker failure and an open breaker stops the retry loop. A successful retried call carries `providerRetries` on the result and in the `planner-responded` step. |
| `providers` | no | stable advanced | Register host LLM providers, keyed by name: `{ "my-llm": { complete, stream?, normalizeRequest? } }`. `complete(options, fetch)` and the optional `stream(options, fetch, onToken)` return `{ text, usage, raw, status }` — the same contract the built-ins use (omit `stream` and the runtime falls back to `complete`, emitting the full text as one delta). Custom entries dispatch through the same path as `openai`/`gemini`/`deepseek`, so they get the circuit breaker, per-call timeout, and error attribution — unlike the private per-run `transport` seam. Return `usage` with camelCase keys (`inputTokens`/`outputTokens`/`totalTokens`) so `costPricing`/`maxCostUsd` work for custom providers. Built-in names cannot be overridden; a bad entry shape throws at `createRuntime`. See [provider-registry-design.md](./provider-registry-design.md). |
| `toolCallExamples` | no | stable advanced | Array of `{ skillName, toolName, args }` objects shown as envelope examples in the planner prompt. Helps the model produce correct `execute_skill_tool` format on the first attempt, avoiding repair cascade retries. |
| ~~`singleToolFastPath`~~ | _(removed in ADR-0026)_ | — | Removed in ADR-0026 along with `maybeApplySingleToolFastPath` to satisfy the harness-as-tool-provider invariant. Pre-ADR-0026 default was `true` (skip the 2nd planner cycle after a successful first `execute_skill_tool` call). Now the runtime always lets the AI plan cycle 2 — AI sees the tool result and emits `finalize` (yields `planner_finalize`) or another action. To preserve old behavior, wire `onToolResult` and call your own finalize path. The option is silently ignored if still passed. `resultKind: "final"` direct-emit (with markdown) is unchanged: tool-authored finalize is not push-mode. |
| `preferFinalizeOnLastResult` | no | stable advanced | Boolean (default `true`). Controls the built-in planner prompt line that tells the planner to prefer `finalize` when `toolContext.lastResult` is populated. Set `false` to drop that line entirely (useful when the caller's `plannerDirectives` provide their own guidance). |
| `plannerDirectives` | no | stable advanced | `string[]` (default `[]`). Caller-supplied planner system-prompt lines appended **after** all built-in lines. Because LLMs give more weight to recent instructions, these override earlier built-in directives without editing runtime source. Per-run `plannerDirectives` append after runtime-level lines by default, or replace them with `plannerDirectivesMode: "replace"`. |
| `defaultRunOptions` | no | stable advanced | Default run options merged into every `runtime.run()` and `session.run()` call. Supports `onStep`, `onToken`, `onStreamEvent`, `onInvalidPlannerOutput`, `onPlannerDecision`, `onToolResult`, `onBeforeFinalize`, `onCheckpoint`, `disabledActions`, `plannerDirectives`, `plannerDirectivesMode`, and `abortSignal`. Per-run options are merged on top; hooks compose rather than replacing each other. |
| `researchCoverageGuard` | no | stable advanced | Research/source coverage guard config. Pass `{ enabled: false }` to disable research coverage vetoes for hosts that use only internal/tool-backed evidence. |
| `citationCoverageGuard` | no | stable advanced | Direct-source citation coverage guard config. Pass `{ enabled: false }` to disable citation coverage vetoes for hosts that do not require web/source-backed answers. |
| `threads` | no | stable advanced | Thread routing config. `threads.intentClassifier(payload)` may return `kind: "new_task" \| "follow_up" \| "drill_down" \| "unknown"` plus existing router hints such as `targetThreadId`; `new_task` is authoritative for current-turn goal anchoring and prevents weak token overlap from inheriting the previous goal. |
| `debug` | no | stable | Debug logging mode. `true` for console output, or `(event) => {}` for custom handler. Zero overhead when disabled. |
| `role` | no | stable advanced | Agent role/persona. Object `{ name, instructions, description?, priority? }`, result of `parseRoleMarkdown(text)`, or a string name resolved against `agentRoles` supplied by the host or an opt-in skill pack. See **Role Configuration** below. |

### Runtime Config Lifecycle

`createRuntime()` now keeps runtime config behind a small lifecycle controller.
The default path is unchanged: config is normalized once at creation and every
run uses that ready snapshot.

Advanced hosts may call:

```js
runtime.getRuntimeConfigState();
await runtime.reloadRuntimeConfig({ maxSteps: 12 });
```

`getRuntimeConfigState()` returns:

```js
{
  status: "ready" | "reloading" | "error",
  revision: 1,
  pendingReloadId: null,
  lastError: null
}
```

`reloadRuntimeConfig()` accepts either a partial options object or an async
loader function:

```js
await runtime.reloadRuntimeConfig(async ({ currentOptions, revision, signal }) => {
  const next = await fetch("/runtime-config.json", { signal }).then((r) => r.json());
  return {
    ...next,
    skills: currentOptions.skills
  };
});
```

Rules:

- partial reloads shallow-merge into the previous creation options, so required
  options such as `skills` are preserved unless `replace: true` is passed
- stale or aborted reloads cannot overwrite a newer ready config
- future `runtime.run()` and newly created/opened session handles read the
  latest runtime config snapshot
- existing session handles keep their already-created handle state; use a new
  session handle when testing a reload-sensitive session flow
- session-store replacement is intentionally not part of this first lifecycle
  slice; create a new runtime when the storage backend itself changes

#### Role Configuration

Three ways to set the agent role:

1. **Role by string name** — resolves against the `agentRoles` array supplied by the host or an opt-in package such as `@agrun/skills-research` / `@agrun/skills-coder`. Core no longer defaults to a bundled role catalog.

```js
import { bundledAgentRoles } from '@agrun/skills-research';

createRuntime({ agentRoles: bundledAgentRoles, role: 'researcher', skills: [...] });
```

2. **Inline object** — define role directly without any file dependency.

```js
createRuntime({
  role: {
    name: 'erp-support',
    instructions: 'You are an ERP support specialist...',
    description: 'ERP system support agent',
    priority: 'research'
  },
  skills: [...]
});
```

3. **parseRoleMarkdown(text)** — parse a ROLE.md-formatted string from any source (fetch, file, user input). This is the recommended approach for web-based applications that want to load roles dynamically without rebuilding.

```js
import { parseRoleMarkdown } from 'agrun';
const role = parseRoleMarkdown(markdownText);
createRuntime({ role, skills: [...] });
```

**HTML / browser example** — fetch a ROLE.md file and create a runtime with it:

```html
<script src="dist/agrun.js"></script>
<script>
  // Fetch any ROLE.md file at runtime
  const markdown = await fetch('./roles/globe3-erp-support.md').then(r => r.text());
  const role = Agrun.parseRoleMarkdown(markdown);
  const runtime = Agrun.createRuntime({ role, skills: [Agrun.openaiBrowserSkill] });

  // Use the runtime
  const result = await runtime.run({
    provider: 'openai',
    apiKey: window.OPENAI_KEY,
    model: 'gpt-5-mini',
    prompt: 'What modules does Globe3 ERP have?'
  });
  console.log(result.output);
</script>
```

#### Skill Loading

Four ways to provide agent skills:

1. **Core default: no domain skills** — when `agentSkills` is omitted, core normalizes it to `[]`. The planner still receives built-in actions; it just sees no domain skill instruction packages. This is the current generic runtime default.

   ```js
   import { createRuntime } from 'agrun';
   import { bundledAgentSkills as researchSkills } from '@agrun/skills-research';
   import { bundledAgentSkills as coderSkills } from '@agrun/skills-coder';

   createRuntime({ agentSkills: [] }); // no domain skills
   createRuntime({ agentSkills: researchSkills });
   createRuntime({ agentSkills: [...researchSkills, ...coderSkills] });
   ```

2. **parseSkillMarkdown(text)** — parse a SKILL.md-formatted string into a skill object. Same frontmatter convention as ROLE.md (`name`, `description` in YAML frontmatter, markdown body as instructions).

```js
import { parseSkillMarkdown, createRuntime } from 'agrun';
const skill = parseSkillMarkdown(markdownText);
createRuntime({ agentSkills: [skill], skills: [...] });
```

3. **loadAgentSkills(manifestUrl)** — fetch a JSON manifest and load all listed SKILL.md files. Returns an array of parsed skill objects. Failed fetches are skipped with a warning.

```js
import { loadAgentSkills, createRuntime } from 'agrun';
const skills = await loadAgentSkills('/skills/manifest.json');
createRuntime({ agentSkills: skills, skills: [...] });
```

**Manifest format** — paths are resolved relative to the manifest file location:

```json
{
  "skills": [
    "module-a/SKILL.md",
    "module-b/SKILL.md",
    { "skill": "module-c/SKILL.md", "tools": "module-c/tools.mjs" }
  ]
}
```

String entries load SKILL.md only. Object entries with `tools` also dynamically import the tools module via `import()`.

4. **agentSkillIndexProvider** — provide a manifest-first catalog without loading every full `SKILL.md` document at startup. This is the AGRUN-214a minimum scalable-skill contract.

```js
import { createRuntime } from 'agrun';

const runtime = createRuntime({
  agentSkillIndexProvider: {
    listManifests() {
      return [
        {
          skillId: "sales.invoice_analyzer",
          name: "invoice-analyzer",
          description: "Analyze sales invoices.",
          tools: []
        }
      ];
    },
    getManifest(skillIdOrName) {
      return findManifest(skillIdOrName);
    },
    async loadSkill(skillIdOrName) {
      return loadFullSkillWithInstructionsAndTools(skillIdOrName);
    }
  },
  skills: [...]
});
```

Provider methods may be sync or async. `SkillManifest` contains `skillId`,
`name`, `description`, `sourcePath`, `tools`, `version`, `checksum`, optional
`category`, optional `namespace`, optional `tags`, and optional `inputTypes`.
`tools[]` contains non-executable summaries only; executable `func`
implementations belong to the full skill returned by `loadSkill()`.
`instructions` belongs only to the full skill returned by `loadSkill()`.
Existing `agentSkills: []` arrays are adapted through an in-memory provider, so
small catalogs keep working unchanged.

Opt-in research skill examples include `web-research` for short source-backed
search or URL/article review and `long-web-research` for long-running topic
research that needs a plan, multiple search/read cycles, evidence tracking, gap
checks, and a structured final report. Both are manifest summaries until the
runtime lazily loads the selected `SKILL.md`.

Long-running research uses `runState.researchWorkspace` as a virtual workspace
for the plan, search log, source notes, draft outline, and final readiness. The
workspace is debug/support metadata, not final-answer content. Final-answer
normalization and quality checks treat headings such as `Research Workspace
Progress`, `Evidence Notes`, and `Gap Check` as internal leakage and remove or
repair them before terminal output. Hosts should render the workspace in
Inspector/debug surfaces, while end users should receive only the final report,
limitations, and sources. For long-run research with weak or incomplete
evidence, the runtime finalizer prompt asks for honest limitations and scoped
sources, but runtime terminal normalization does not rewrite the report into a
final answer with explicit limitations or insert source-quality / evidence-gap diagnostics. Those
diagnostics stay in Inspector/support metadata. Browser example turns run the
same user-facing cleanup before storing the assistant message, keeping
visible/copyable end-user text aligned with the runtime final output.
Single-topic source selection applies prompt-focus filtering to read-url
sources as well as search fallback sources, so unrelated generic pages are not
promoted to final citations.

Complex response drafting can also use `runState.virtualWorkspace`. This is a
generic browser-safe, pure-JS workspace with fixed artifact files. It stores and
edits text artifacts in runtime state; it does not read/write real files and does
not execute Node.js or Python code by itself:

```text
outline.md
evidence.json
draft.md
critique.md
final_candidate.md
```

The planner-facing actions are `workspace_list`, `workspace_read`,
`workspace_write`, `workspace_replace`, `workspace_insert_after_section`,
`workspace_remove`, `workspace_move`, `workspace_multi_edit`,
`workspace_propose_patch`, `workspace_apply_patch`,
`workspace_finalize_candidate`, and `workspace_publish_candidate`.
They mutate only `runState.virtualWorkspace`; they do not read or write real
filesystem paths. Path validation rejects absolute paths, `../`, backslashes,
and unknown filenames.

**`workspace_move`** — single-step rename: `{from, to, summary?, overwrite?}`.
Returns `{moved, status, fromFile, toFile}`. Observable failures:
`source_not_found` (source empty), `target_exists` (destination has content and
`overwrite` not set), `same_path`.

**`workspace_multi_edit`** — batch `replace` / `insert_after_section` operations
on one or more files in a single OODAE cycle: `{operations: [{action, path,
...op-args}], summary?, atomic?: false}`. With `atomic:true` any failure rolls
back all changes. Returns `{status, results: [{index, status, file,
contextSnippets?, availableHeadings?}], succeededCount, failedCount}`.

The final-answer scrubber removes internal virtual workspace headings such as
`Virtual Workspace`, `Workspace Draft`, `Workspace Operations`, `Critique Notes`,
and `Final Candidate` from user-facing output. Browser Inspector, Debug Report,
and Support Bundle expose sanitized workspace file summaries, operation
summaries, and quality checks for QA.

If a host wants the agent to inspect real project files, use `repoFileTools`
instead of expanding the virtual workspace. `repoFileTools` is disabled unless
the host explicitly injects read-only adapter functions:

```js
const runtime = Agrun.createRuntime({
  actionPolicy: {
    repo_read_file: "ask",
    repo_rg: "ask"
  },
  repoFileTools: {
    enabled: true,
    rootDir: "/project",
    async readFile({ path, maxFileChars }) {
      // Host resolves path under rootDir and returns { ok, text }.
    },
    async search({ query, glob, maxResults }) {
      // Host returns { ok, matches: [{ path, line, column, text }] }.
    }
  }
});
```

Runtime validation only accepts relative forward-slash paths under the host
adapter boundary and rejects absolute paths, parent segments, empty path
segments, and backslashes. Output is capped before it enters action history.
These tools are read-only and tier `1`; without explicit `actionPolicy` they
use the same approval behavior as other tier-1 actions.

Node/server hosts can reuse the optional helper without adding Node built-ins
to the browser bundle:

```js
const { createNodeRepoFileTools } = require("./node/repo-file-tools.cjs");

const runtime = Agrun.createRuntime({
  actionPolicy: {
    repo_read_file: "ask",
    repo_rg: "ask"
  },
  repoFileTools: createNodeRepoFileTools({
    rootDir: process.cwd()
  })
});
```

The helper reads files through `fs` and searches with `rg --json`. If `rg` is
not installed, search returns `{ ok: false, error: "rg_not_found" }` rather
than falling back to a slow recursive scanner.

`allowPaths` and `denyPaths` can be provided to both `repoFileTools` and
`createNodeRepoFileTools()`. `allowPaths` is optional; when present, files/globs
must match it. The denylist is always merged with default secret-file patterns
such as `.env*`, secret/credential names, private-key names, and SSH identity
filenames. Future write tools are design-only in
[`repo-file-write-tools-design.md`](./repo-file-write-tools-design.md); this
slice exposes no real mutation action.

For source-backed final answers, agrun appends canonical `Sources:` from
structured evidence rather than trusting model-written source blocks. Single
topic research uses a relevance guard: fallback search-result sources must match
distinctive prompt terms such as a quoted topic, handle, or product name before
they can become final citations.

For `long-web-research`, agrun also tracks `runState.researchState`. This is a
runtime-owned research quality snapshot with `phase`, `sourceQuality`, `gaps`,
`finalAllowed`, and `finalReason`. These fields are observations for the AI,
Inspector, and host diagnostics. They are not runtime-owned research policy, and
they do not reintroduce the deleted kernel-seam hook enforcement.

Long-run research runs also expose `runState.researchWorkspace`. This is a
safe virtual workspace with the research brief, questions, search log, source
notes, evidence table, draft outline, timeline, and final-readiness reason. It
is designed for Inspector/debug/progress UI and for finalizer context. It is not
chain-of-thought and should not be rendered as the final answer.

5. **loadSkillIndexProvider(manifestUrl)** — create a manifest-first provider
from a static skills folder. This is the AGRUN-214c scalable browser path.

```js
import { createRuntime, loadSkillIndexProvider } from 'agrun';

const provider = await loadSkillIndexProvider('/skills/manifest.json');

const runtime = createRuntime({
  agentSkillIndexProvider: provider
});
```

`loadSkillIndexProvider()` fetches only `manifest.json` during setup. It does
not fetch every `SKILL.md` at startup. `listManifests()` and `getManifest()`
serve summaries from the manifest; `loadSkill(skillIdOrName)` fetches and
parses the selected full skill and optional `toolsPath` module on demand.

The provider caches loaded skills by `skillId + version + checksum +
sourcePath + toolsPath`. If `refreshManifests()` sees changed `version` or
`checksum`, the next `loadSkill()` call re-fetches the full skill. Failed
lazy-loads return `null` and log a safe warning.

#### Skill Catalog Top-K

Before each planner call, agrun ranks skill manifests against the current user
prompt and exposes only the Top-K candidates to the planner prompt when the
catalog is larger than `skillCatalogTopK`.

Defaults:

```js
createRuntime({
  skillCatalogTopK: 10,
  skillCatalogMaxK: 30
});
```

The built-in ranker is deterministic and browser-local. It scores `name`,
`tags`, `tools[].name`, `description`, `tools[].description`, and `inputTypes`.
No Fuse.js, MiniSearch, embedding service, or remote search dependency is used.

Hosts can replace the scorer:

```js
createRuntime({
  skillCatalogRanker({ prompt, manifests, topK, maxK }) {
    return {
      manifests: manifests.slice(0, Math.min(topK, maxK)),
      matches: []
    };
  }
});
```

Top-K is not a permission gate. It only limits what the planner sees in the
current prompt; `read_agent_skill`, `use_agent_skill`, and `execute_skill_tool`
still resolve through `agentSkillIndexProvider`.

The 1000-skill regression harness uses deterministic fake manifests to guard
that only Top-K candidates enter planner context, duplicate tool names require
an explicit skill id/name, and local ranking/provider/policy hot paths stay
within the documented thresholds in `agrun_docs/agent-skills.md`.

#### Skill Policy and Availability

`skillPolicy` gates specific skills/tools without changing `actionPolicy`.
Default is compatibility-first: omitted policy means existing behavior remains
allowed.

```js
createRuntime({
  agentSkillIndexProvider: provider,
  skillPolicy: {
    skills: {
      "web-research": "allow",
      "dangerous-admin": "deny"
    },
    tools: {
      "web-research.search_web": "allow",
      "web-research.read_url": "ask"
    },
    availability: {
      browser: true,
      network: true,
      inputTypes: ["text"],
      features: ["web-search", "read-url"]
    }
  },
  skills: [...]
});
```

`"deny"` removes a skill from planner Top-K and `list_agent_skills`; explicit
read/use/execute attempts fail closed with sanitized policy details. `"ask"` is
visible/readable/activatable, but `execute_skill_tool` returns
`output.kind === "approval_required"` and resumes through the existing approval
contract after host approval. Manifest `riskTier` maps to `allow` for `0`/unset,
`ask` for `1`/`2`, and `deny` for `3`; explicit host `skills` / `tools` policy
overrides manifest tier. Availability checks use `requires`, `browser`,
`network`, `inputTypes`, and feature flags.

**HTML / browser example:**

```html
<script src="dist/agrun.js"></script>
<script>
  const skills = await Agrun.loadAgentSkills('./skills/manifest.json');
  const runtime = Agrun.createRuntime({
    agentSkills: skills,
    skills: [Agrun.openaiBrowserSkill]
  });
  const result = await runtime.run({
    provider: 'openai',
    apiKey: window.OPENAI_KEY,
    model: 'gpt-5-mini',
    prompt: 'Help me write a function'
  });
  console.log(result.output);
</script>
```

This allows engineers to build web-based agents by simply writing a ROLE.md file and loading it via `<script>` — no build step required. See `examples/html-role-loader/` for a working demo.

Role object shape: `{ name: string, instructions: string, description?: string, priority?: string }`.

Legacy note:
- `sessionPolicy.maxPromptTokens` is still accepted as a compatibility alias for `compactAtTokens`.

### `compactionPolicy`

`compactionPolicy` customizes the history window that `session.run()` sends to provider-backed turns.

```js
const runtime = createRuntime({
  compactionPolicy: {
    maxTurns: 20,
    onCompact: async (history, context) => history.slice(-10)
  }
});
```

Rules:

- `maxTurns` keeps the most recent turn-id groups before provider prompt construction.
- `onCompact(history, context)` receives a cloned history array and may return a replacement array.
- Returned history affects only the current prompt/session-context view; durable session messages stay unchanged.
- Existing summary compaction and `filterByThreadWindow` still protect run-state evidence windows.

When built-in summary compaction refreshes a summary, agrun also records a hidden real session turn:

- A hidden user message marks the compaction boundary.
- A hidden assistant message stores the compacted summary text.
- The pair has `kind: "compaction"`, `hidden: true`, and shares one synthetic compaction `runId` / `turnId`.
- Provider prompt construction ignores prior compaction pairs and keeps using the summary store as the prompt prefix.
- Existing `onStep({ type: "compaction-completed" })` compatibility remains unchanged.
- Typed event subscribers receive `compaction.started` and `compaction.completed` events for the same runtime sequence stream.

Live-provider verification can use
`node test/node-agrun-3000-live.mjs --simulate-overflow` (or
`npm run test:live:node-overflow`). That harness creates a real
provider-backed session, forces session summary compaction before the
long report turn, and asserts monotonic compaction events plus persisted
Node FS storage records. It verifies the session compaction boundary; it
does not change direct `runtime.run()` semantics or Browser Inspector.

### Runtime Instance Guarantees

- A runtime instance owns its own `lastRun` summary.
- A runtime instance owns its own memory store reference.
- A runtime instance may own many persistent sessions.
- `getState()` and `getMemory()` are read-only host access points.
- The host should treat one runtime instance as one conversational engine context.
- `runtime.subscribeEvents()` observes the runtime instance's typed event stream across direct runs, sessions, and subagent runs that share the same runtime.
- `runtime.getMessageStorageState()` reports whether optional per-message storage is enabled plus recent storage errors.

## Run Entry Contract

### `runtime.run(input, options?)`

Runs one normalized turn and resolves to a structured result envelope.

The standard assumes one canonical runtime loop with clear extension points.
Current implementation details such as `tool_loop`, `skill_loop`, or internal router branches are not the public control surface.
The current implementation now enters through one `runtime.run(input)` execution path for normal skills, provider/action turns, and approval-resolution turns.

### Run Options

The second argument is an optional options object for callbacks and per-run overrides.

| Option | Required | Stability | Meaning |
| --- | --- | --- | --- |
| `onStep` | no | stable | Callback for discrete phase events (planner, action, observation). Fires on each step boundary. |
| `onToken` | no | stable | Callback for token-level streaming during finalize. Receives string deltas as the final answer is generated. |
| `onStreamEvent` | no | experimental advanced | Callback for normalized streaming events from provider and action execution paths. Event types include `provider-stream-start`, `provider-text-delta`, `provider-stream-finish`, `provider-stream-error`, `action-executing`, `action-executed`, and `action-error` (kebab-case since ADR-0055; the event `mode` field distinguishes stream events from their step twins). |
| `onInvalidPlannerOutput` | no | stable advanced | `async (rawText, parseError, runState) => decision \| null \| undefined`. Invoked after parser/soft validation fails and before the repair LLM call. Return a valid planner envelope to use it and skip repair; return `null`/`undefined` to fall through to the normal repair cascade. Hook errors are swallowed like other hooks. |
| `onPlannerDecision` | no | stable | `async (decision, runState) => decision \| undefined`. Invoked after each planner decision, before execution. Return a replacement object to rewrite the decision, or `undefined` for passthrough. |
| `onToolResult` | no | stable | `async (output, { actionName, decision, runState }) => output \| undefined`. Invoked after a successful `execute_skill_tool` call, before the output becomes `toolContext.lastResult`. Return a replacement to augment / rewrite, or `undefined` for passthrough. |
| `onBeforeFinalize` | no | stable | `async (runState, { source }) => { continue: true, observation? } \| null`. Invoked before every terminal path. `source` distinguishes them: `plan_finalize` (plan actions completed, before per-action synthesis), `planner_finalize` (planner `type:"finalize"` decision), `planner_final` (planner `type:"final"` direct answer), `direct_final` (a tool returned `resultKind:"final"` with markdown — both the skill-tool path and a plan action). Return `{ continue: true, observation }` to veto the terminal and continue the action loop; the observation is injected into action history, `runState.observation`, and a `finalize-vetoed-by-host` step. Return `null`/`undefined` to allow. A throwing hook is logged and ignored — the AI decision proceeds. Note: the hook had been plumbed but uninvoked between the 2026-06-09 finalize-contract seam removal and AGRUN-457 (2026-06-10), when all four sources were wired. ADR-0026: the legacy `single-tool-fast-path` and `consecutive-failure-guard` sources are gone — those were runtime push paths and have been deleted. |
| `disabledActions` | no | stable | Array of action names to exclude from this run's planner surface. Merged with runtime-level `disabledActions`. |
| `plannerDirectives` | no | stable advanced | Per-run planner directive lines. Default behavior appends them after runtime-level `plannerDirectives` for this call only. |
| `plannerDirectivesMode` | no | stable advanced | `"append" \| "replace"`; default `"append"`. `"replace"` uses only the per-run `plannerDirectives` for this call, then the runtime may still append internal one-shot reminders such as drift guidance. |
| `abortSignal` | no | stable | Standard `AbortSignal`. When the caller aborts (e.g. user clicks **Stop**), the runtime cancels the in-flight LLM fetch, suppresses any further `onStep` / `onToken` callbacks, and rejects the `run()` promise with an `AbortError` (`error.name === "AbortError"`, `error.code === "ABORT_ERR"`). See **Caller Cancellation** below. |
| `onCheckpoint` | no | stable advanced | `(envelope) => void`. Fires at each cycle boundary with `exportState(runState)` — a versioned, redacted (no `apiKey`), `JSON.stringify`-safe checkpoint the host persists for crash recovery. Best-effort and isolated like `onStep`: a throwing callback never breaks the run. See **Crash Recovery** below. |
| `resumeState` | no | stable advanced | A runState returned by `importState(envelope)`. The loop continues from the checkpointed `cycleCount` (completed cycles are not re-run) instead of a fresh state, restoring cost ledger, virtual workspace, todo/research/OODAE, and pending approval. The host re-supplies `apiKey` in the run input. Does NOT restore per-turn `actionHistory` / conversation — compose with `openSession(id)` for full continuity. See **Crash Recovery** below. |

Hook errors are swallowed (logged in debug mode) — a throwing hook will never crash the run.

### Crash Recovery (`exportState` / `importState` / `resumeState` / `onCheckpoint`)

For long runs in a crash-prone host (a browser tab, a killable process), the
runtime can checkpoint its in-flight state and resume from it. Design:
[run-state-export-import-design.md](./run-state-export-import-design.md).

| Export | Signature | Contract |
| --- | --- | --- |
| `exportState` | `(input, options?) => envelope` | `input` is a run **result** (`{ runState, … }`) or a raw runState. Returns a frozen, `JSON.stringify`-safe envelope `{ agrunStateVersion, runtimeBuildId, exportedAt, runState, events?, request? }`. The live event ledger is stripped. `options.request` bundles the originating request **auto-redacted** (`apiKey`/`signal`/`circuitBreaker`/`providerRegistry`/`fetch` removed). `options.includeEvents` (default `true`) toggles the `events` array. |
| `importState` | `(envelope) => runState` | Validates `agrunStateVersion` (throws an `Error` with `code: "INVALID_STATE_ENVELOPE"` on an unknown version or corrupt shape). Returns a plain runState ready for `resumeState`. A runtime-build mismatch is **non-fatal**: the returned runState carries a non-enumerable `agrunBuildMismatch` flag (never re-serialized). |
| `STATE_ENVELOPE_VERSION` | `number` | The current envelope schema version (`1`). |

Wiring: pass `onCheckpoint` to persist a checkpoint each cycle, and
`resumeState` to resume.

```js
import { createRuntime, exportState, importState } from "agrun";

const runtime = createRuntime({ providers: { /* … */ } });
const request = { provider: "openai", model: "gpt-5-mini", apiKey, prompt };

// Persist a checkpoint at every cycle boundary (best-effort; never blocks).
await runtime.run(request, {
  onCheckpoint: (envelope) => localStorage.setItem("agrun:ck", JSON.stringify(envelope))
});

// After a reload / crash — re-supply the apiKey, resume from the checkpoint.
const saved = localStorage.getItem("agrun:ck");
if (saved) await runtime.run(request, { resumeState: importState(JSON.parse(saved)) });
```

**Scope.** `resumeState` restores the in-flight runState — `cycleCount`, cost
ledger, virtual workspace, todo / research / OODAE state, and pending approval
— and the loop continues from the saved `cycleCount` (completed cycles are not
re-run). It does **not** restore the per-turn `actionHistory` or the
conversation, which are not part of runState; for full conversational
continuity, combine `resumeState` with a persisted session
(`runtime.openSession(id)`). `stepCount` is per-invocation; the resumable
progress counter is `cycleCount`. Secrets never serialize — `apiKey` is always
re-supplied at resume time.

### Node.js Test Runner Observability

`test/node-agrun-3000-live.mjs` is the canonical Node.js integration test. It
opts into the portable research skill pack with `agentSkills` and emits
structured JSON lines to stdout, making it easy to inspect payload sizes, tool
results, report quality observations, and convergence signals without a
browser.

#### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AGRUN_DEBUG=1` | off | Write `.jsonl` + `.md` debug artifacts to `agrun_debug_runs/` |
| `NODE_AGRUN_LIVE_DEBUG=1` | off | Same as `AGRUN_DEBUG=1` |
| `NODE_AGRUN_LIVE_MODEL` | provider default | Override model (e.g. `gemini-3.1-flash-lite`) |
| `NODE_AGRUN_LIVE_WORDS` | `3000` | Word target for the research prompt |
| `NODE_AGRUN_LIVE_PROMPT` | built-in | Override the full prompt text |
| `NODE_AGRUN_LIVE_MAX_STEPS` | `90` | Max cycles before forced stop |
| `NODE_AGRUN_LIVE_PLANNER_MODE` | `envelope` | Planner mode (`envelope` / `native_tools`) |
| `NODE_AGRUN_LIVE_PROVIDER` | auto-detect | `gemini` or `openai` |

#### Console events (real-time, one JSON line each)

| Event | Key fields |
|---|---|
| `node_agrun_live_start` | run config snapshot |
| `planner_decision` | `actionName`, `cycleCount`, `candidateWords`, `budgetState`, `readOnlyPlanningIgnoredCount`, `terminalRepairActive`, `terminalRepairIgnoredCount`, `wmgActive`, `wmgStallCount` |
| `prompt_payload` | `promptChars`, `actionsChars`, `historyChars`, `loopStateChars`, `planChars`, `workspaceChars`, `loopFields` (fires on every `planner-requested` step) |
| `hard_veto_fired` | `actionName`, `escalation`, `ignoredCount`, `candidateWords`, `cycleCount`, `stepType` |
| `convergence_block` | `actionName`, `reason`, `ignoredCount`, `stepType` |
| `node_agrun_live_summary` | full run summary including `candidateWords`, `structureOk`, `sourceMinimumPassed`, `terminalRepairState`, `terminalRepairState.workspaceRepairSignal`, `actionPatternConvergence`, `workspaceDiagnostics`, `issueHints` |
| `tool_result` | `actionName`, `status` (`"success"` / `"error"`), `message` (full when error, ≤200 chars when success), `summary` (≤200 chars) — emitted after every tool execution |
| `node_agrun_live_debug_artifact` | paths to `.jsonl` and `.md` files (only when debug enabled) |

#### `onToolResult` payload

Real-time console line per tool call (since 2026-05-20):

```json
{ "event": "tool_result", "actionName": "workspace_append", "status": "success", "message": "Appended 312 chars...", "summary": "..." }
{ "event": "tool_result", "actionName": "workspace_publish_candidate", "status": "error", "message": "<full error, not truncated>", "summary": "..." }
```

`message` is **not truncated on error** (full diagnostic text). On success it is capped at 200 chars. The debug recorder also stores a compact snapshot with: `actionName`, `status`, `message` (≤500 chars), `summary` (≤500 chars), `outputKind`, `outputStatus`, `publishBlock` (reason + required args example when publish is blocked).

**Signature note:** the runtime calls `onToolResult(output, { actionName, decision, runState })`. The first argument is the action output object directly (not a wrapper). `actionName` is in the second argument's destructured context, not on `output` itself.

#### Debug artifacts (`AGRUN_DEBUG=1`)

When enabled, two files are written to `agrun_debug_runs/<timestamp>/`:

- **`.jsonl`** — every recorded event in chronological order
- **`.md`** — human-readable report with sections: Verdict, Issue Hints, Run Config, Action Timeline, Action Counts, Source Ledger, Workspace Ledger, Terminal Repair, TodoState, Action Pattern Convergence, Requirement Recovery, Agent Workflow Trace Packet (planner request/response metadata + responseText preview + tool call args), Step Diagnostics, Event Ledger, Raw Summary

#### Quick start

```bash
# Basic run
node test/node-agrun-3000-live.mjs

# With debug artifacts + lite model
AGRUN_DEBUG=1 NODE_AGRUN_LIVE_MODEL=gemini-3.1-flash-lite node test/node-agrun-3000-live.mjs

# Fast smoke (500 words, short prompt)
NODE_AGRUN_LIVE_WORDS=500 NODE_AGRUN_LIVE_PROMPT="Write 500 words about AI agents." AGRUN_DEBUG=1 node test/node-agrun-3000-live.mjs
```

The `.md` artifact is the best starting point for debugging — it summarises all convergence signals, workspace operations, and source read results without requiring manual JSONL parsing.

### `runtime.getRuntimeConfig()`

Returns a cloned snapshot of the normalized runtime configuration. Use this at host boot or in an Inspector/debug panel to confirm which config fields are active after `createRuntime(options)` normalization.

```js
const runtime = createRuntime({
  skills,
  citationCoverageGuard: { enabled: false },
  researchCoverageGuard: { enabled: false }
});

console.log(runtime.getRuntimeConfig().citationCoverageGuard);
// { enabled: false }
```

The returned object is a snapshot. Mutating it does not change the live runtime configuration.

#### Caller Cancellation (`abortSignal`)

`session.run(input, { abortSignal })` and `runtime.run(input, { abortSignal })` honour a caller-supplied [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal). This is the symmetric counterpart to the runtime's internal hook-timeout signal (`context.signal`) — that one is **runtime → hook**; `abortSignal` is **caller → runtime**.

Contract:

- **Pre-aborted signal** — if `abortSignal.aborted === true` before `run()` starts, `run()` rejects with `AbortError` immediately. No LLM fetch is made.
- **Mid-run abort** — when the signal aborts during a turn, the in-flight LLM fetch is cancelled (the abort is merged with the per-request timeout signal via `AbortSignal.any`, so cancellation **and** timeout both fire). The provider stream stops, and `run()` rejects with `AbortError`.
- **Hook suppression** — once aborted, `onStep`, `onToken`, `onPlannerDecision`, `onToolResult`, and `onBeforeFinalize` become no-ops for the rest of the turn. The chat bubble stops mutating the moment the user clicks Stop.
- **Error shape** — the rejection is `Error { name: "AbortError", code: "ABORT_ERR", message: "Run aborted by caller…" }`. Distinguish user-cancellation from real errors with `if (error.name === "AbortError")`.
- **Billing reality** — already-generated tokens are still billed by the upstream provider (physical limit). Cancellation stops *future* tokens from being generated. This is the maximum savings a caller can achieve.

Example — wiring a Stop button:

```js
const controller = new AbortController();
stopButton.addEventListener("click", () => controller.abort());

try {
  const result = await session.run(input, {
    abortSignal: controller.signal,
    onToken: (delta) => appendToStreamingMessage(delta)
  });
  renderFinalResult(result);
} catch (error) {
  if (error.name === "AbortError") {
    // User clicked Stop — UI already silent thanks to hook suppression.
    return;
  }
  throw error;
}
```

**Fast-path interaction (ADR-0026 update):** the single-tool fast path was deleted. Multi-step harnesses always get the loop back to the planner — that is the new default. To skip the second planner round-trip, wire `onToolResult` and call your own finalize path. `resultKind: "final"` is unchanged: it remains a terminal direct-emit contract for tool-authored markdown and does not call the finalize provider.

Both `runtime.run()` and `session.run()` accept the same run options, but they are separate public entry points. A wrapper or monkey patch installed only on `runtime.run()` does not affect `session.run()`. If a host needs universal hooks, pass the hooks in the options object at the actual call site for both surfaces, or wrap both methods explicitly.

For a single installation point, use `createRuntime({ defaultRunOptions })`. These defaults are merged into both `runtime.run()` and `session.run()`:

```js
const runtime = createRuntime({
  skills,
  defaultRunOptions: {
    onPlannerDecision(decision, runState) {
      inspectDecision(decision, runState);
    }
  }
});

await runtime.run(input);

const session = await runtime.createSession();
await session.run(input);
```

If both `defaultRunOptions` and per-call run options define a hook, the default hook runs first. For rewrite hooks such as `onPlannerDecision` and `onToolResult`, the per-call hook receives the default hook's rewritten value and can override it.

For planner directives, default/runtime lines append first and per-call lines append after them. Use `plannerDirectivesMode: "replace"` when a phase must hide the runtime-level directives, for example a synthesis-only pass that must not call tools.

Example:

```js
const result = await runtime.run(input, {
  onStep(step, snapshot) {
    // Discrete phase events: planner-requested, action-executing, provider-responded, etc.
    // Action lifecycle events (action-executing / action-executed / action-execute-error)
    // carry step.detail.callId for deterministic pairing under parallel dispatch —
    // see agrun_docs/webui-integration-contract.md § "Action Activity Pairing".
    updateActivityPanel(step);
  },
	  onToken(token) {
	    // String delta during finalize phase only
	    appendToStreamingMessage(token);
	  },
	  plannerDirectives: ["This synthesis pass must answer from existing evidence only."],
	  disabledActions: ["read_url"]
	});
// result is the same complete envelope regardless of streaming
```

Guarantees:

- `onToken` is called zero or more times while the final answer is produced. Provider finalize streams deltas; direct final and plan per-action synthesize paths may emit the completed final text as one callback.
- `onStep("provider-responded", ...)` fires after all tokens are delivered
- `runtime.run()` resolves with the complete result envelope — the return value shape does not change
- If `onToken` is not provided, behavior is identical to the current blocking model
- `onToken` and `onStep` run in parallel — they do not block each other

Hosts that apply markdown post-processing, UI extension block stripping, table-marker handling, or link rewriting must apply that pipeline to every `output.kind: "final_response"` result, regardless of `finalAnswerSource` (`runtime_finalize`, `direct_final`, `plan_synthesize`, etc.).

### Structured Runtime Events

`onStep(step, snapshot)` remains the stable compatibility sink for browser hosts and existing Inspector code. For typed real-time tooling, use `runtime.subscribeEvents(callback, options?)`.

```js
const unsubscribe = runtime.subscribeEvents((event) => {
  console.log(event.sequence, event.type, event.visibility, event.phase);
}, {
  since: lastSeenSequence,
  type: ["planner-*", "action-executed"],
  visibility: ["agent", "user"],
  phase: "act"
});

// Later:
unsubscribe();
```

Contract:

- The callback receives the same v1 typed event record stored in `runState.eventLedger`.
- `sequence` is monotonic for the runtime instance and is stable for resume.
- `since` replays stored events with `event.sequence > since` before live follow-up events.
- Omitting `since` subscribes to future events only.
- Filters are optional and can use `type`/`types`, `visibility`, `phase`, and `mode`. `type` supports exact strings, arrays, and `*` globs such as `"planner-*"`.
- The return value is an idempotent unsubscribe function. A throwing subscriber is isolated and does not break the runtime or other subscribers.
- Event retention is FIFO-capped at 10,000 events by default (`DEFAULT_MAX_EVENTS`), so long-lived browser sessions do not grow memory without bound; the oldest events are dropped first and `since` replay only reaches retained events. Pass `maxEvents: null` at ledger/bus creation for explicit unbounded retention, or a positive integer to tune the cap.

`onStep` and `onStreamEvent` are unchanged. Browser Inspector still consumes the compatibility path unless a host explicitly migrates it to the typed event stream.

### Per-Message JSON Storage

Per-message storage is opt-in and uses the typed event stream from `runtime.subscribeEvents()` as its source for assistant parts. When omitted, runtime behavior is unchanged.

Node filesystem storage:

```js
const { createRuntime } = require("./dist/agrun.js");
const { createFsStorage } = require("./node/storage-fs.js");

const runtime = createRuntime({
  storage: createFsStorage({ baseDir: "./.agrun/storage" })
});

const session = await runtime.createSession();
await session.run("hello");
```

Browser IndexedDB storage:

```js
import { createRuntime, createIndexedDBMessageStorage } from "agrun";

const runtime = createRuntime({
  storage: createIndexedDBMessageStorage({ dbName: "my-app-agrun-storage" })
});
```

Storage layout / adapter contract:

| Adapter method | Meaning |
| --- | --- |
| `createSession(session)` | Optional session metadata write. |
| `writeMessage(sessionID, message)` | Upsert one user/assistant message JSON record. |
| `writePart(sessionID, messageID, part)` | Upsert one part JSON record for text, tool, reasoning, step-start, or step-finish. |
| `listSessions({ limit?, since? })` | List stored session summaries. |
| `getMessages(sessionID)` | Read message records for one session. |
| `getParts(sessionID, messageID)` | Read part records for one message. |
| `appendSessionDiff(sessionID, fileDiff)` | Optional workspace candidate diff append. |
| `getSessionDiff(sessionID)` | Read appended workspace candidate diffs. |

Message records use `schemaVersion: "agrun.message.v1"` and include `id`, `sessionID`, `runID`, `role`, `time.created`, `status`, `threadID`, `turnID`, `model`, and `partIDs`.

Compaction turns use the same schema with `variant: "compaction"`, `agent: "agrun.compaction"`, and `summary.kind: "compaction"`. The assistant compaction message stores the summary as a normal `text` part so replay tools can reconstruct the compacted context without scraping runtime logs.

Part records use `schemaVersion: "agrun.part.v1"` and include `id`, `sessionID`, `messageID`, `runID`, `type`, `index`, `time.created`, and type-specific fields:

| Part type | Fields |
| --- | --- |
| `text` | `text` |
| `tool` | `tool`, `state.status`, `state.input?`, `state.output?`, `state.error?`, `state.time?` |
| `reasoning` | `text` |
| `step-start` / `step-finish` | event marker metadata |

Both bundled adapters accept `redactor(record, { kind })` so hosts can remove secrets from stored message/part records before persistence. The runtime never embeds provider credentials in the storage layer.

`runtime.getMessageStorageState()` returns:

```js
{
  enabled: true,
  pendingRunCount: 0,
  errors: []
}
```

Storage errors are isolated from runtime execution and reported through `errors` plus optional `onStorageError`.

All object-shaped step details include:

```js
{
  runId,  // current run id
  cycle   // current OODAE/planner cycle
}
```

Key event families:

| Family | Step types |
| --- | --- |
| planner | `planner-requested`, `planner-responded`, `planner-native-tool-call` |
| action | `action-executing`, `action-executed`, `action-execute-error`, `action-args-invalid` |
| policy | `policy-blocked`, `approval-resolved`, `approval-denial-streak` |
| retry / repair | `planner-repair-requested`, `planner-repair-completed`, `planner-repair-failed`, `planner-strict-retry-requested`, `planner-strict-retry-completed`, `planner-native-tools-fallback`, `runtime-finalize-empty-response-retry` |
| finalize | `provider-requested`, `provider-responded`, `final-response-quality-repair`, `final-response-quality-repaired` |
| continuation | `continuation-*`, `todo-autopilot-action-progress`, plan/synthesize steps |
| abort | caller abort rejects with `AbortError`; after abort, no further `onStep` / `onToken` callbacks are delivered |

`planner-repair-failed` step details include a `rejection` object when the
runtime can classify why the repaired envelope was still unusable. Debug tools
should treat this as diagnosis, not control flow. Common reasons include
`unknown_action_name`, `missing_action_name`, `plan_has_no_valid_actions`,
`terminal_finalize_not_allowed`, and `deterministic_guard_rejected`. The same
compact object is also mirrored at
`agent-workflow-packet.parse.rejection` so trace readers can correlate the
provider response with the validation failure.

When terminal repair is active for long-form workspace output,
`terminalRepairState.workspaceRepairSignal` is an AI-visible diagnostic and
action-ordering hint. It contains the selected candidate path, latest
write/finalize/read indexes, whether the candidate has been read after the
latest content change, candidate text stats, requested length / remaining
deficit when known, heading outline with line numbers, duplicate heading or
section-number samples/contexts, source summary counts, and
`recommendedActionOrder`. If `mustInspectCandidate=true`, the planner should
choose `workspace_read` before destructive repair actions such as
`workspace_replace`, `workspace_write`, `workspace_multi_edit`, or patch
preview/apply. This is still read-only harness guidance: the runtime surfaces
facts and valid tools, while the AI authors every targeted repair, rewrite, or
honest limited publish.

Top-level duplicate heading diagnostics compare the heading label after
removing leading section numbers. For example, `## 5. Real-World Examples` and
`## 13. Real-World Examples` are treated as duplicate structure even though the
section numbers differ.

### Node SSE Adapter

Node hosts can expose the same typed stream through an opt-in Server-Sent Events adapter. The runtime core does not start an HTTP server.

```js
const http = require("node:http");
const { createRuntime } = require("./dist/agrun.js");
const { createSseHandler } = require("./node/runtime-sse-adapter.js");

const runtime = createRuntime({ /* host config */ });
const sseHandler = createSseHandler(runtime, {
  heartbeatMs: 15000,
  headers: { "Access-Control-Allow-Origin": "*" }
});

http.createServer((req, res) => {
  if (req.url.startsWith("/event")) return sseHandler(req, res);
  res.writeHead(404).end();
}).listen(3000);
```

Each runtime event is written as:

```text
data: {"schemaVersion":"v1","sequence":1,"type":"run-started",...}

```

The adapter sends periodic heartbeat comments, accepts query filters such as `?since=42&type=planner-*`, and unsubscribes automatically when the client disconnects.

Runnable local example:

```bash
npm run build
node examples/node-runtime-sse-server.cjs
curl -N "http://127.0.0.1:3000/event?since=0"
curl -X POST "http://127.0.0.1:3000/run-invalid"
```

Stable detail fields:

| Field | Meaning |
| --- | --- |
| `runId` | Runtime run id for correlation. |
| `cycle` | Current runtime cycle. |
| `callId` | Correlates start/done/error for action or provider calls when available. |
| `provider` | Provider name such as `openai` or `gemini`, never provider credentials. |
| `actionName` | Runtime action id such as `web_search` or `execute_skill_tool`. |
| `durationMs` | Wall-clock duration for completed action, provider, planner repair, and strict retry events when measured. |
| `usage` | Sanitized token usage summary only: `{ provider, model, inputTokens, outputTokens, totalTokens, updatedAt }`. Raw provider payloads are not exposed as runtime event usage. |
| `planIndex` | Zero-based action index for `type:"plan"` actions. |

`snapshot.metrics` and `result.runState.metrics` expose the cumulative per-run projection:

```js
{
  plannerCallCount,
  providerCallCount,
  actionDurations: [
    { actionName, callId, durationMs, planIndex, status }
  ],
  usage: {
    inputTokens,
    outputTokens,
    totalTokens,
    turnCount,
    updatedAt
  }
}
```

Metrics are derived from the same emitted steps, so hosts can either consume the event stream incrementally or read the final `runState.metrics` snapshot after `runtime.run()` resolves.

### Supported Input Categories

#### 1. Provider-backed turn

Object input used by planner/action execution paths and provider-backed turns.
This is the normal public run input. Plain strings and legacy direct skill-loop
objects are rejected with `INVALID_RUN_INPUT`; host behavior should be exposed
as `customActions` or agent skill tools inside this provider-backed loop.

Recommended shape:

```json
{
  "provider": "openai",
  "apiKey": "sk-test",
  "model": "gpt-4.1-mini",
  "apiVariant": "chat",
  "prompt": "review this javascript code for bugs",
  "systemPrompt": "optional system prompt — applies to both planner and finalizer",
  "webSearchEndpoint": "https://search.example.test"
}
```

Host notes:

- `fetch` may be injected by the host for browser-safe execution.
- `endpoint` and provider-specific transport options are host-managed extensions.
- `provider` currently supports `"openai"`, `"gemini"`, and `"deepseek"` in core. Browser example provider id `"custom"` is an app-level OpenAI-compatible flow that maps into the OpenAI provider path with a host-supplied `endpoint` and free-form model id; it is not a fourth core provider id.
- OpenAI defaults to `apiVariant: "chat"` for Chat Completions compatibility. Set `apiVariant: "responses"` to route the OpenAI browser provider through `/responses`; optional `reasoningEffort` and `reasoningSummary` are forwarded as Responses API reasoning options, and successful provider output may include `reasoningSummary`.
- DeepSeek uses the native `deepseek` provider path. `endpoint` may still point at a host proxy or custom base URL when the host owns transport/auth.
- Gemini supports `authMode: "server"` for browser-safe server-auth proxy usage. In that mode, `apiKey` is optional, `endpoint` must point to the host's Gemini-compatible `generateContent` proxy, and `streamEndpoint` must point to the host's Gemini-compatible SSE `streamGenerateContent` proxy when streaming is enabled.
- Gemini `authMode: "server"` does not send `x-goog-api-key` from the browser. `cachedContentMode` defaults to `"disabled"` in server-auth mode; use `"server"` only when the proxy owns cached content.
- Gemini grounded search supports server-auth proxy usage with `searchProvider: "gemini_grounding"`, `webSearchAuthMode: "server"`, and `webSearchEndpoint` pointing to the host's Gemini-compatible grounding proxy.
- `temperature`, `max_output_tokens`, `maxOutputTokens`, and `maxTokens` are not supported.
- Provider-style input is still submitted through `runtime.run(input)`, not through a separate runtime API.
- `systemPrompt` applies globally to both the planner and finalizer. This means per-run instructions such as response language or persona overrides take effect on all response paths, including `type: "final"` direct answers. When omitted, no dynamic system prompt is injected.
- `modelTier` (optional, `"lite"|"capable"`): overrides the planner's name-string heuristic for lite-tier classification (ADR-0033 Tier A). When set to `"lite"`, the planner runs in compact-prompt mode even for a capable-looking model name; when set to `"capable"`, name-matching is bypassed and the full prompt is used. Default: heuristic on `model` matches `flash-lite | flash | mini | haiku | nano` as lite. Use this override when the host knows the model better than the heuristic — e.g. a future `*-mini` SKU that is actually capable, or a custom-named deployment that should still get the compact prompt. The explicit opt-out `compactPlannerSystemPrompt: false` still wins over both heuristic and `modelTier: "lite"`.

#### 2. Approval resolution

Approval resumes are submitted back through the same public `runtime.run()` /
`session.run()` API with `type: "approval_resolution"` and the resume token
returned by the prior `approval_required` result. See
[agrun_docs/approval-flow.md](./approval-flow.md) for the full shape.

Research-turn note:

- Direct page reading through `read_url` is currently available only inside the planner/action path for provider-backed or research-style turns.
- A plain string skill-only turn does not expose `read_url` as a public skill contract.
- When the host wants browser-safe direct page reads, it should submit a provider-style turn and allow the `read_url` action through `actionPolicy` when appropriate.

## Session APIs

### `await runtime.createSession(options?)`

Creates a session handle for multi-turn history and session-scoped memory.

Supported options:

| Option | Required | Meaning |
| --- | --- | --- |
| `id` | no | Explicit session id to create. |
| `seedMessages` | no | Initial completed `user` / `assistant` transcript to import before the first real turn. |

Example:

```js
const session = await runtime.createSession({
  seedMessages: [
    { role: "user", content: "my car is red" },
    { role: "assistant", content: "Got it. Your car color is red." }
  ]
});
```

`seedMessages` guarantees:

- only seeds raw history; it does not execute skills
- it does not auto-extract session memory during seeding
- it is intended for host-side fork/rebuild flows such as edited messages or restored branches

### `await runtime.openSession(sessionId)`

Loads an existing session handle from the configured `sessionStore`.

### `SessionHandle`

Current session handle surface:

```js
session.id
await session.run(input)
await session.getHistory()
await session.getMemory()
session.getState()
```

Current `session.getState()` shape is centered on session metadata:

```js
{
  id,
  createdAt,
  updatedAt,
  compactedAt,
  lastRun,
  lastTokenUsage
}
```

Session state note:

- `session.getState()` may also include `contextSnapshot` as runtime-owned continuity metadata.
- The public method surface does not change.
- `contextSnapshot` is a structured continuity/debug artifact, not a new control API for hosts to author manually.

Session guarantees:

- session history is separate from runtime-instance `memory`
- `session.run(input)` rebuilds provider context from summary, confirmed facts, preferences, decisions, and recent conversation
- session-scoped memory is replayed only through `session.run(input)`
- successful session turns may auto-extract confirmed semantic memory such as facts, preferences, and decisions
- recall-style follow-up turns may answer directly from confirmed session memory before asking for clarification
- internal compaction summaries are persistence artifacts, not normal chat messages
- provider-backed session turns may compact or degrade old session context before sending a request to stay within the configured prompt budget
- prompt budget control prevents context overflow for one request, but it is not a general rate-limit or throughput control system
- `session.getState().lastTokenUsage` is updated only when a provider-backed session turn returns usage metadata

Current `lastTokenUsage` shape:

```js
{
  provider,
  model,
  inputTokens,
  outputTokens,
  totalTokens,
  updatedAt
}
```

Host note:

- `lastTokenUsage` is a convenience snapshot for the latest provider-backed session turn, not a cumulative session billing report

## Provider Session Continuity

For session-backed provider turns the runtime now assembles:

- `sessionContext`: compatibility projection used inside provider prompts
- `contextSnapshot`: canonical structured continuity state used by runtime/session/approval flows

Hosts should continue to call `runtime.run()` / `session.run()` normally.
For approval resume, pass the `resumeToken` through unchanged and let the runtime rebuild or adapt session context artifacts.

#### 4. Approval resolution input

Host-managed input used to approve or deny a previously blocked action.

Current standard shape:

```json
{
  "type": "approval_resolution",
  "decision": "approve",
  "resumeToken": {
    "actionName": "web_search",
    "policy": "ask",
    "request": {
      "provider": "openai",
      "model": "gpt-4.1-mini",
      "prompt": "who is tno system pte ltd boss"
    }
  }
}
```

Rules:

- Hosts should pass `resumeToken` back unchanged.
- Hosts may add fresh `apiKey`, `fetch`, or transport details at replay time for client-auth mode.
- For Gemini `authMode: "server"`, the resume token preserves `authMode`, `endpoint`, `streamEndpoint`, and `cachedContentMode`, but does not preserve or require `apiKey`.
- Approval resolution is a host-managed extension path, not an end-user free-form input category.

If the blocked action was `read_url`, the host should preserve the original request prompt and any accumulated `researchContext` in the `resumeToken`.

## Read APIs

### `runtime.getState()`

Returns runtime-instance state, currently centered on `lastRun`.

Use it for:

- showing the latest run summary
- debugging host integrations
- non-authoritative inspection after a turn completes

Do not use it as the canonical source of a currently running turn.
The canonical per-turn state is the `runState` inside the returned run result.

For provider/action turns, hosts may inspect:

- `runState.availableActions` to show which runtime actions were available for the turn
- `runState.pendingApproval` to continue blocked actions such as `read_url` or `web_search`
- `runState.researchContext.readSources` to inspect successfully read or failed URL evidence
- `runState.researchState` to inspect long-run research phase, source quality, evidence gaps, and finalization reason
- `runState.researchWorkspace` to inspect long-run research brief, plan, source notes, timeline, draft outline, and final-readiness state
- `runState.researchWorkspace.claimEvidence` and `claimGraph` to inspect sanitized claim-level support status plus include/downgrade/omit decisions
- `runState.researchReportLoop` to inspect the long-research OODAE report loop, source minimum, topic-derived coverage targets, bounded independent-search attempts, authority coverage, observation budget counts, final mode, and claim graph
- `runState.researchEvidenceGraph` to inspect the research verifier boundary: resolved entity, source artifacts, source authority, direct observations, claim evidence, claim graph, source coverage, relevant-source minimums, and final evidence gaps
- `runState.virtualWorkspace` to inspect browser-safe complex-response draft artifacts, final candidate readiness, and workspace operation summaries
- `result.output.citations` on research-style `final_response` outputs to render source links to the user

For long research, `researchReportLoop.coverageSearchAttempts` and
`researchReportLoop.independentSearchAttempts` are diagnostic counters. They
show how often the runtime tried bounded targeted searches for missing coverage
such as independent corroboration. Hosts should treat these as debug metadata,
not as a permission gate.

If `researchReportLoop` appears with `status: "planning_required"` or suggests
`todo_plan`, the runtime has surfaced a planning-readiness observation. The
AI/skill should create a topic-specific research plan before publishing a
serious report. This avoids applying a hardcoded coverage template to every
topic.

### `runtime.getMemory()`

Returns a read-only memory facade.

Current read contract:

```js
const entries = runtime.getMemory().readAll();
```

Hosts may inspect memory for debugging or continuity views.
Hosts must not assume direct write access through this facade.

Boundary note:

- `runtime.getMemory()` preserves runtime-instance append-only memory
- `session.getMemory()` returns semantic memory retained only for one session

### `runtime.getAgentSkills()`

Returns agent skill manifest summaries available to planner/action flows.

Use it for:

- settings or inspector panels
- skill catalog views
- host-side discovery of bundled instruction packages

The returned value is a summary surface.
When bundled skills define `tools.mjs`, their tool summaries are included here, but executable tool functions are not exposed through the public host API.

When `agentSkillIndexProvider` is configured, this returns the provider's
initial manifest summaries when they are synchronously available. Full skill
documents are still loaded only through `read_agent_skill`, `use_agent_skill`,
or `execute_skill_tool`.

### `runtime.getActionRegistry()`

Returns all registered action names, descriptions, and tiers. Useful for verifying at startup that expected actions (including skill tools) are registered.

```js
const actions = runtime.getActionRegistry();
// [{ name: "execute_skill_tool", description: "...", tier: 0 }, ...]
```

### Skill-Tool Arg Schema & Aliases

Skills declare each tool's arg contract in `tools[].parameters` — a JSON-schema-ish shape `{ type, properties: { key: { type, description, aliases? } }, required: [...] }`. Action-level args use the symmetric `action.planner.argsSchema` shape. Both paths enforce `required` and `type` before the tool body / `execute()` runs; violations emit `action-args-invalid` and the self-correction loop asks the planner to retry.

`aliases` is an optional per-property array that absorbs LLM planner hallucination where the model emits a near-miss key (e.g. camelCase for a snake_case param). If the planner sends an alias, the validator rewrites it to the canonical name *before* required/type checks and *before* the tool body is called, so hosts never have to defend against key drift inside their tool bodies. Works end-to-end: both bundled-tool calls (via `execute_skill_tool`) and action-level args.

For effective `plannerMode: "native_tools"` (which is now an explicit advanced/debug opt-in only — see ADR-0031), provider tool declarations are projected from the same `argsSchema`. Gemini declarations also include recursive `propertyOrdering` to keep required/control fields before nested payload fields. Native `plan` normalizes Gemini compatibility shapes (`toolArgsJson`, `arg_*`, direct flat fields) back to canonical action args before validation. For Gemini, `toolArgsJson` is the required native-plan payload shape for bundled-tool args because nested `toolArgs` can be emitted as `{}`; this provider capability is centralized in `src/runtime/provider-capabilities.js`. `plannerMode: "auto"` now resolves to `effectiveMode: "envelope"` with `reason: "default_envelope"` regardless of provider/model, so the resolver no longer inspects provider capabilities for the auto path; native opt-in is `plannerMode: "native_tools"` explicit. Debug snapshots still expose configured/effective mode plus the resolver reason. Native `todo_plan` still preflights empty item lists in native mode so a bad provider output emits `action-args-invalid` before TodoState mutation. If `debug` is enabled, native planner calls log a scrubbed raw args shape only; raw values, headers, API keys, bearer tokens, cookies, passwords, and secrets are omitted.

```js
// Skill tool (bundled-tool path via execute_skill_tool)
parameters: {
  type: "object",
  properties: {
    document_no: {
      type: "string",
      description: "Document number to search",
      aliases: ["documentNo", "docNo", "doc_no"]
    }
  },
  required: ["document_no"]
}

// Equivalent shape for an action-level argsSchema:
argsSchema: {
  document_no: {
    type: "string",
    required: true,
    aliases: ["documentNo", "docNo", "doc_no"]
  }
}
```

Rules:

- **Opt-in per property.** No global camelCase↔snake_case fallback — intentionally camelCase params (`pageSize`, `sortField`, `sortDir`) are never rewritten unless listed.
- **Canonical wins on collision.** If both canonical and an alias arrive with different values, the canonical is kept and the alias is dropped; a `collision: true` marker is included in the trace.
- **Traceable.** Every rewrite emits an `action-args-alias-rewrite` step via `onStep` (shape: `{ actionName, skillName?, toolName?, rewrites: [{ from, to, collision }] }`), so hosts can measure planner drift and alias effectiveness.
- **Planner-invisible.** Aliases are a runtime concern only — they are intentionally stripped from the planner prompt so the model sees and emits the canonical key; the rewrite exists to catch the ~30–50% of calls where the model still drifts.
- **No latency cost.** The rewrite runs in the same pass as validation — it replaces the would-be failed round-trip, not adds one.
- **Registration invariant.** `aliases` survives skill registration (`normalizeToolParameters`), the planner-prompt-safe compactor (`cloneToolParameters`), and reaches the validator untouched. You can assert this from the console: `agrunRuntime.getAgentSkills().find(s => s.name === 'your-skill').tools[0].parameters.properties.<key>.aliases` must equal what you declared on the wire.

### Debug Mode

Enable with `createRuntime({ debug: true })` or `createRuntime({ debug: (event) => {} })`.

When enabled, the runtime logs at these points:
- **Action dispatch**: action name, resolved status, extracted args
- **Planner decision**: decision type, action name, skillName, toolName
- **Action errors**: error message, action name

The host `onStep` callback also receives `action-execute-error` events when an action's execute function throws, enabling activity panel / inspector visibility into failures.

Provider-backed failures are normalized before they reach the result envelope:

```js
if (result.error) {
  showUserMessage(result.error.message);
  logSafeDebug(result.error.details);
}
```

Rules:

- `result.error.message` is the user-safe summary to show in the UI.
- `result.error.details` may include safe provider diagnostics such as `provider`, `status`, `reason`, and `retryable`.
- `result.error.cause` is a short sanitized cause summary for logs.
- Provider secrets, bearer tokens, authorization headers, and raw provider payloads are not part of this public error contract.
- Provider failure steps use `provider-error` with the same safe detail fields.

```js
// Console mode
const runtime = createRuntime({ skills: [...], debug: true });

// Custom handler mode
const runtime = createRuntime({
  skills: [...],
  debug: (event) => myLogger.info(event.label, event)
});
```

Zero overhead when `debug` is omitted or `false`.

## Public Guarantees

- `runtime.run(input)` returns a structured result envelope rather than raw skill output.
- `session.run(input)` returns the same structured result envelope while persisting session history and session memory.
- session-backed provider turns may short-circuit to a planner final answer when confirmed session memory already answers the user.
- The returned result owns per-turn `runState`, `steps`, `error`, and `memoryEntriesAdded`.
- `runtime.getState()` and `runtime.getMemory()` are read-only inspection surfaces.
- Hosts may rely on `agrun_docs/result-schema.md` as the source of truth for returned result shape.
- Hosts should build UI state from the returned result, not from internal runtime modules.
- `read_url` is part of the runtime action surface, not part of the public executable skill registration contract.
- Hosts should configure `actionPolicy.read_url` explicitly when they want deterministic allow/ask/deny behavior for direct page reads.
- `execute_skill_tool` is part of the runtime action surface for bundled browser-safe tools and defaults to `allow` unless the host overrides `actionPolicy.execute_skill_tool`.

## Transitional Notes

- Current implementation may emit `mode` values such as `tool_loop` or `skill_loop`.
- Those values are compatibility signals only and must not be treated as the long-term public architecture.
- The runtime now uses one canonical entry path even when the returned `mode` differs for compatibility.
- New host integrations should branch on `runState.status`, `error`, `pendingApproval`, `output.kind`, and `steps`, not on `mode`.
- Internal modules such as planners, action registries, or router helpers are not part of the public runtime API.
- The current implementation may read provider-backed URLs through the runtime-owned `read_url` action, even though older architecture text may still describe web/page access as a future skill-oriented capability.

## Direct URL Reading

Current public host contract for direct URL reading:

- `read_url` is not invoked by a separate host API; it is selected inside `runtime.run(input)` during the planner/action path
- the host does not call `runtime.readUrl(...)`
- the host may influence availability through `actionPolicy.read_url`
- default policy for `read_url` is `ask` because it is a tier `1` action
- the host may inject `fetch` in provider-style input for browser-safe execution

Example runtime configuration:

```js
const runtime = createRuntime({
  actionPolicy: {
    read_url: "allow",
    web_search: "ask"
  },
  skills: [openaiBrowserSkill]
});
```

## Bundled Direct Tools

Current public host contract for bundled browser-safe direct tools:

- `execute_skill_tool` is selected inside `runtime.run(input)` during the planner/action path
- it is intended for low-risk bundled tools such as timezone/date lookups
- default policy for `execute_skill_tool` is `allow` because it is a tier `0` action
- hosts may override `actionPolicy.execute_skill_tool` if they want `ask` or `deny`
- browser UIs may still show approval controls for other actions such as `web_search` and `read_url` without treating `execute_skill_tool` the same way

Example provider-backed run that may trigger `read_url`:

```js
const result = await runtime.run({
  provider: "openai",
  apiKey: "sk-test",
  model: "gpt-4.1-mini",
  prompt: "read this page https://example.com/article",
  fetch
});
```

Host expectations:

- if allowed, the runtime may read the page directly and store the structured result in `runState.researchContext.readSources`
- after `web_search`, the runtime exposes search results and read-attempt facts
  to the planner; the AI chooses any follow-up `read_url` actions and decides
  when to finalize
- if blocked by policy, the runtime returns `output.kind === "approval_required"` and a resumable `runState.pendingApproval`
- if the page cannot be read, the runtime still records the failed read source so the final answer can explain the limitation clearly
- when a browser-safe read-url adapter returns screenshot evidence, the runtime may carry that screenshot as optional multimodal evidence during final answering
- research-style `final_response` outputs may expose their evidence URLs through `output.citations` and an answer-level `Sources:` section

## Minimal Example

```js
import {
  createRuntime,
  openaiBrowserSkill
} from "../dist/agrun.js";

const runtime = createRuntime({
  skills: [openaiBrowserSkill],
  globalMemory: { enabled: true }
});

const result = await runtime.run({
  provider: "openai",
  apiKey: "sk-test",
  model: "gpt-4.1-mini",
  prompt: "Remember that we should ship the MVP."
});

console.log(result.output);
console.log(runtime.getState().lastRun);
console.log(runtime.getMemory().readAll());
```

## Global Memory Configuration

Cross-session "global" memory is auto-promoted from per-turn session memory when an extracted entry has sufficient confidence and is not flagged by the generic sensitive-content filter. Hosts can tune thresholds and inject policy via hooks.

### Runtime Options

Pass `globalMemory` on `createRuntime`:

```js
createRuntime({
  globalMemory: {
    enabled: true,             // master kill switch (default true)
    minConfidence: 0.7,        // floor for auto-promotion (0..1)
    maxEntries: 100,           // LRU cap per sessionStore database
    hookTimeoutMs: 2000,       // per-hook fail-closed timeout
    sensitivityFilter: null,   // (entry, context) => bool | Promise<bool>
    promotionValidator: null   // (entry, context) => bool | Promise<bool>
  }
});
```

### Disabling Global Memory

Pass `globalMemory: { enabled: false }` to fully disable the cross-session memory feature. When disabled:

- The per-turn semantic extraction LLM call is skipped (no token cost).
- `readAllGlobalMemory()` is not called during turn setup, so previously stored entries are not injected into the planner context.
- No entries are promoted to the `globalMemory` IndexedDB store.
- `global-memory-recalled`, `global-memory-written`, `global-memory-filtered`, and `global-memory-purged` step events are not emitted.

Per-session memory (e.g. entries appended by `memory-skill` or surfaced by skills via `helpers.appendMemory`) still works — only the cross-session promotion path is bypassed. Existing rows in the `globalMemory` IndexedDB store remain on disk; toggling `enabled` back to `true` (or omitting it) restores recall and promotion.

### Host Hooks

Both hooks are optional. When provided, they run in this order per candidate entry:

1. `isGlobalMemoryCandidate` (internal confidence + kind gate).
2. `sensitivityFilter` — if present; returning `true` blocks promotion.
3. `promotionValidator` — if present; returning `true` allows promotion, any other value blocks.
4. `appendGlobalMemory` + `global-memory-written` step.

If `sensitivityFilter` blocks (or errors, or times out), `promotionValidator` is not called.

**Polarity summary:**

| Hook | Return value meaning |
|------|----------------------|
| `sensitivityFilter` | `true` = sensitive, block. `false` = allow. |
| `promotionValidator` | `true` = verified, allow. anything else = block. |

### Hook Context

```js
context = {
  sessionId,
  sessionStore,        // the live sessionStore instance
  kind,                // "fact" | "preference" | "decision"
  category,            // "learned_fact" | "user_preference" | "project_context"
  slot,                // extractor slot, may be ""
  source,              // e.g. "auto_extract"
  sourceTurn: {
    user: string,      // last user message text
    assistant: string  // assistant reply that triggered extraction
  },
  signal               // AbortSignal (when supported by runtime)
}
```

`userId` is intentionally not in the context — the recommended multi-tenant pattern is to scope per-user via IndexedDB `dbName` (see README "Multi-tenant Deployment Pattern"). Hosts that need `userId` inside the hook can close over it at hook construction.

#### Cancellation via `context.signal`

When the hook exceeds `hookTimeoutMs`, the runtime aborts the signal on `context.signal` and moves on (fail-closed). Well-behaved async hooks should pass `signal` through to any internal `fetch()` / `AbortController`-aware operations so that cancelled work stops consuming resources:

```js
sensitivityFilter: async (entry, { signal }) => {
  const res = await fetch("https://pii-classifier.internal/check", {
    method: "POST",
    body: JSON.stringify({ text: entry.output.text }),
    signal
  });
  const { sensitive } = await res.json();
  return sensitive === true;
}
```

If a hook settles AFTER the timeout (either resolves or rejects), the runtime silently discards the late result — late rejections no longer surface as `UnhandledPromiseRejection` warnings, and late resolutions cannot retroactively mutate runtime state. The `global-memory-filtered` step with `reason: "hook_timeout"` has already been emitted and promotion was blocked fail-closed.

### Error Handling Contract

Both hooks are **fail-closed**:

- Hook throws / returns rejected Promise → entry not promoted.
- Hook exceeds `hookTimeoutMs` → entry not promoted.
- Rationale: for a generic runtime, missing one auto-extracted entry is cheap; promoting a sensitive or unverified one is not. Hosts that want fail-open semantics can wrap their own try/catch and return `false` from `sensitivityFilter` on error.

### Telemetry Events

All three flow through the existing `onStep` callback. Filter on `step.type`:

| `step.type` | `step.detail` |
|-------------|---------------|
| `global-memory-recalled` | `{ count }` |
| `global-memory-written` | `{ id, category, slot, confidence, reason: "insert" \| "upsert" }` |
| `global-memory-filtered` | `{ category, slot, hook, reason, message }` — `reason` in `sensitivity_blocked` / `validator_blocked` / `hook_error` / `hook_timeout` |
| `global-memory-purged` | `{ id, reason: "lru_evict" }` |

### Management API

The `sessionStore` interface exposes:

```
readAllGlobalMemory()               // list
deleteGlobalMemory(id)              // delete one
clearAllGlobalMemory()              // delete all in this database
updateGlobalMemory(id, patch)       // partial update
appendGlobalMemory(entry)           // insert / overwrite by id
```

For "count by category," derive it from `readAllGlobalMemory()` — no dedicated API.

### Domain-neutral Policy

The runtime's built-in sensitive-content filter covers only universal credential patterns (api keys, tokens, passwords, bearer strings). PII, business data, and domain-specific formats are explicitly out of scope for the runtime — see `agrun_docs/spec.md` "Stay Domain-neutral" and `agrun_docs/runtime-state-and-memory-architecture.md` "Domain-neutral Memory Policy." Plug domain rules into `sensitivityFilter` and `promotionValidator`.

The extractor prompt additionally rejects entries whose information value is primarily a specific business identifier, even when wrapped in natural-language prose and even when the user explicitly says "remember this." Such entries are session context, not durable cross-session memory. Hosts should still layer their own `sensitivityFilter` / `promotionValidator` rules for defense in depth against extractor regressions.
