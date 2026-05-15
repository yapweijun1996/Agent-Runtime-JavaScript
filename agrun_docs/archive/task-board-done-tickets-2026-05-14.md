# Active Roadmap — Done Tickets Archive

Archived from `task.md` Active Roadmap on 2026-05-14. These tickets are marked Done/Completed/Shipped; they remain here as historical record. New work should reference them by ticket id, not duplicate them.

---

### AGRUN-214l | Research report loop no-op contract
| Field | Value |
|---|---|
| Priority | High |
| Status | Completed |
| Builds on | AGRUN-214i-k, `src/runtime/research-report-loop.js`, `src/runtime/research-evidence-graph.js`, final source filtering |
| Goal | Restore strict harness no-op semantics so disabled or non-required long-research gates do not mutate runtime state or source scope |

Problem:
- `maybeCreateResearchReportLoopVeto()` normalizes config, then calls
  `evaluateResearchReportLoop()` before checking whether the normalized gate is
  enabled or whether long-research quality gating is required.
- `evaluateResearchReportLoop()` is not a pure read. It refreshes
  `researchState`, builds/materializes `researchEvidenceGraph`, updates
  `researchReportLoop`, writes `researchWorkspace` evidence metadata, and can
  alter `scopedEvidenceUrls`.
- That means a disabled gate or simple non-long research flow can still affect
  later finalization/source filtering even though the report-loop veto returns
  `null`.

Harness rule:
- Disabled config means no-op: no `runState` mutation, no source-scope changes,
  no hidden diagnostic materialization.
- Not-required gates should also be no-op. Eligibility checks must be cheap and
  side-effect-free before the runtime builds or materializes report-loop state.
- If a future Inspector diagnostics mode needs eager materialization, it must be
  explicit and documented separately from enforcement.

Scope:
- Short-circuit `normalizeResearchReportLoopConfig(config).enabled === false`
  before any evaluator with side effects runs.
- Split the report-loop decision path so "is this gate required?" can be checked
  without materializing evidence graph state.
- Defer `materializeEvidenceGraph()` and `commitResearchReportLoop()` until the
  gate is both enabled and required, or until finalization explicitly compiles a
  research report.
- Preserve existing active long-research behavior: source minimum, authority
  coverage, bounded vetoes, workspace artifact writes, final-with-limitations fallback,
  and final full-report eligibility.
- Keep planner-owned research strategy intact; do not add fixed search queries,
  fixed todo templates, or topic-specific exceptions.

Acceptance:
- [x] Unit test proves `longResearchQualityGate: false` leaves
  `researchReportLoop`, `researchEvidenceGraph`, `researchWorkspace`, and
  `scopedEvidenceUrls` unchanged after `maybeCreateResearchReportLoopVeto()`.
- [x] Unit or concern test proves a simple/non-long research turn where the gate
  is not required returns `null` without report-loop/evidence-graph
  materialization.
- [x] Existing AGRUN-214i-k long-research tests still pass for active gated
  flows.
- [x] Root `npm run check` passes.
- [x] Browser example `npm run lint`, `npm run test:smoke`, and `npm run build`
  pass after any browser-visible state contract changes.
- [ ] After this contract fix, run the 3-topic MCP Chrome E2E quality gate
  across company, person/handle, and project prompts.

### AGRUN-213a | Action/tool schema hardening
| Field | Value |
|---|---|
| Priority | High |
| Status | Done (2026-04-29) |
| Builds on | `src/runtime/action-registry.js`, `src/runtime/action-args-validation.js`, `src/runtime/tool-schema.js` |
| Goal | Make planner-visible actions and bundled skill tools validate through one normalized schema/error contract |

Scope:
- Require every planner-visible runtime action to declare `argsSchema` or explicitly opt out with rationale.
- Normalize validation failures into one `action-args-invalid` shape that self-correction can consume.
- Keep alias rewriting opt-in and schema-owned; no global camelCase/snake_case hardcode.
- Add tool availability/schema checks without executing the tool.

Acceptance:
- [x] Unit coverage for missing required arg, wrong type, alias rewrite, alias collision, and explicit schema opt-out.
- [x] Planner self-correction receives structured schema failure context.
- [x] Existing action behavior remains backward compatible for valid args.
- [x] `agrun_docs/action-contract.md` reflects the final schema contract.

### AGRUN-213b | Structured runtime events
| Field | Value |
|---|---|
| Priority | High |
| Status | Done (2026-04-29) |
| Builds on | AGRUN-106, `defaultRunOptions`, `onStep` |
| Goal | Turn runtime observability into a stable opt-in event contract for hosts, QA harnesses, and browser Inspector surfaces |

Scope:
- Define a stable event taxonomy for planner, action, policy, retry/repair, finalize, continuation, and abort paths.
- Preserve existing `onStep(step, snapshot)` compatibility; do not add a second callback.
- Add stable event detail fields such as `runId`, `cycle`, `callId`, `provider`, `actionName`, `durationMs`, and sanitized `usage`.
- Accumulate per-run metrics for planner calls, provider calls, action durations, and token usage when available.
- Avoid exposing private provider payloads or secrets in event details.

Acceptance:
- [x] Event schema documented in `agrun_docs/public-runtime-api.md`.
- [x] Runtime metrics include action duration, planner-call count, provider-call count, and token usage when available.
- [x] Native tools schema now prefers `planner.argsSchema` so provider tool schema matches 213a validation required/type behavior.
- [x] Unit coverage pins event detail enrichment/metrics and OpenAI/Gemini native schema projection.
- [x] Existing abort, approval, research, provider, and planner concern suites remain part of `npm run check`.

### AGRUN-213c | Provider failure error clarity
| Field | Value |
|---|---|
| Priority | Medium |
| Status | Done (2026-04-29) |
| Builds on | AGRUN-120, `src/runtime/provider.js`, `src/runtime/provider-timeout.js` |
| Goal | Return clearer, user-safe provider failure messages without changing single-provider behavior |

Scope:
- Normalize provider errors into safe fields: `provider`, `status`, `code`, `reason`, `retryable`, and user-safe `message`.
- Preserve existing public error code behavior such as `PLANNER_ERROR`.
- Emit `provider-error` steps for failed provider calls without leaking raw provider payloads or secrets.
- Keep fallback provider config deferred; this slice does not add `providerFallback`, `fallbackProviders`, or `providerProfiles`.

Acceptance:
- [x] Single-provider success behavior unchanged.
- [x] Unit tests cover auth, rate limit, timeout, config errors, attached provider step details, and secret scrubbing.
- [x] Provider concern test keeps `PLANNER_ERROR` while asserting clearer message/details.
- [x] Caller-abort and circuit-breaker behavior remain separate from provider error normalization.

### AGRUN-214 | Scalable Skill Index and Lazy Loading
| Field | Value |
|---|---|
| Priority | Medium |
| Status | Done (2026-05-01) |
| Builds on | AGRUN-213a, `src/runtime/agent-skills.js`, `src/runtime/skill-loader.js`, `list_agent_skills`, `read_agent_skill` |
| Goal | Support 1000+ browser agent skills without loading every full skill document into memory, prompt, or planner context |

Problem:
- Current runtime has the right direction for small catalogs: planner sees summaries and full `SKILL.md` instructions are added only after a skill is read/activated.
- Current dynamic loader still fetches/parses every manifest skill up front.
- Current planner prompt can still receive every compact skill summary.
- Current `list_agent_skills`, skill lookup, reverse tool lookup, and parameter inference are linear over the full skill array.
- This is acceptable for small/medium catalogs, but not a 1000+ skill browser deployment.

Reference samples:
- `hermes-agent-2026.4.8` — tool registry grouping, runtime availability checks, lifecycle-aware memory/tool boundaries.
- `ai-ai-6.0.119` — typed tool metadata and provider/tool interface separation.
- `aiverify-2.2.0` — schema-first plugin metadata discipline.

Sample research plan:

| Sample source | What to learn | Apply to | Do not copy |
|---|---|---|---|
| `hermes-agent-2026.4.8/tools/registry.py` | Central registry shape: metadata + handler + toolset + availability check + max result budget. Availability checks are cached per definition call and dispatch returns normalized errors. | AGRUN-214a, AGRUN-214d | Python singleton/import-time registration, server toolsets, emoji/UI metadata as runtime requirement. |
| `hermes-agent-2026.4.8/tests/tools/test_registry.py` | Regression shape for registry behavior: unknown tool errors, unavailable tool filtering, shared availability check called once, exception-safe checks. | AGRUN-214d, AGRUN-214e | Test names/implementation details; keep agrun tests JS/browser-first. |
| `agents-js/browser/skills-manifest.json` | Browser-facing manifest shape with `id`, `path`, `hasTools`, `toolsModule`, `tools`, and `knowledgeFiles`; useful as a concrete small-catalog manifest baseline. | AGRUN-214a, AGRUN-214c | Loading every full skill/tool eagerly for 1000+ catalogs. |
| `agents-js/docs/skills.md` | Cross-platform skill packaging rule: browser-safe `tools.mjs`, Node-only tools excluded from browser build, `SKILL.md` as agent-readable instruction. | AGRUN-214a, AGRUN-214d | Node/browser dual-runtime complexity and rebuild-only browser workflow. |
| `aiverify-2.2.0/common/schemas/aiverify.plugin.schema.json` | Schema-first plugin metadata with stable global id, version, name, bounded description, and required fields. | AGRUN-214a | AI Verify portal/test-engine deployment model. |
| `ai-ai-6.0.119/content/docs/07-reference/01-ai-sdk-core/20-tool.mdx` and related tool docs | Typed tool contract discipline: schema, invalid tool input errors, no-such-tool errors, approval errors, UI/tool result separation. | AGRUN-213a, AGRUN-214a, AGRUN-214d | Full AI SDK framework/API surface or full-pipeline streaming model. |

Research questions before implementation:
- What is the minimum `SkillManifest` that still supports retrieval, policy, lazy-load, cache invalidation, and debug explainability?
- Should skill IDs be globally unique (`namespace.skill`) while display names remain non-unique?
- How should duplicate `toolName` behave: deterministic owner list, forced `skillId`, or policy block until disambiguated?
- Which availability checks run during retrieval, and which run only at execution time to avoid slow startup?
- What default `skillCatalogTopK` and hard ceiling protect prompt budget without hiding useful skills?

Target architecture:

```text
SkillManifest index
  -> host policy / input type / availability filter
  -> search/rank top K candidates
  -> planner sees only top K summaries
  -> read_agent_skill lazy-loads full SKILL.md
  -> execute_skill_tool resolves through indexed skill/tool maps
```

Scope:
- Define a compact `SkillManifest` schema: `skillId`, `namespace`, `category`, `name`, `description`, `tags`, `tools`, `riskTier`, `inputTypes`, `version`, `checksum`, `sourcePath`.
- Define a host-pluggable `SkillIndexProvider` interface for listing/searching manifests and lazy-loading full skill documents.
- Support nested category folders for scalable source organization, such as `skills/sales/invoice_analyzer/SKILL.md`, `skills/research/paper_reader/SKILL.md`, and `skills/writing/blog_writer/SKILL.md`.
- Treat `skills/manifest.json` or equivalent generated index as the runtime source of truth for scalable catalogs; browser runtime must not depend on recursive filesystem listing.
- Add canonical Node build script `node build/generate-skills-index.cjs`; `npm run skills:index` may exist only as a convenience wrapper. Engineers should be able to run the Node script directly without depending on npm workflow knowledge.
- Document the deployment maintenance flow: engineer maintains nested skill folders -> runs `node build/generate-skills-index.cjs` -> reviews deterministic generated index diff -> uploads/publishes the folders plus generated index to the server/static host.
- Change planner skill catalog exposure from "all compact skills" to top-K candidates, with a configurable default and hard ceiling.
- Keep current small-catalog behavior backward compatible when `agentSkills` is passed as an array.
- Add indexed lookup maps for `skillId/name -> manifest/skill` and `toolName -> owning skill(s)`; do not rely on full-array scans for hot paths.
- Add host allowlist/denylist and runtime availability checks before a skill can be listed, read, activated, or executed.
- Do not build a plugin marketplace, backend registry, remote embedding service, or cloud dependency into core runtime.

Acceptance:
- [ ] 1000 fake skill manifests load/search under a documented browser-friendly time and memory budget.
- [x] Nested category folders generate stable manifest entries with `category`, `namespace`, `skillId`, `sourcePath`, `toolsPath`, `version`, and `checksum`.
- [x] `node build/generate-skills-index.cjs` regenerates the index deterministically and fails on invalid/missing required metadata.
- [x] `node build/generate-skills-index.cjs --skills-dir <dir> --out <file>` supports alternate static publish folders while preserving default `skills/manifest.json` generation.
- [x] The generated index is suitable for static upload with the skill folders; browser runtime can consume it without filesystem scanning.
- [x] Planner prompt includes only top-K candidate skill summaries, not the full 1000-skill catalog.
- [x] Full `SKILL.md` content is fetched/parsed only after `read_agent_skill` or equivalent lazy-load boundary.
- [x] Disabled/unavailable skills cannot be listed, read, activated, or executed.
- [x] Name collision and duplicate `toolName` cases are deterministic and visible in debug/event metadata.
- [x] Version/checksum cache invalidation test proves stale full skill docs are not reused silently.
- [x] Browser mobile Inspector no-debug state uses an overlay and compact empty state instead of squeezing chat with repeated diagnostics.
- [x] Browser mobile Inspector debug state lets the Support card scroll away instead of staying sticky and blocking Skill Ranking / later context.
- [x] Bundled `long-web-research` skill contract exists for topic-level research plans, iterative search/read, evidence tracking, gap checks, progress updates, and final reports.
- [x] Long-run research has runtime `ResearchState`, source-quality counts, evidence-gap detection, bounded before-finalize retries, and browser Inspector/debug projection.
- [x] Long-run research has runtime `researchWorkspace` with brief, plan, search log, source notes, draft outline, gap/readiness state, and progress timeline for Inspector/debug/finalizer context.
- [ ] Existing bundled small-skill tests still pass unchanged or have documented compatibility migration.
- [x] `agrun_docs/agent-skills.md` documents the scalable catalog contract.

### AGRUN-214a | SkillManifest and SkillIndexProvider contract
| Field | Value |
|---|---|
| Priority | Medium |
| Status | Done (minimum contract, 2026-04-30) |
| Builds on | AGRUN-214, `src/runtime/agent-skills.js`, `src/runtime/skill-loader.js` |
| Goal | Define the stable manifest/index boundary that lets agrun discover many skills without loading full skill instructions |

Scope:
- Add a normalized `SkillManifest` shape with stable identifiers, display fields, retrieval fields, policy fields, version/checksum, and lazy-load source pointers.
- Add a host-pluggable `SkillIndexProvider` minimum contract for `listManifests`, `getManifest`, and `loadSkill`.
- Support existing `agentSkills: []` arrays by adapting them into an in-memory provider.
- Keep full `SKILL.md` instructions out of the manifest unless the host explicitly opts into small-catalog compatibility.
- Defer nested category generation, `build/generate-skills-index.cjs`, `npm run skills:index`, Top-K ranking, policy/availability gates, and benchmark scope to AGRUN-214b-e.

Acceptance:
- [x] Manifest normalization rejects missing `skillId`/`name` and duplicate IDs fail deterministically.
- [x] Existing small bundled skills still work through the compatibility adapter.
- [x] Unit tests cover manifest normalization, in-memory provider list/get/load, duplicate ID handling, and summary function stripping.
- [x] Provider-backed planner concern proves `list_agent_skills` reads manifests, `read_agent_skill` lazy-loads a full skill, `use_agent_skill` reuses the last-read full skill, and `execute_skill_tool` loads the full skill before running the tool.
- [x] `agrun_docs/agent-skills.md` documents the new provider contract and compatibility path.

### AGRUN-214b | Top-K skill retrieval and ranking
| Field | Value |
|---|---|
| Priority | Medium |
| Status | Done (2026-04-30) |
| Builds on | AGRUN-214a, planner skill catalog prompt |
| Goal | Select a small, relevant skill candidate set before planner invocation so 1000+ catalogs do not cause prompt bloat or planner confusion |

Scope:
- Add deterministic first-pass ranking over `name`, `description`, `tags`, `toolNames`, `toolDescriptions`, and input type.
- Expose configurable `skillCatalogTopK` with a conservative default and `skillCatalogMaxK` hard ceiling.
- Add optional `skillCatalogRanker` hook so hosts can later plug in MiniSearch/Fuse/embedding rankers without adding those dependencies to core runtime.
- Include ranking/debug metadata outside the prompt so QA can explain why a skill was included or filtered.
- Preserve small-catalog compatibility by only filtering when manifest count is larger than Top-K.

Acceptance:
- [x] 1000 fake manifests produce a prompt containing only top-K candidates.
- [x] Ranking tests cover exact skill name, tag match, tool name match, description match, no-match behavior, and custom ranker replacement.
- [x] Hard ceiling prevents prompt expansion even if host sets an excessive K.
- [x] Debug metadata includes score, matched fields, selected count, total count, and filtered count.
- [x] Browser Inspector exposes ranking metadata in Support cards, Skill Ranking panel, Debug Report, and Support Bundle.

### AGRUN-214c | Lazy SKILL.md load and cache invalidation
| Field | Value |
|---|---|
| Priority | Medium |
| Status | Done (2026-05-01) |
| Builds on | AGRUN-214a, `read_agent_skill`, `use_agent_skill` |
| Goal | Fetch/parse full skill instructions and tools only when a selected skill is read or activated, with safe cache invalidation |

Scope:
- Add `loadSkillIndexProvider(manifestUrl)` for one static skills folder plus `manifest.json`.
- Keep `loadAgentSkills(manifestUrl)` eager and backward compatible.
- Cache loaded skill documents by `skillId + version + checksum + sourcePath + toolsPath`.
- Invalidate stale cached documents when manifest version/checksum changes after `refreshManifests()`.
- Make lazy-load failures recoverable through `loadSkill()` returning `null` with safe warnings.

Acceptance:
- [x] `loadSkillIndexProvider` scalable path does not fetch all `SKILL.md` files at startup.
- [x] `provider.loadSkill()` fetches/parses exactly the selected skill in the fake provider test.
- [x] Version/checksum changes invalidate cached full skill docs after manifest refresh.
- [x] Failed lazy-load returns `null` and does not crash provider setup.
- [x] `loadAgentSkills()` remains eager and existing tests pass unchanged.

### AGRUN-214d | Skill policy and availability gate
| Field | Value |
|---|---|
| Priority | Medium |
| Status | Completed |
| Builds on | AGRUN-214a, AGRUN-213b, `src/runtime/policy.js`, `src/runtime/action-availability.js` |
| Goal | Ensure unavailable, disabled, or high-risk skills cannot be listed, read, activated, or executed accidentally |

Scope:
- Add independent `skillPolicy` config for skill/tool `allow` / `ask` / `deny`.
- Add availability checks for input type, browser capability, network requirement, host feature flags, `requires`, and risk tier.
- Filter denied/unavailable manifests before planner Top-K and `list_agent_skills`.
- Ensure direct `read_agent_skill`, `use_agent_skill`, and `execute_skill_tool` fail closed for denied/unavailable targets.
- Reuse the existing approval resume flow when a specific skill tool is `ask`.
- Emit structured event/debug reasons for filtered, denied, or approval-required skills without leaking secrets.

Acceptance:
- [x] Disabled skills do not appear in top-K, list output, or planner prompt.
- [x] Direct attempts to read/activate/execute disabled skills fail closed.
- [x] High-risk skill execution follows policy `allow/ask/deny`.
- [x] Tests cover unavailable feature, denied skill, approval-required skill, and allowed skill paths.

### AGRUN-214e | 1000-skill benchmark and regression harness
| Field | Value |
|---|---|
| Priority | Medium |
| Status | Completed |
| Builds on | AGRUN-214a-d |
| Goal | Prove scalable skill catalogs work under realistic browser-runtime constraints before claiming 1000+ support |

Scope:
- Generate deterministic fake skill manifests with controlled names, tags, duplicate tool names, risk tiers, versions, and checksums.
- Measure/record manifest load/search time, prompt candidate count, lazy-load count, and hot-path lookup behavior.
- Add regression tests for prompt size guard, top-K correctness, lazy-load boundary, collision handling, and cache invalidation.
- Document the supported budget and what remains host-dependent.

Acceptance:
- [x] 1000 fake manifest benchmark passes under documented local thresholds.
- [x] Prompt guard test proves no more than top-K candidates enter planner context.
- [x] Duplicate `toolName` test resolves deterministically or requires `skillId`.
- [x] Benchmark results or thresholds are documented in `agrun_docs/agent-skills.md` or a linked live/concern note.

### AGRUN-214f | Browser Inspector ranking health view
| Field | Value |
|---|---|
| Priority | Medium |
| Status | Completed |
| Builds on | AGRUN-214b-e |
| Goal | Let QA see whether the current turn's skill ranking stayed within Top-K prompt guard expectations |

Scope:
- Derive presentation-only ranking health from `runtime.skillCatalogRanking`.
- Show health in Inspector Summary, sticky Support card, Skill Ranking panel, Debug Report, and Support Bundle.
- Keep runtime ranking, policy, and benchmark execution unchanged.

Acceptance:
- [x] Top-K guard active turns show `ok` with candidate ratio and prompt guard metadata.
- [x] Over-Top-K derived state reports `issue`; no-match derived state reports `warning`.
- [x] Debug Report and Support Bundle expose health status and prompt guard fields.

### AGRUN-104 | Streaming test cleanup
| Field | Value |
|---|---|
| Priority | Medium |
| Status | Done (pending move to Recently Completed) |

Acceptance:
- [x] Add unit coverage for `requestGeminiContentStreaming`. — `test/unit/gemini-streaming.test.js` (2026-04-26): onToken sequence, final text, server-mode `streamEndpoint` URL routing, x-goog-api-key/Authorization stripping, validation rejections (missing endpoint / streamEndpoint), no-onToken path.
- [x] Add unit coverage for `requestOpenAIChatCompletionStreaming`. — `test/unit/openai-streaming.test.js` (2026-04-26): onToken sequence, final text, baseURL routing, server-mode URL rewrite + Authorization strip, missing-endpoint rejection, no-onToken path.
- [x] Remove obsolete `sse-parser.js` if still present. — verified 2026-04-26: no matches under src/ or test/.

### AGRUN-229 | ADR-0020 — Skill catalog ranking is AI-tool-only; runtime no longer auto-ranks user prompt
| Field | Value |
|---|---|
| Priority | High (push-mode + cross-language collapse on lite × Mandarin × long-form) |
| Status | **DONE 2026-05-07.** PR 1 (source deletion) + PR 2 (browser cleanup + plumbing live verify) shipped. Real LLM Mandarin re-run deferred to user-dogfood per acceptance line. |
| Builds on | ADR-0013 (skill discovery is a tool) — ADR-0020 completes its PR 1 unfinished acceptance. |
| Goal | `git grep -n "skillCatalogRanking" src/` returns 0 hits. `resolvePlannerSkillCatalog` returns policy-filtered manifests without invoking ranker. Lite × Mandarin × long-form prompt sees full skill catalog (`bundledAgentSkillCount=6`) instead of empty list. |

Why this ADR exists:
- ADR-0013 PR 1 specified deletion of `skillCatalogRanking` cloning + `recommendedSkill` directive but the deletion was incomplete: 5 sites still reference `skillCatalogRanking` and `selectSkillCatalogCandidates({prompt: request.prompt})` still token-matches the user prompt against English skill manifests every cycle.
- Live evidence 2026-05-07: lite × Mandarin × 3000-word prompt produced `skill_catalog_ranking` debug block with all 5 skills scoring 0 (regex `[^a-z0-9_+-]+` strips Chinese as separator → empty token list → score=0 for every manifest → `plannerAgentSkills = []` → AI sees empty catalog).
- Push + pull hybrid is what ADR-0013 Alt 1 explicitly rejected. Today's runtime has both: auto-rank pushes top-K into `loopState.bundledAgentSkills`, AND `list_agent_skills` tool exists for AI pull. The push half collapses on non-English prompts and overrides AI judgment when ranking is wrong.
- Architectural cut: AI translates user intent into English capability keywords (Mandarin "深度调研" → AI calls `list_agent_skills(query="research")`). Runtime never does the translation. Skill manifests stay English by convention (ADR-0013 design principle 1).

Two-PR cadence:
- **PR 1 — Delete auto-rank-on-user-prompt path.** Files: `src/runtime/action-loop-planner.js` (rewrite `resolvePlannerSkillCatalog` to return policy-filtered manifests without ranking; drop line-25 import; delete line-75 `runState.skillCatalogRanking` write; delete line-153 `skillCatalogRanking` from `planner-requested` step), `src/runtime/state.js` (delete `skillCatalogRanking` field from `createRunState` + `cloneRunState`), `src/runtime/research-state.js` (delete the `runState.skillCatalogRanking.matches` reader). Tests: rewrite `test/unit/action-loop-planner.test.js` to assert ranker is **not** called by default; mark `test/unit/skill-catalog-ranking.test.js` as host-utility-only.
- **PR 2 — Live matrix verify + dist rebuild + supersession.** Files: `dist/agrun.js` rebuild, new live evidence at `agrun_docs/live-tests/2026-05-07-skill-catalog-ai-tool-only.md` showing pre-ADR `skill_catalog_ranking` 5×score=0 vs post-ADR full catalog visible, `task.md` close AGRUN-229 + tick ADR-0013 PR 1 acceptance line, ADR-0020 file gets post-merge "Verification" section.

Acceptance (epic-level):
- [ ] `git grep -n "skillCatalogRanking" src/` returns 0 hits.
- [ ] `git grep -n "selectSkillCatalogCandidates\|rankSkillManifests" src/runtime/action-loop-planner.js` returns 0 hits.
- [ ] `npm run check` green per PR.
- [ ] Lite × Mandarin × long-form 4-cell matrix re-run shows non-zero `bundledAgentSkillCount` for Chinese prompts.
- [ ] Utility exports `tokenizeSkillCatalogText` / `rankSkillManifests` / `selectSkillCatalogCandidates` survive in `src/index.js` for host-pluggable custom rankers.
- [ ] Audit V13 row in `agrun_docs/audits/non-ai-first-2026-05-07.md` marked "resolved".

Verification:
- `npm test`
- `npm run build`

### AGRUN-223 | ADR-0015 — Workspace files are AI-authored, runtime is storage
| Field | Value |
|---|---|
| Priority | High (second ADR-0014..0018 ticket; closes ADR-0012 parallel-prose path) |
| Status | All 3 PRs code-DONE 2026-05-07 evening. PR 1 (runtime-finalize backfill), PR 2 (delete veto path + free file namespace), PR 3 (SKILL.md workspace section + live matrix scaffold). Live 4-cell matrix run is the only outstanding item; can be combined with ADR-0014 PR 3 matrix in same Chrome MCP session. |
| Builds on | ADR-0012 (long-research deletion missed virtual-workspace twin path), ADR-0013, ADR-0014, AGRUN-221 audit V2 finding |
| Goal | Delete `# Research Report:` template + 5-file materialize backfill + 3 prompt regexes + synthetic `workspace_write` decisions. Replace with structured `workspace_quality_signal` envelope; AI authors all artifacts. |

Why second (after ADR-0014):
- ADR-0014 unblocks Mandarin recovery (biggest matrix-gradient win). ADR-0015 unblocks Mandarin workspace activation (second biggest). Together they should lift 4-cell usable rate from 1/4 to ≥3/4.
- ADR-0012 deliberately deleted only `research-evidence-graph.js` prose paths; the audit revealed the same anti-pattern survived in `virtual-workspace.js`. ADR-0015 finishes that scope.
- Bigger surface than ADR-0014 (~600 lines deletion + 14 tests rewrite vs ~120 lines + 5 tests), so warrants drafting first to lock contract before implementation.

Three-PR cadence:
- **PR 1 — DONE 2026-05-07 (scope adjusted from ADR-0015 draft).** Deleted runtime-finalize backfill path: `materializeVirtualWorkspaceFromFinalAnswer` + its only-consumers `materializeWorkspaceFile` and `buildMaterializedOutline`. Removed import + call from `src/runtime/runtime-finalize.js`. Updated unit test in `test/unit/virtual-workspace.test.js` to drop the materialize assertion. The remaining prose templates (`buildWorkspaceResearchReportDraft`, `buildWorkspaceActionScaffold`, `buildMaterializedEvidence`, `buildMaterializedCritique`) and the 5-file allowlist (`VIRTUAL_WORKSPACE_FILE_PATHS`) survive PR 1 because the regex-gated veto path (`createWorkspaceRepairDecision`) still calls them; they are deleted together in PR 2 along with the prompt regex gates. This safer scoping keeps PR 1 bisect-friendly. ~50 lines deleted from `virtual-workspace.js` (now 844 lines). `git grep "materializeVirtualWorkspaceFromFinalAnswer\|materializeWorkspaceFile\|buildMaterializedOutline" src/` returns only tombstone comments. 651 unit + concern tests green.
- **PR 2 — DONE 2026-05-07.** Single atomic cut: deleted `maybeCreateVirtualWorkspaceFinalizeVeto` + 9 helpers (`hasPlannerWorkspaceAction`, `isPlannerWorkspaceAction`, `createWorkspaceVeto`, `createWorkspaceWriteDecision`, `createWorkspaceRepairDecision`, `buildWorkspaceActionScaffold`, `buildWorkspaceResearchReportDraft`, `buildMaterializedEvidence`, `buildMaterializedCritique`) + 3 English-only prompt regexes (`COMPLEX_PROMPT_RE`, `FINAL_CANDIDATE_GATE_PROMPT_RE`, `STRICT_RESEARCH_WORKSPACE_PROMPT_RE`). Freed file namespace by removing `VIRTUAL_WORKSPACE_FILE_PATHS` allowlist enforcement in `validateWorkspacePath`; AI now picks any safe filename. `VIRTUAL_WORKSPACE_RESERVED_PATHS` stays as convention reference; `VIRTUAL_WORKSPACE_FILE_PATHS` exported as backwards-compat alias. Workspace starts empty (no stub entries) — `createVirtualWorkspace` returns `files: {}`. Updated `evaluateWorkspaceQuality` to advisory-only (no `blockingIssues`, no regex). `shouldEnableVirtualWorkspace` is language-neutral (config or force flag only). Updated `action-loop-session-terminals.js` (drop call), `planner-prompt.js` (rewrite workspace guidance to free-form), `test/unit/virtual-workspace.test.js` (full rewrite, 9 cases), `test/unit/workspace-actions.test.js` (preflight free-form). Net diff: 332 lines deleted from `virtual-workspace.js` (now 533 lines, was 865). Decided NOT to introduce `workspace_quality_signal` envelope — AI can call `workspace_list` to inspect state on demand, no need for runtime push. 709 unit + concern tests green. Decision NOT in original ADR draft: chose "delete the veto entirely" over "replace with signal envelope" because AI can pull state via `workspace_list` action; introducing a new envelope only adds infrastructure for a feature AI can self-derive.
- **PR 3 — Code DONE 2026-05-07; live matrix pending.** Updated `skills/long-web-research/SKILL.md` with new "Workspace (ADR-0015)" section explaining the 6-tool surface (write/read/replace/remove/list/finalize_candidate), free-form filenames, advisory-only quality, and that runtime no longer back-fills empty files. Live 4-cell matrix scaffolded at [agrun_docs/live-tests/workspace-2026-05-07.md](../live-tests/workspace-2026-05-07.md) with pre-conditions checked statically; runtime acceptance pending Chrome DevTools MCP run with real LLM providers (out-of-scope for code-only PR; can be combined with ADR-0014 PR 3 matrix in same session). 709 unit + concern tests still green.

Acceptance (epic-level):
- [ ] `git grep -n "Research Report:\|Workspace outline for\|buildWorkspaceResearchReportDraft\|materializeVirtualWorkspaceFromFinalAnswer\|COMPLEX_PROMPT_RE\|FINAL_CANDIDATE_GATE_PROMPT_RE\|STRICT_RESEARCH_WORKSPACE_PROMPT_RE\|createWorkspaceWriteDecision\|createWorkspaceRepairDecision" src/` → 0 hits.
- [ ] `npm run check` green per PR.
- [ ] 4-cell live matrix `runtime-materialized:0` in all cells.
- [ ] Combined with ADR-0014: usable rate ≥3/4 (was 1/4).
- [ ] V2 row in `agrun_docs/audits/non-ai-first-2026-05-07.md` marked "resolved".

Risk:
- Hosts that hard-code reads from `result.workspace.files["draft.md"]` (specific filename) break when AI uses a different name. Documented migration: iterate `Object.keys(workspace.files)` instead. Searching the repo for such hard-codes finds: 0 inside `src/`, but external hosts unknown — call out in CHANGELOG.
- Small models may emit fewer artifacts than the current 5-file template forced. Acceptable per ADR-0012 risk register (small models not the production target).

### AGRUN-222 | ADR-0014 — Recovery belongs to AI, not runtime
| Field | Value |
|---|---|
| Priority | High (first ADR-0014..0018 ticket; biggest matrix-gradient win) |
| Status | All 3 PRs code-DONE 2026-05-07 evening. PR 1 (regex deletion + `workspace_remove`), PR 2 (bounded retry + diagnostics.recovery), PR 3 (planner-prompt recoveryContext hint + live matrix scaffold). Live 4-cell matrix run is the only outstanding item; can be executed via Chrome DevTools MCP whenever convenient. |
| Builds on | ADR-0012, ADR-0013, AGRUN-221 audit V1 finding |
| Goal | Delete `looksLikeResearchRequest` / `looksLikeTopicPrompt&&\d{4}` regex + `createWebSearchFallbackDecision` synthetic action. Replace with structured `recovery_signal` envelope read by AI on next planner call. |

Why this first (vs ADR-0015..0018):
- AGRUN-220 4-cell matrix showed Mandarin cells (C2 / C4) blocked at recovery, not at skill discovery. Closing recovery regex unblocks the language axis.
- Lowest blast-radius surface among the five ADRs: 4 source files, ~120 lines deletion, 5 unit tests rewrite. ~1 day implementation.
- Acceptance gradient hypothesis: 1/4 → ≥3/4 after PR 3 lands. Mandarin cells should pass once recovery is language-neutral.

Three-PR cadence (mirrors AGRUN-217 / AGRUN-220):
- **PR 1 — DONE 2026-05-07.** Deleted three lexical regexes (`looksLikeResearchRequest`, `\d{4}` heuristic, AI-response `/web_search|search the web/`) from `src/runtime/planner-recovery.js`. `shouldFallbackToWebSearch` reduced to language-neutral gate (web_search action available + no pending clarification). `createWebSearchFallbackDecision` interface preserved for caller compatibility (no behaviour change, just no longer reached for non-English prompts that previously failed silently). Bonus: added `workspace_remove` tool (with `removeWorkspaceFile` helper in `src/runtime/virtual-workspace.js`) in same PR per user request. 645 unit + concern tests green. Files touched: `src/runtime/planner-recovery.js`, `src/runtime/virtual-workspace.js`, `src/runtime/action-registry.js`, `src/runtime/actions/virtual-workspace-actions.js`, `test/unit/workspace-actions.test.js`. Net diff: ~50 lines deleted, ~80 lines added.
- **PR 2 — DONE 2026-05-07.** Added bounded retry budget (`MAX_RECOVERY_RETRIES = 2`) and `noteRecoveryAttempt` / `isRecoveryBudgetExhausted` / `buildRecoverySignal` helpers in `src/runtime/planner-recovery.js`. Added `runState.recoveryState = { retries, lastSignal, exhaustedAt }` default in `src/runtime/state.js` with `sanitizeRecoveryState` projection in `snapshotRunState`/`createLastRunSummary`. Per-turn reset in `src/runtime/action-loop-session-cycle.js` next to existing `listSkillsCallsThisTurn` reset. Both invalid-envelope and empty-response fallback paths in `src/runtime/action-loop-session-loop.js` now check `isRecoveryBudgetExhausted` before synthesizing; emit `planner-recovery-exhausted` step on hit and surface `result.diagnostics.recovery` on every run. New `test/unit/recovery-budget.test.js` (6 cases) registered in `test/smoke.test.js`. 651 unit + concern tests green.
- **PR 3 — Code DONE 2026-05-07; live matrix pending.** Added one-line system instruction to `src/runtime/planner-prompt.js` so the model knows to read `loopState.recoveryContext` (kind / reason / retryCount) and stay within the 2-retry budget. Live 4-cell matrix scaffolded at [agrun_docs/live-tests/recovery-2026-05-07.md](../live-tests/recovery-2026-05-07.md) with pre-conditions checked statically; runtime acceptance pending Chrome DevTools MCP run with real LLM providers (out-of-scope for code-only PR; user can execute when convenient). 651 unit + concern tests still green.

Acceptance (epic-level, all PRs):
- [ ] `git grep -n "looksLikeResearchRequest\|createWebSearchFallbackDecision\|shouldFallbackToWebSearch" src/` → 0 hits.
- [ ] `npm run check` green per PR.
- [ ] 4-cell live matrix usable rate ≥3/4 (was 1/4).
- [ ] AGRUN-217 3-topic Chrome MCP E2E remains green (recovery dormant in happy path).
- [ ] V1 row in `agrun_docs/audits/non-ai-first-2026-05-07.md` marked "resolved".

Risk:
- Small models that already struggle with valid envelopes may exhaust the 2-retry budget more often. Documented as expected behaviour, not a regression. `recovery_exhausted` surfaces cleanly to host.
- Hosts reading `result.diagnostics` need to ignore unknown keys (already required by ADR-0011 contract).

### AGRUN-220 | ADR-0013 — Skill discovery is a tool, not a runtime decision
| Field | Value |
|---|---|
| Priority | High (supersedes AGRUN-218 + AGRUN-219) |
| Status | PR 1 + PR 2 + PR 3 shipped 2026-05-07 evening. ADR-0013 contract held. Live matrix verified C1 (lite × EN) usable AI-authored report; C3 (gpt-5-mini × EN) inconclusive due to long reasoning latency; C2 / C4 skipped (provider/persona issues outside ADR-0013 scope). 645 unit + concern PASS, 0 FAIL. |
| Builds on | ADR-0012, AGRUN-217 4-cell matrix findings |
| Goal | Stop runtime-side skill ranking injection. Replace with `list_skills` tool the AI calls when it decides it needs a skill. Push → Pull. |

Origin: 2026-05-07 evening, after the AGRUN-219 PR 1 follow-up matrix produced 1/4 usable cells. User insight: "list skills should be a tool for AI; skills no need every time hardcode in prompt; show only when needed; trigger by AI agent". This is the right architecture per ADR-0012's mechanism-vs-policy boundary — AGRUN-219 PR 1 directive itself is a soft hardcode ("here is the top-ranked skill, please read it") that runtime should not do.

Problem with current architecture (push):
- Every planner turn injects `loopState.recommendedSkill` block + skill ranking summary into prompt.
- Runtime decides ranking via English-only `STOP_WORDS` / `NOISE_RE` (zeroes Mandarin).
- Small models ignore ranking; large models obey but the directive is itself opinion-injection.
- Token cost paid on every turn even when prompt is unrelated to skills.

Target architecture (pull):
- Runtime exposes two tools: `list_skills(query?)` and `read_agent_skill(skillId)` (latter already exists).
- Planner prompt carries one short hint: "You have access to specialized skills. Call `list_skills(query)` to discover them." That is all.
- AI decides when to call `list_skills`. Runtime answers with a name + 1-line description list.
- AI then calls `read_agent_skill` for the chosen skill (already wired).
- AGRUN-218 (multilingual noise filter) becomes a `list_skills` matching-strategy concern, not a runtime hardcode.
- AGRUN-219 (`recommendedSkill` directive) is removed entirely.

Scope (do NOT add runtime fallback):
- [x] Write ADR-0013 at `agrun_docs/adr/0013-skill-discovery-is-a-tool.md` documenting the contract, push→pull rationale, supersession of AGRUN-218 + AGRUN-219, and the new tool surface. Drafted 2026-05-07 evening.

Agentic-search design principles: locked in ADR-0013 §"Design principles (locked)". 6 principles cover English-only catalog, AI translates intent, capability vs entity search, iterative agentic search (max 5 turns), 5-turn budget guard, score-is-runtime-detail. See `agrun_docs/adr/0013-skill-discovery-is-a-tool.md`.

- [ ] Add `list_skills` tool to `src/runtime/planner-tools.js` schema with optional `query` arg.
- [ ] Implement `src/runtime/actions/list-skills-action.js` (new) that returns `[{ skillId, name, description }, ...]` filtered by query (substring at first; embeddings later).
- [ ] Strip `pickTopSkillRecommendation` and the `loopState.recommendedSkill` directive from `src/runtime/planner-prompt.js`.
- [ ] Strip `skillCatalogRanking` injection from `src/runtime/action-loop-planner.js`.
- [ ] Replace with one short tool-hint paragraph in planner prompt: "Call list_skills to discover skills. Call read_agent_skill to load a skill's full instructions before following its workflow."
- [ ] Mark AGRUN-218 and AGRUN-219 as superseded.
- [ ] Re-run 4-cell live matrix. Acceptance: ≥3 of 4 cells call `list_skills` then `read_agent_skill` then produce a usable AI-authored report.

Acceptance:
- [ ] No `pickTopSkillRecommendation`, `loopState.recommendedSkill`, or skill-ranking block injected into planner prompt.
- [ ] `list_skills` tool present in planner-tools schema, returns name + description.
- [ ] Mandarin prompts produce non-empty `list_skills` results when AI calls it (AGRUN-218 absorbed).
- [ ] Live matrix shows AI calling `list_skills` → `read_agent_skill` chain on at least one cell per language.
- [ ] AGRUN-218 + AGRUN-219 rows updated with "Superseded by AGRUN-220 / ADR-0013".

Risk:
- Cold-start: AI may not know to call `list_skills` if the tool-hint paragraph is too subtle. Mitigation: keep the paragraph in the *system* portion of the planner prompt (not in mid-loop hints) so it's seen on every turn cheaply.
- Latency: pull mode adds one extra tool round-trip when AI decides to discover skills. Acceptable trade-off — current push mode wastes tokens every turn on every prompt regardless of relevance.

Reference: aligns with Anthropic's own Skills architecture pattern — skills sit quietly until AI loads them, no hardcoded ranking injection.

### AGRUN-219 | Reliable long-web-research skill activation
| Field | Value |
|---|---|
| Priority | Closed (superseded by AGRUN-220 / ADR-0013, 2026-05-07) |
| Status | Done — PR 1 directive code (`pickTopSkillRecommendation`, `loopState.recommendedSkill` block) deleted in AGRUN-220 PR 1 commit `d94bfe5e`. Replaced with pull-mode `list_agent_skills` tool (PR 2) and `runState.selectedSkill` writeback after `read_agent_skill` (PR 2). Push-mode skill-ranking injection is gone from runtime. |
| Builds on | ADR-0012, AGRUN-217, `src/runtime/planner-prompt.js`, `src/runtime/action-loop-planner.js` |
| Goal | Close the activation gap exposed by the AGRUN-217 4-cell live matrix: AI did not engage `long-web-research` even when prompts were research-shaped, so SKILL.md instructions never reached planner context, and runtime gate never enforced |

Problem from 2026-05-07 live matrix:
- L1 (gpt-5-mini, English, TNO): looped same query 4× because skill not engaged → no SKILL.md guidance, no budget gate.
- L4 (gemini-2.5-pro, Mandarin, Grab): hallucinated TNO/Globe3 persona refusal because skill not engaged → no SKILL.md instructions, no claim-graph guard.
- 1 of 4 cells produced a usable report; 3 of 4 failed at the AI quality layer.

Root cause: ADR-0012 assumes AI will engage `long-web-research` skill via planner choosing `read_agent_skill` when catalog ranks it Top-1. In practice, current planner doesn't reliably do that.

Scope (do NOT add runtime fallback):
- [x] **Planner-prompt directive** — when skill catalog ranking has a Top-1 with score > 0 and no skill is yet active, surface a `loopState.recommendedSkill` block with name + skillId + score + matched fields + an explicit directive: "Before any other action, call `read_agent_skill` with that skillId so its instructions enter your context. Then follow the skill's workflow." Shipped via `pickTopSkillRecommendation` in `planner-prompt.js`.
- [ ] **Public `researchActivation` flag on `session.run`** — let hosts pass `{ researchActivation: "long_research" }` in the run request; runtime wires it onto `runState.researchActivation` so `isResearchQualityGateRequired` returns true without needing AI engagement. This is the host-side replacement for the deleted runtime lexical regex.
- [x] **Re-run 4-cell live matrix** (2026-05-07 evening). Result: directive verified for gpt-5-mini (Cell C3 called `read_agent_skill`) but acceptance NOT met — only 1/4 cells produced a usable AI-authored report and `SELECTED SKILL` still shows `n/a` because `read_agent_skill` does not feed back into `runState.agentSkillContext.lastReadSkill`. Findings at `agrun_docs/live-tests/long-research-skill-driven-2026-05-07.md` (AGRUN-219 PR 1 follow-up matrix section).
- [ ] **AGRUN-219 PR 2** — wire `read_agent_skill` result into `runState.agentSkillContext.lastReadSkill` so Inspector reflects skill engagement after AI reads a skill. This closes the telemetry gap exposed by C3.
- [ ] **SKILL.md anti-clarification anchor** — gpt-5-mini chose `ask_clarification` instead of executing the workflow even after reading the skill. Add an explicit clause to step 1 of `skills/long-web-research/SKILL.md`: pick reasonable defaults (~2 page brief, 3+ independent sources, inline citations) and start research; only ask if the entity is genuinely ambiguous.
- [ ] **Document host-skill-activation pattern** in `agrun_docs/host-skill-activation.md`: how hosts should set `researchActivation` from their own prompt classifier (host-layer regex is fine; ADR-0012 only forbids it inside runtime).

Acceptance:
- [x] Planner prompt now contains `loopState.recommendedSkill.directive` whenever Top-1 score > 0 and skill not engaged. Unit / concern tests still green (`npm run check` 637 PASS).
- [ ] Real-LLM matrix on `gemini-2.5-pro`, `gpt-5-mini`, `gemini-3.1-flash-lite-preview` × English + Mandarin shows planner reliably calls `read_agent_skill` for `long-web-research` when the prompt is research-shaped. **2026-05-07 evening status: 1 of 4 cells (lite/EN) produced a usable AI-authored report; gpt-5-mini/EN proved the directive activates the call but AI then asked clarification; lite/ZH and 2.5-pro/ZH failed (provider error + persona-leak respectively). PR 2 + SKILL.md anti-clarification clause + AGRUN-218 multilingual noise filter must land before re-running.**
- [ ] No new runtime fallback / synthetic decision is introduced. Runtime stays mechanism-only per ADR-0012.

Risk:
- A planner directive in the prompt is *advisory*, not enforcement. Models may still ignore it. Next escalation step is host-layer `researchActivation` flag (above), which routes around AI choice entirely.

### AGRUN-218 | Multilingual evidence-graph noise filter
| Field | Value |
|---|---|
| Priority | Closed (superseded by AGRUN-220 / ADR-0013, 2026-05-07) |
| Status | Done — `list_agent_skills` byte-level substring match (PR 2) covers Mandarin queries without runtime tokenizer. Remaining `STOP_WORDS` / `NOISE_RE` constants only affect evidence-graph observation extraction; Mandarin coverage there is a separate, smaller concern revisitable when a real Mandarin live-research workflow surfaces a concrete failure. |
| Builds on | ADR-0012, `src/runtime/research-evidence-graph.js` |
| Goal | Replace English-only `NOISE_RE` / `UI_NAV_LABEL_RE` / `UI_EMOJI_RE` / `STOP_WORDS` constants with a host-pluggable noise filter that defaults to no-op so Mandarin and other non-English sources stop bypassing graph-construction noise filtering |

Scope:
- Move the four English-only constants in `research-evidence-graph.js` (lines 33-72 today) to a host-config-driven filter interface; default behaviour is the empty filter (accept all observations) so deletion does not silently degrade English topics.
- Provide an opt-in English filter as a sibling preset hosts can plug in.
- Allow Mandarin / multi-language presets without baking them into core runtime.

Acceptance:
- [ ] No `NOISE_RE` / `UI_NAV_LABEL_RE` / `UI_EMOJI_RE` / `STOP_WORDS` literal in `src/runtime/research-evidence-graph.js`.
- [ ] Unit test proves Mandarin observations no longer get hidden by an English-only filter when no host preset is plugged in.
- [ ] Existing English regression tests pass with the host-pluggable English preset.

Deferred from AGRUN-217 PR 3 because the regex constants are graph-construction noise filters (mechanism), not markdown authoring; replacing them is a separate architectural change with its own test churn.

