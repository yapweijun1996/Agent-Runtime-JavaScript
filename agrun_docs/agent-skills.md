# agrun.js Agent Skills

## Purpose

This document defines bundled agent skills loaded from:

```text
skills/*/SKILL.md
skills/*/tools.mjs
```

These are instruction packages for the tool-loop path.
They are not the same as executable runtime skills in `src/skills/*.js`.

## Folder Contract

Each bundled agent skill lives in its own folder:

```text
skills/
  expert-coder/
    SKILL.md
  web-research/
    SKILL.md
  long-web-research/
    SKILL.md
  worldtime_tz/
    SKILL.md
    tools.mjs
```

`SKILL.md` may start with simple frontmatter:

```md
---
name: expert-coder
description: Write and review code with a bug-first, correctness-first engineering standard.
---
```

The remaining markdown body is the instruction content.

Optional `tags` and `inputTypes` frontmatter are preserved in manifests and
help Top-K skill ranking:

```md
---
name: web-research
description: Search the web and read source URLs.
tags: web, search, read-url, research
inputTypes: url, webpage, article
---
```

`tools.mjs` is optional. When present, it must default-export an array of
browser-safe executable tool definitions. It may also export `toolSummaries` so
the manifest generator can publish non-executable tool metadata without loading
the full skill:

```js
export const toolSummaries = [
  {
    name: "worldtime_now",
    description: "Return the current time for a timezone.",
    parameters: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA timezone or common alias." }
      },
      required: []
    },
    riskTier: 0
  }
];

export default [
  {
    ...toolSummaries[0],
    async func(args) {
      return { ok: true };
    }
  }
];
```

`toolSummaries` is manifest-only metadata. The generator strips executable
`func` values and ignores malformed summary entries. The default export remains
the only source for executable tools loaded by `loadSkillIndexProvider().loadSkill()`.

The bundled `web-research` skill is instruction-only. It teaches the planner
when to use the runtime `web_search` and `read_url` actions, including the
browser read-url service contract: hosts configure endpoint/key externally, and
the service entrypoint is `POST /read-url`.

The bundled `long-web-research` skill is instruction-only. It is for topic-level
research that needs a plan, multiple search/read cycles, evidence tracking, gap
checks, progress updates, and a structured final report. Use `web-research` for
quick current-info or URL/article reads; use `long-web-research` when one
search/read pass would produce a thin answer.

The bundled `report-writing` skill is instruction-only. It is for long-form
reports, memos, articles, essays, and synthesis tasks where the right behavior is
to plan, draft, read back, self-review, repair, and publish from
`runState.virtualWorkspace`. It is portable across browser and Node-hosted tests
because it relies on TodoState and virtual workspace actions rather than a
user-facing Canvas UI or real file writes.
Its publish-readiness capability is carried as skill metadata
(`capabilities.requiresPublishReadiness`) and must survive raw skill parsing,
manifest normalization, and runtime skill summaries. That metadata authorizes
the direct runtime `workspace_publish_candidate` action surface for the active
or freshly read skill. It does not create a bundled skill tool named
`workspace_publish_candidate`.

For single-topic research, final `Sources:` fallback selection is relevance
guarded. Runtime source selection extracts distinctive prompt terms such as a
handle, product name, or quoted topic, and search-result fallback sources must
match those terms in the title, snippet, content, or URL. This prevents
unrelated but article-shaped pages from being appended as citations when direct
`read_url` evidence is thin or weak.

Long-run research also has a runtime quality gate. When `long-web-research` is
selected, agrun maintains `runState.researchState` as the research SSOT:

- `phase`: planning/searching/reading/evaluating/gap_check/finalizing
- `sourceQuality`: strong, medium, weak, thin, and rejected counts
- `gaps`: missing evidence signals such as no read sources or no strong source
- `finalAllowed` and `finalReason`: why finalization is allowed or blocked

Before finalization, the gate checks whether the run has enough relevant source
evidence. A strong source plus another relevant source passes; two medium
sources can also pass. Weak/thin-only evidence triggers a bounded retry through
`web_search` for stronger primary/official sources. After the bounded retry
budget is exhausted, the runtime may finalize with limitations, and the final
prompt receives the quality state so it can clearly state evidence limits
instead of over-claiming.

For handle/profile research, weak-evidence retries vary the search shape instead
of repeating the same broad query. The first retry asks for quoted official
website, GitHub, LinkedIn/profile, and portfolio evidence; the next handle-like
retry can target GitHub directly with `site:github.com <topic>`. Read-source
quality also recognizes a topic-owned first-party source when the domain/path
matches a distinctive handle/brand token from the query and the extracted page
text is long enough. This makes direct profile evidence such as an official
personal site or relevant GitHub profile count as stronger evidence without
hardcoding a specific person or domain.

Long-run research also maintains `runState.researchWorkspace`. This is a
structured virtual workspace, not hidden chain-of-thought. It contains safe,
inspectable artifacts:

- `brief`: topic, goal, and expected final report shape
- `plan`: research questions and search strategy
- `searchLog`: executed search queries and result counts
- `sourceNotes` / `evidenceTable`: read URLs with quality/status metadata
- `draft`: outline and synthesis notes used as finalizer context
- `finalReadiness`: whether the workspace is ready to finalize and why
- `timeline`: compact user/debug-visible progress events

The finalizer receives this workspace as draft context and is instructed to
write only the final user-facing report. Runtime quality checks also reject or
strip internal section labels such as `Research Workspace Progress`,
`Evidence Notes`, `Gap Check`, `Initial Inquiry`, and `Data Collection` if a
model tries to copy the workspace into the answer. A good final report should
separate confirmed facts, weak/self-published evidence, remaining evidence
gaps, and URL-backed sources without exposing the workspace scaffold.
For weak or incomplete research evidence, the finalizer prompt asks for a
clear user-facing report with honest limitations and sources. Runtime terminal
normalization does not insert source-quality or evidence-gap diagnostics into
the answer; those details stay in Inspector/support metadata.
The browser example applies the same final-answer normalization before storing
the assistant message, so copied end-user text matches the runtime final
output. Single-topic research source selection also filters read-url sources
against the prompt focus terms, so generic read pages are not appended as final
citations just because they were fetched during the run.
Browser Inspector may display the workspace so QA can see the long-run process
step by step without exposing raw model reasoning.
The Evidence panel also shows source-quality detail for read URLs. Each source
keeps a sanitized runtime explanation from the same classifier used by the
research gate: `tier`, `reason`, matched `signals`, and numeric metrics such as
text length, token overlap, bytes, HTTP status, and origin status. This lets QA
see why a URL was judged `strong`, `medium`/`usable`, `weak`, `thin`, or
`blocked` without exposing raw page text or service payloads.

AGRUN-214i adds a generic `runState.virtualWorkspace` for complex final
responses beyond research-specific state. It is browser-safe and never writes
real files. The workspace is pure JavaScript state and can be exercised in Node
tests, but it is not a Node.js or Python execution sandbox. The planner may use
these actions:

- `workspace_list`
- `workspace_read`
- `workspace_write`
- `workspace_replace`
- `workspace_finalize_candidate`

The workspace only accepts fixed artifact paths:

```text
outline.md
evidence.json
draft.md
critique.md
final_candidate.md
```

Unsafe paths such as absolute paths, `../`, or unknown filenames are rejected.
The workspace is for user-visible draft artifacts, not raw chain-of-thought.
For high-risk long-run research prompts, the before-finalize quality guard now
requires minimum artifact coverage before answering: `evidence.json`,
`draft.md`, `critique.md`, and `final_candidate.md` must be populated, and
`draft.md` / `final_candidate.md` must not merely duplicate `outline.md`. For ordinary short
reports, existing behavior stays compatible. Browser Inspector, Debug
Report, and Support Bundle expose sanitized workspace files, operation summaries,
and quality checks in a separate Virtual Workspace panel so QA can see the
draft/final-candidate boundary without pushing evidence context out of view.

Complex response finalization now has a real workspace-action gate. For
research/report/long-run prompts, the runtime does not allow the first workspace
state to be only `runtime-materialized`. If the planner tries to final/finalize
before any real workspace action, the before-finalize guard returns a
`missing_workspace_action` observation and asks for `workspace_write`. If the
planner keeps skipping the step, the runtime executes a browser-safe
`workspace_write` scaffold action instead of finalizing. Missing
`final_candidate.md` follows the same principle: bounded fallback writes the
candidate through `workspace_write`, then the next cycle can finalize from that
workspace artifact.

The Inspector also shows `Workspace Quality Warnings` when an artifact is
missing or weak, for example `missing_evidence`, `missing_draft`, or
`final_candidate_same_as_outline`. These warnings are presentation of runtime
quality checks; the browser does not make policy or finalization decisions.

Long-run research final answers also get a source-authority and claim graph
guard. The user-facing report prose remains planner/provider owned; runtime
does not rewrite it into a final-with-limitations or evidence-graph fallback report.
Detailed claim tables, source minimums, authority coverage, and limited/full
eligibility stay in Inspector, Debug Report, and Support Bundle, so a single
profile, advertorial, or directory source does not become an overconfident
biography. Browser Inspector projects the same runtime `claimCoverage` and
`claimGraph` metadata in Evidence so QA can see source count,
supported/unsupported claim counts, include/downgrade/omit decisions, and issue
codes.

Long-run research reports also run through a runtime OODAE report loop before
finalization. The loop is stored in `runState.researchReportLoop` and records
Observe / Orient / Decide / Act / Evaluate cycles. By default, a full
`Research Report` needs at least three read sources and two relevant sources.
It also needs useful authority coverage: primary or official evidence plus
independent corroboration for a full report. Passing the numeric source minimum
alone is not enough to produce a full report if the only usable evidence is
owner-controlled, repository, profile-directory, or advertorial context.
If the loop budget is exhausted before that minimum is met, the runtime records
limited-mode diagnostics internally and keeps final source scope conservative.
The end user should still see a normal report answer with honest limitations and
clickable scoped sources, not a runtime-authored `Research Report`
banner or source-minimum/debug counters.

The loop does not use a fixed coverage template for every topic. For complex
research, the runtime first requires a topic-specific `todo_plan`; if the
planner tries to finalize before creating one, the before-finalize gate asks for
that plan. Coverage targets are then inferred from the todo items and the topic
shape. Company-like topics default toward official, registry, and independent
sources; handle/project topics default toward official, repository, and
independent sources; generic topics default toward official and independent
sources. This keeps the research loop reusable without hardcoding a live QA
topic.

When independent corroboration is missing, the report loop can request a
bounded targeted `web_search` for independent sources. The default bound is two
attempts per missing independent target; after that, the runtime keeps
limited-mode diagnostics and source scope internal while the AI finalizer gives
an honest answer instead of pretending the report is complete.

The user does not have to prompt like an engineer. Natural requests such as
"research this company and give me a reliable public-source report" are enough
to activate the same source-backed research harness, todo plan, evidence graph,
workspace draft gate, and limited/full report boundary.

The same loop builds `claimEvidence[]` and `claimGraph[]` for high-risk claims. Employment,
company, education, profile-directory, date, metric, and detailed project
claims require direct source support from an authority tier allowed to verify
that claim kind. Unsupported high-risk claims must be downgraded or removed.
Browser Inspector shows the OODAE timeline, Source Authority cards, and Claim
Graph table so QA can see why the report remained limited or was allowed to
become a full report.

The final user-facing report is not compiled by runtime fallback logic. The
evidence graph is a harness input and verifier boundary for source scope,
authority, and claim decisions. Source identity logs stay in debug metadata,
and Browser/app chrome or low-value README implementation text such as
placeholder tool menus, `npm install`, documentation overview, workflow
diagrams, and design-token notes are filtered out of source/claim eligibility
before they can influence user-visible citations.
Readable but off-topic pages are also blocked before synthesis. If a page does
not match the topic's distinctive tokens, the evidence graph marks it as
`topic_mismatch`; it can explain a failed read path in Inspector, but it cannot
create final observations, claim evidence, or citations.

Challenge and low-value directory pages follow the same boundary. Cloudflare
challenge text (`Just a moment`, `Attention Required`, `cf_chl`) and
RecordOwl-style company-profile/job-opening directory content can be shown in
Inspector as read diagnostics, but it is not allowed to become a planner-visible
final finding or final `Sources` link. If the only remaining evidence is this
class of page, the final answer must stay conservative, and the detailed reason
belongs in Inspector/support diagnostics.

The runtime still does not rely only on planner obedience for complete debug
artifacts. After a valid final answer exists, the finalization harness may
materialize any missing safe presentation artifacts from existing
`researchState`, `researchWorkspace`, and the final user-facing answer:
`outline.md`, `evidence.json`, `draft.md`, `critique.md`, and
`final_candidate.md`. These materialized files are presentation/debug artifacts,
not raw chain-of-thought, and the operation log marks them as `materialize` so
QA can distinguish planner-written drafts from runtime-projected artifacts.
The browser Inspector makes that boundary explicit with per-file and
per-operation labels:

- `planner-written`: the planner used workspace actions such as write, replace,
  or finalize candidate.
- `runtime-materialized`: the runtime created safe debug artifacts from
  structured state and the final user-facing answer when the planner did not
  write the workspace itself.

For end users, the browser chat can also show a compact research progress
timeline under a long-running assistant message. It is derived from sanitized
runtime activity and can show search/read/draft/evaluate/finalize progress, but
it is not a reasoning trace and does not show raw prompts, raw arguments,
provider payloads, API keys, or internal workspace prose.

Real repo/file inspection is separate from the virtual workspace. Hosts may
enable optional read-only `repoFileTools` adapters, which expose tier-1
`repo_rg` and `repo_read_file` actions only when configured. Browser production
does not get filesystem access by default; hosts must inject adapters and use
`actionPolicy` if those actions should require approval. Node/server hosts can
reuse `node/repo-file-tools.cjs`, which resolves paths under `rootDir`, reads
with `fs`, searches with `rg --json`, and returns capped output.

## Loading Model

### Build-time bundling (default)

Bundled agent skills are:

- discovered at build time from `skills/*/SKILL.md`
- bundled into `dist/agrun.js`
- exposed at runtime as read-only metadata and instructions
- exposed to the planner as bundled browser-safe skill tools when `tools.mjs` exists

### Runtime loading (dynamic)

Host applications can also load skills dynamically at runtime without rebuilding:

- **`parseSkillMarkdown(text)`** — parse a single SKILL.md string into a skill object
- **`loadAgentSkills(manifestUrl)`** — fetch a JSON manifest and load all listed SKILL.md files

```js
// Single skill
const skill = Agrun.parseSkillMarkdown(markdownText);

// Manifest-based loading
const skills = await Agrun.loadAgentSkills('./skills/manifest.json');

Agrun.createRuntime({
  agentSkills: skills,  // replaces bundled skills
  skills: [Agrun.openaiBrowserSkill]
});
```

Manifest format (paths resolved relative to manifest location):

```json
{
  "skills": [
    "module-a/SKILL.md",
    { "skill": "module-b/SKILL.md", "tools": "module-b/tools.mjs" }
  ]
}
```

Graceful degradation: if a SKILL.md fails to fetch or parse, it is skipped with a `console.warn`. The loader never throws.

## Runtime Use

Bundled agent skills are available only in the tool-loop path.

The planner sees:

- the `list_agent_skills` action
- the `read_agent_skill` action
- the `use_agent_skill` action
- the `execute_skill_tool` action when bundled tools exist

The intended flow is:

```text
list_agent_skills
-> read_agent_skill
-> use_agent_skill
-> execute_skill_tool
```

The planner prompt receives only skill summaries (name, description, tools schema) — not full instructions. This keeps the prompt compact. Full instructions are loaded on demand via `read_agent_skill`.

`use_agent_skill` includes an auto-read fallback: if the planner skips `read_agent_skill` and calls `use_agent_skill` directly, the runtime auto-reads the skill internally instead of throwing. This makes the flow resilient to LLM ordering mistakes.

When the planner selects `use_agent_skill`, the chosen `SKILL.md` instructions become the active agent skill for the current run.
Those instructions are then appended to the provider answer system prompt.
When the planner selects `execute_skill_tool`, the active bundled skill tool runs inside the browser-safe runtime and its structured result is written into `runState.toolContext`.

Runtime actions and bundled skill tools are separate namespaces. The planner
must call runtime actions such as `workspace_publish_candidate` directly with
their own args envelope. It must not wrap them as
`execute_skill_tool({ toolName: "workspace_publish_candidate" })`. The runtime
preflight rejects reserved runtime/custom action names used as `toolName` and
returns recovery guidance to call the direct action instead.

### Skill/Tool Inference Fallback

The planner sometimes omits `skillName` and `toolName` from the `execute_skill_tool` decision, placing tool parameters directly in args. The handler resolves this through a three-layer fallback:

1. **Reverse-lookup**: If `toolName` is present but `skillName` is missing, the handler searches all bundled skills for one that owns that tool name.
2. **Parameter-key inference**: If both are missing and there is no active skill, the handler scores each bundled tool by counting how many of the provided arg keys match the tool's parameter schema. The tool with the highest match score wins. On ties, the tool with fewer total parameters (more precise match) is preferred.
3. **Args nesting fix**: If inference succeeds and tool parameters are flat in `args` (not nested in `args.args`), the handler restructures them automatically.

When `debug: true` is enabled, all inference steps are logged:

```
[agrun:debug] execute_skill_tool | inference result {
  candidateKeys: ["sortField", "sortDir", "pageSize"],
  matches: [{ skill: "globe3-sales", tool: "list_sales_invoices", score: 3 }, ...],
  best: { skillName: "globe3-sales", toolName: "list_sales_invoices" },
  bestScore: 3
}
```

Current approval note:

- `actionPolicy` controls runtime actions such as `execute_skill_tool`
- `skillPolicy` controls individual skill/tool availability and risk
- by default, with no policy configured, existing skill behavior remains `allow`

## Public API

The bundle exports:

```js
bundledAgentSkills
getBundledAgentSkill(name)
normalizeSkillManifest(value)
createInMemorySkillIndexProvider(skills)
normalizeSkillIndexProvider(provider, defaultSkills)
parseSkillMarkdown(text)
loadAgentSkills(manifestUrl)
loadSkillIndexProvider(manifestUrl)
```

Runtime instances also expose:

```js
runtime.getAgentSkills()
```

`runtime.getAgentSkills()` returns summaries only:

- skill metadata
- skill tool summaries

It does not expose executable `func` implementations to the host API.

## SkillManifest and SkillIndexProvider

AGRUN-214a adds a minimal index contract for hosts that want manifest-based
skill catalogs without changing existing small-catalog usage.

`SkillManifest` is the summary shape used for catalog/debug/planner surfaces:

```js
{
  skillId: "expert-coder",      // defaults to name for legacy skills
  category: "engineering",      // optional; generated from nested folders
  namespace: "engineering.code", // optional; generated from nested folders
  name: "expert-coder",
  description: "Write and review code...",
  tags: ["code-review", "debugging"],
  inputTypes: ["text"],
  sourcePath: "skills/expert-coder/SKILL.md",
  version: "",
  checksum: "",
  requires: ["read-url"],
  riskTier: 1,
  availability: {
    browser: true,
    network: true,
    inputTypes: ["text"],
    features: ["read-url"]
  },
  tools: [
    {
      name: "worldtime_now",
      description: "Return the current time for a timezone.",
      parameters: { type: "object", properties: {}, required: [] },
      riskTier: 0
    }
  ]
}
```

Full skill documents still use the existing skill object shape and must include
`instructions`. `instructions` is intentionally not part of `SkillManifest`.

Hosts may pass `agentSkillIndexProvider`:

```js
const runtime = Agrun.createRuntime({
  agentSkillIndexProvider: {
    listManifests() {
      return manifests;
    },
    getManifest(skillIdOrName) {
      return manifests.find((skill) => (
        skill.skillId === skillIdOrName || skill.name === skillIdOrName
      ));
    },
    async loadSkill(skillIdOrName) {
      return fetchAndParseFullSkill(skillIdOrName);
    }
  },
  skills: [Agrun.openaiBrowserSkill]
});
```

The provider methods may return values or promises. Runtime creation does not
fetch full skill documents. `list_agent_skills` reads manifests,
`read_agent_skill` / `use_agent_skill` load the selected full skill, and
`execute_skill_tool` loads the full skill before running the executable tool.

For static browser deployments with many skills in one public folder, use
`loadSkillIndexProvider()` instead of eager `loadAgentSkills()`:

```js
const provider = await Agrun.loadSkillIndexProvider('/skills/manifest.json');

const runtime = Agrun.createRuntime({
  agentSkillIndexProvider: provider
});
```

`loadSkillIndexProvider()` fetches only the manifest at setup time. Full
`SKILL.md` documents and optional browser-safe tools modules are fetched only
when `read_agent_skill`, `use_agent_skill`, or `execute_skill_tool` names that
skill.

Recommended folder shape:

```text
skills/
  manifest.json
  web-research/
    SKILL.md
    tools.mjs
```

Example manifest entry:

```json
{
  "skills": [
    {
      "skillId": "web-research",
      "name": "web-research",
      "description": "Search and read web sources.",
      "sourcePath": "web-research/SKILL.md",
      "toolsPath": "web-research/tools.mjs",
      "version": "1.0.0",
      "checksum": "abc123",
      "tags": ["search", "research"],
      "inputTypes": ["text"],
      "requires": ["read-url"],
      "riskTier": 1,
      "availability": {
        "browser": true,
        "network": true,
        "inputTypes": ["text"],
        "features": ["read-url"]
      },
      "tools": [
        {
          "name": "search_web",
          "description": "Search the web.",
          "parameters": { "type": "object", "properties": {}, "required": [] }
        }
      ]
    }
  ]
}
```

The lazy provider caches full skills by `skillId + version + checksum +
sourcePath + toolsPath`. If `refreshManifests()` observes a changed `version` or
`checksum`, the next `loadSkill()` re-fetches and re-parses that skill.

### Generating `skills/manifest.json`

For repo-managed skills, use the generator after editing `skills/**/SKILL.md` or
`skills/**/tools.mjs`:

```bash
npm run skills:index
```

This runs `node build/generate-skills-index.cjs` and rewrites
`skills/manifest.json` deterministically. The generated manifest is suitable for
static upload together with the `skills/` folder. It contains manifest summaries
only; full `instructions` stay in each `SKILL.md` and are loaded lazily by
`loadSkillIndexProvider()`.

The generator recursively scans `skills/**/SKILL.md`. Direct child folders keep
the legacy default `skillId === name`; nested folders get `category` from the
first folder segment, `namespace` from the parent folder path joined by `.`, and
default `skillId` as `${namespace}.${name}`. A frontmatter `skillId` overrides
that generated default. The generator fails on missing `name`, missing
`description`, duplicate `skillId`, or an empty skills directory. `checksum` is
a SHA-256 hash of `SKILL.md` plus `tools.mjs` when a tools module exists, so
changing either file invalidates the lazy-load cache.

If `tools.mjs` exports `toolSummaries`, the generator writes those sanitized
summaries to manifest `tools[]`. If the export is missing or malformed,
`tools[]` remains empty and the executable default tools are still lazy-loaded
from `toolsPath`.

The browser example Inspector projects selected skill metadata from
`runtime.skillCatalogRanking.matches[]`. QA can see each Top-K skill's
`category`, `namespace`, and tool names in the Skill Ranking panel, Debug
Report, and Support Bundle without opening raw JSON. This is presentation-only;
runtime ranking, policy, and lazy loading remain the source of truth.

Example:

```text
skills/research/news/paper_reader/SKILL.md
```

generates:

```json
{
  "category": "research",
  "namespace": "research.news",
  "skillId": "research.news.paper-reader",
  "sourcePath": "research/news/paper_reader/SKILL.md"
}
```

For static hosts that publish skills from another folder, pass explicit input
and output paths:

```bash
node build/generate-skills-index.cjs \
  --skills-dir ./examples/browser/public/skills \
  --out ./examples/browser/public/skills/manifest.json
```

`sourcePath` and `toolsPath` are written relative to the generated
`manifest.json` location, matching how `loadSkillIndexProvider(manifestUrl)`
resolves lazy `SKILL.md` and tools module URLs. The generator only writes the
manifest; it does not copy skill folders into the public/static directory.

For the browser example, use the copy helper to publish repo skills into Vite's
static folder and regenerate the target manifest:

```bash
npm run skills:copy:browser
```

This clean-copies repo `skills/` into `examples/browser/public/skills/`, skips
local artifacts such as `.DS_Store`, `node_modules`, and existing
`manifest.json`, then generates
`examples/browser/public/skills/manifest.json`. Browser code can load that
static catalog with `loadSkillIndexProvider('/skills/manifest.json')`.

For browser QA, open the example with the public skill provider enabled:

```text
/?debug_yn=y&skill_provider=public
```

The browser runtime then tries `loadSkillIndexProvider('/skills/manifest.json')`
before creating the runtime. If the manifest is missing or empty, the example
falls back to the existing bundled skills and exposes
`skillProviderMode` / `skillProviderStatus` / `skillProviderManifestUrl` in the
Inspector debug config.

On mobile, the browser Inspector is a developer/debug surface. It opens as an
overlay instead of sharing horizontal space with the chat. If a turn has no
runtime debug snapshot, the Inspector shows one compact empty state and hides
the detailed Support, Skill Ranking, Diagnosis, Evidence, and Raw panels until
debug data exists. This keeps non-debug end-user URLs from looking like runtime
failures. Once debug data exists, the Support card scrolls with the mobile
Inspector content instead of staying sticky and blocking later context such as
Skill Ranking. Desktop keeps the sticky Support card for fast QA copying.

The manifest generator also emits non-fatal warnings for malformed
`toolSummaries`, such as a missing export, non-array export, missing tool name,
invalid entry shape, invalid `riskTier`, or tools module import failure. These
warnings are diagnostics only: valid manifest entries are still generated, and
existing fatal validation for missing skill `name`, missing `description`,
duplicate `skillId`, and empty skills folders is unchanged.

### Skill Policy and Availability

AGRUN-214d adds `skillPolicy` as the skill/tool-level gate. It is separate from
`actionPolicy`: action policy decides whether a runtime action can run, while
skill policy decides whether a named skill/tool is available, denied, or needs
approval.

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
  }
});
```

Policy values:

- `"allow"`: skill/tool can be listed, read, activated, and executed.
- `"ask"`: skill/tool remains visible; only `execute_skill_tool` pauses through
  the existing approval resume flow.
- `"deny"`: skill is filtered from Top-K/list output; explicit read/use/execute
  fails closed with a sanitized policy error.

Manifest `riskTier` defaults follow the action policy tier model: `0` or unset
allows, `1`/`2` asks on execution, and `3` denies. Explicit host
`skillPolicy.skills` / `skillPolicy.tools` overrides manifest tier. Availability
checks use `requires` plus `availability.features`, `browser`, `network`, and
`inputTypes`; denied/unavailable skills are filtered before Top-K ranking, so
the planner does not see them.

### Planner Top-K Ranking

When the catalog is larger than `skillCatalogTopK`, agrun ranks manifests
against the current user prompt before building the planner prompt. The planner
sees only the selected candidates; the provider can still load any known skill
when an action names it explicitly.

Default settings:

```js
createRuntime({
  skillCatalogTopK: 10,
  skillCatalogMaxK: 30
});
```

The default ranker is deterministic and uses lexical overlap across:

- `name`
- `tags`
- `tools[].name`
- `description`
- `tools[].description`
- `inputTypes`

Hosts can provide `skillCatalogRanker({ prompt, manifests, topK, maxK })` to
replace the built-in scorer. This is the future extension point for Fuse.js,
MiniSearch, or embedding-backed ranking without adding those dependencies to
core runtime.

Ranking explainability is stored outside the planner prompt on
`runState.skillCatalogRanking`. Browser Inspector surfaces the same metadata in
its Support summary, Skill Ranking panel, Debug Report, and Support Bundle so QA
can see selected count, total count, Top-K, filtered count, score, and matched
fields. When `skillPolicy` filters candidates, the same debug object includes
`policyFilteredCount` and sanitized `policyFilteredReasons`; the browser
Inspector shows the policy count in Summary/Support and lists each policy reason
in the Skill Ranking panel plus Debug Report / Support Bundle.
The browser Inspector also derives a presentation-only ranking health view from
the same `skillCatalogRanking` snapshot. It reports whether the Top-K prompt
guard is active, whether selected candidates exceed `topK`, whether no skills
matched, and the selected/total candidate ratio. This health view is for QA and
support handoff only; runtime ranking and policy decisions still come from the
core runtime.

### 1000-skill regression harness

AGRUN-214e adds a deterministic fake catalog under
`test/helpers/fake-skill-catalog.js`. It generates 1000 manifests with stable
names, tags, duplicate tool names, risk tiers, `requires`, versions, checksums,
and a needle skill for ranking correctness.

The scale benchmark lives in `test/unit/skill-catalog-scale-benchmark.test.js`.
It is intentionally local and deterministic, not a production performance SLA.
Current documented guardrails:

| Check | Local threshold |
|---|---:|
| Rank 1000 manifests with built-in lexical Top-K | `< 1000ms` |
| Provider `listManifests()` for 1000 manifests | `< 500ms` |
| 100 provider `getManifest()` hot-path lookups | `< 250ms` |
| Policy/availability filter over 1000 manifests | `< 500ms` |

The same fixture is used by the planner concern test to prove the planner prompt
contains only `skillCatalogTopK` candidates. Duplicate `toolName` cases remain
safe by requiring the action/provider path to name the intended skill id/name;
tool name alone is not treated as a catalog-global key.

Compatibility:

- Existing `agentSkills: []` arrays are adapted through an in-memory provider.
- Omitting both `agentSkills` and `agentSkillIndexProvider` still uses bundled skills.
- `runtime.getAgentSkills()` still returns summaries only and never exposes tool `func`.
- `loadAgentSkills(manifestUrl)` still returns full skill objects; it is not changed to return a provider.
- `loadSkillIndexProvider(manifestUrl)` is the scalable manifest-first path.

## Boundary

Keep this split explicit:

- `src/skills/*.js` -> executable runtime skills
- `skills/*/SKILL.md` -> bundled agent instructions
- `skills/*/tools.mjs` -> optional bundled browser-safe skill tools

Do not make bundled skill packages depend on Node.js runtime loading.
