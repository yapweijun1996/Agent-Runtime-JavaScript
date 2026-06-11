# Research and Evidence Model

## Purpose

This document describes how agrun.js tracks research progress and exposes
evidence-quality observations. The AI/skill decides when to gather more
information, draft with limitations, or publish.

For the full execution flow, see `agrun_docs/agentic-execution-flow.md`.
For the continuity model, see `agrun_docs/context-and-continuity-model.md`.
For documentation authority and conflict resolution, see
`agrun_docs/architecture-ssot.md`.

## Current Authority

ADR-0012 and ADR-0054 are the current long-research architecture decisions. This document
describes the kept research mechanism: search/read state, evidence quality,
source authority, evidence graphs, source scoping, budget accounting, and
Inspector/debug projections.

It is not authority for runtime-owned long-research policy. If older sections,
live-test notes, or historical examples describe runtime-authored reports,
fixed search-query backstops, prompt-regex activation, or runtime-selected
research actions, treat that material as historical and superseded by
ADR-0012 / AGRUN-217.

Current long-research boundary:

- Runtime owns mechanism: source authority scoring, duplicate detection, loop
  budget, state lifecycle, raw evidence graph construction, counters, and
  structured observations.
- AI / `long-web-research` owns policy: workflow, queries, next action choice,
  report depth, output language, and user-facing prose.
- Runtime observations must not synthesize `web_search`, `read_url`,
  `workspace_write`, or `todo_plan` decisions.
- Runtime must not compile fallback user-facing research reports.

## Research Context

The `researchContext` is a structured object maintained in `runState` across OODAE cycles:

```text
ResearchContext
 ├ searchResults[]          — raw search results from web_search actions
 ├ aggregatedSearchResults[] — merged and deduplicated results across searches
 ├ readSources[]            — URL read results with quality classification
 ├ verification             — verification state object
 └ verificationState        — summary verification status
```

## Web Search

### Search Flow

When the planner decides to search:

1. `web_search` action is executed
2. Search query is planned via `web-search-planner.js` (query refinement)
3. Results are ranked via `web-search-ranking.js`
4. Raw results are stored in `searchResults`
5. Aggregated (deduplicated) results are stored in `aggregatedSearchResults`

### Search Resilience

Web search passes are protected by two layers of resilience:

1. **Per-fetch timeout + retry**: Each search API call (SearXNG or Gemini grounding) uses `fetchWithRetry` from `fetch-resilience.js` with a 15 s timeout and 1 retry on transient failures.

2. **Multi-pass deadline**: The `web_search` action wraps all passes in a `withDeadline(45s)` context. If the deadline expires mid-loop, the action returns results gathered so far rather than failing entirely.

If a single pass times out or throws a transient error, the loop breaks gracefully — partial results from earlier passes are preserved and returned.

See `agrun_docs/error-handling-and-recovery.md` → "Fetch Resilience" for the full timeout/retry table.

### Gemini Grounding Synthetic Fallback

Since mid-2025, Gemini's `google_search` tool no longer returns `groundingChunks` (actual source URLs). The API returns `webSearchQueries` and embeds search knowledge in the model's text answer, but no clickable source links.

When `groundingChunks` is empty but the model produced a grounded text answer:

1. `gemini-grounding.js` builds **synthetic items** from the model text + grounding queries
2. Each synthetic item has `synthetic: true`, a snippet from the model answer, and an empty `url`
3. The ranking pipeline (`web-search-ranking.js`) accepts items with `snippet` even without `url`
4. `hasUsableSearchEvidence()` treats synthetic items as usable evidence

This ensures the planner/finalize pipeline receives evidence and does not loop endlessly retrying a search that will never return URLs.

SearXNG remains the preferred provider when real source URLs are needed (e.g., for `read_url` follow-up).

### Search Result Structure

Each search result contains:

- URL (may be empty for synthetic grounding items)
- Title
- Snippet/description
- Source ranking metadata
- `synthetic` flag (true when generated from Gemini grounding text, not a real URL)

### Result Aggregation

Multiple searches across cycles are aggregated:

- Duplicate URLs are deduplicated
- Synthetic items (no URL) are preserved separately and appended after deduplication
- Results are re-ranked based on combined signals
- The aggregated list is what continuity resolution uses to decide next reads

## URL Reading

### Read Flow

When a URL is read through a planner-selected `read_url` action:

1. `read_url` action is executed
2. URL content is fetched via the configured read service (10 s timeout via `AbortController`)
3. If the fetch times out or fails transiently, the action retries once (1.5 s delay)
4. Content is processed and quality-assessed
5. Result is added to `readSources[]`

### Browser Read-URL Service Adapter

The browser example must read third-party pages through the configured read-url
service. It must not fall back to direct browser fetches for external pages:
third-party sites usually do not grant CORS access to the browser app, and a
direct fallback turns a service outage into misleading `cors_blocked` evidence.
Configure the service through browser settings or ignored local environment
variables:

```bash
READ_URL_ENDPOINT=https://readurl.yapweijun1996.com/read-url
READ_URL_API_KEY=your-read-url-key
```

The adapter accepts either a service base URL or the full `/read-url` endpoint.
It normalizes direct reads to:

```http
POST /read-url
```

The request body follows the runtime `read_url` intent:

```json
{
  "url": "https://example.com",
  "includeScreenshot": false,
  "waitUntil": "domcontentloaded",
  "timeoutMs": 20000
}
```

For repeatable browser QA, open the example with debug and a clean QA session:

```text
/?debug_yn=y&skill_provider=public&qa_clean=y&qa_reset_settings=y&qa=read-url-live
```

`qa_clean=y` clears chat/runtime state. `qa_reset_settings=y` is QA-only and
also clears stale browser settings so the page reloads current development
defaults from `.env.local`. Omit `qa_reset_settings=y` when intentionally
testing a user's persisted settings.

The browser adapter sends the configured key as `x-api-key`. Hosts may also
support bearer auth behind the same service, but agrun docs and bundled skills
must not contain real keys.

If the service endpoint is unavailable, the browser adapter returns a structured
`READ_URL_SERVICE_UNAVAILABLE` read failure. It does not retry by fetching the
target URL directly from the browser.

Do not guess alternate reader paths such as `/read`, `/fetch`, `/scrape`,
`/v1/*`, `/api/*`, `/reader`, `/parse`, or `/markdown`. A degraded health
check does not by itself prove page reads are broken; trust the actual
`read_url` action result and surface its error if the read fails.

Single-URL reads are not multi-target news reports. A prompt such as "read this
URL and return the title/source" may ask for a source URL, but it must not
activate the multi-target current-news coverage fallback that rewrites missing
country/entity sections into "evidence insufficient" stubs. That coverage logic
is reserved for news/headline/current-events prompts with real requested
targets.

### Read Source Quality Tiers

Each read source is classified into a quality tier:

| Tier | Meaning |
|------|---------|
| `strong` | High-quality, relevant content successfully extracted |
| `usable` | Content extracted but may be partial or less relevant |
| `weak` | Minimal useful content extracted |
| `blocked` | Content could not be accessed (paywall, bot protection, error) |

For long-run handle/profile/project research, first-party source quality has an
additional generic signal. If the research query contains a distinctive
handle/brand/project token and the read URL domain/path/title matches that
token, the source can be classified as `strong` when the extracted text is
substantial, or `usable` when it is shorter but still meaningful. Marketplace
and community URLs are excluded from this uplift. This helps the runtime treat
topic-owned sites and relevant code/profile pages as stronger evidence without
hardcoding a specific username, product, repository host, or QA domain.

### Quality Counting

The runtime tracks counts per tier:

- `strongReadSourceCount`: Number of strong sources
- `usableReadSourceCount`: Number of usable + strong sources
- `blockedPageEvidenceCount`: Number of blocked sources

These counts inform continuity decisions and planner guardrails.

## Evidence State Classification

`classifyEvidenceState()` produces a summary classification:

| State | Condition |
|-------|-----------|
| `none` | No search results and no read sources |
| `partial` | Some evidence exists but may be insufficient |
| `sufficient` | Strong or multiple usable sources available |

The evidence state flows into:

- Planner state (informs planner decisions)
- Guardrail evaluation (prevents premature finalization)
- Continuity resolution (decides whether to continue research)

## Evidence Banner (Inspector-Layer SSOT)

When `read_url` calls fail in bulk (e.g. 502 from the read_url service)
or all reads land on blocked challenge pages, the developer Inspector
must surface the degraded state without the runtime silently substituting
search snippets for failed reads.

**Single helper, Inspector surface.** `summarizeEvidenceBanner(readSources, evidenceState)`
in `examples/browser/src/components/inspector-debug-report.ts` is the
sole computer of this Inspector banner. It returns `null` for healthy
reads or a typed `EvidenceBanner` for one of three regression kinds:

| Kind | Trigger | Tone |
|------|---------|------|
| `read_url_all_failed` | every readSource has `ok === false` | bad |
| `read_url_partial_failure` | some readSources have `ok === false` | warn |
| `read_url_all_blocked` | every readSource has `tier === 'blocked'` | bad |

**Surfaces:**

- `InspectorEvidenceSection` renders the same banner as a top chip card
  with `evidence:<state>`, `read_url_failed:N/M`, and `kind:<kind>` chips
  for QA and AGENT debugging.
- The banner wording must explain impact and next check. Partial failures mean
  some page bodies were unavailable while other reads may still be usable; next
  checks should point to failed URL/status rows, read windows, and Live Trace
  `read_url` action outcomes.
- Normal assistant chat cards do not render this diagnostic banner.
  If a limitation should be user-visible, it must be written into the
  assistant answer itself instead of injected as debug UI chrome.

**Push-mode invariant.** The runtime never injects synthetic snippet
content into `researchContext.readSources`. Failed reads stay as
`ok === false` envelopes; web_search snippets stay in `searchResults`.
The AI sees both channels and decides whether to retry, swap query, or
finalize with declared limitations. The banner is observation-only — it
does not change runtime behavior. `examples/browser/test/inspector-debug-report.smoke.ts`
asserts the helper outputs and the SSOT shape so future regressions are
caught at smoke time.

## Virtual Workspace Materialization

Long-run research can also use the generic `virtualWorkspace` artifact layer.
The planner is encouraged to draft `outline.md`, `evidence.json`, `draft.md`,
`critique.md`, and `final_candidate.md` before answering. However, live browser
QA showed that a planner may still skip the workspace after bounded evidence
retries. To keep the Inspector truthful and avoid depending on prompt obedience,
the runtime finalization harness now materializes missing virtual workspace
artifacts from sanitized state:

- `outline.md` comes from `researchWorkspace.draft.outline` when available.
- `evidence.json` contains source titles, URLs, HTTP status, quality tier,
  final-readiness reason, remaining evidence gaps, and source-quality counts.
- `draft.md` and `final_candidate.md` use the final user-facing answer.
- `critique.md` records evidence gaps and the reminder not to expose internal
  workspace logs.

This is not chain-of-thought exposure and does not write real files. It is a
debug/presentation projection so browser QA can see `candidate:ready` and the
draft/evidence boundary even when the planner did not explicitly call every
workspace action.

For long-run research/source-quality prompts, workspace quality observations are
stricter than simple file presence. The runtime can flag missing
`evidence.json`, `draft.md`, `critique.md`, or `final_candidate.md`, and it
flags `draft_same_as_outline` / `final_candidate_same_as_outline` when those
files are only the outline. These observations are exposed to the AI and the
browser Inspector as Workspace Quality Warnings; they do not reintroduce the
deleted kernel-seam hook enforcement.

Inspector workspace wording should translate raw chips into engineering next
checks:

- `candidate:missing` means no final candidate artifact is ready; inspect
  candidate lifecycle paths, latest operations, and Raw `virtualWorkspace`.
- `needs_repair` means a candidate exists but failed a quality observation; inspect
  Workspace Quality Warnings, Pending Patch, and the last workspace action.
- `structure:fail` means the candidate has missing, duplicated, or incorrectly
  numbered sections; inspect Structure Repair Context and section hints.
- `candidate is empty` means the selected final candidate has no publishable
  body; inspect file previews, finalCandidateStats, and active candidate path.

These messages are Inspector-only diagnostics and must not be injected into
normal assistant chat cards.

The final answer has an additional claim-coverage boundary. When the research
state still has evidence gaps or too few relevant sources, agrun records
claim-coverage diagnostics internally and uses them to guard source scope and
unsafe claims. It does not insert a runtime-authored `Claim coverage` section
into the user-facing answer. The Inspector Evidence panel shows the runtime
`claimCoverage` summary: status, source count, supported/unsupported claim
counts, issue codes, and sampled claim candidates.

constrained-evidence research is guarded through structured claims instead of a
runtime-authored prose rewrite. If only constrained source coverage is available,
the runtime marks high-risk biography/company/project claims as included,
downgraded, or omitted in `claimGraph[]` and exposes that through internal
diagnostics. The AI finalizer owns the final wording; runtime source
normalization prevents unsupported sources from appearing in the final
`Sources` section.

## Research Report Observation

Long-run research reports use `runState.researchReportLoop` as a runtime-owned
observation slot. It observes current search/read/workspace state, evaluates
evidence readiness, records source and authority gaps, and returns structured
guidance signals to the planner/finalizer.

This observation layer does not own the research workflow. If the planner tries
to finalize a long-research request before creating real research tasks, the
runtime may record a structured signal such as `research_plan_required` for the
next AI step. It must not fabricate a canned `todo_plan`, fixed `web_search`
query, `read_url` target, workspace artifact, or final report.

Long-research activation is explicit. It happens when the active agent skill is
`long-web-research`, the planner declares `mode: "long_research"`, or the host
opts in. Runtime must not infer long-research mode from English prompt regexes.
Natural prompts can still route to long research when the skill/planner selects
that mode, but the runtime does not guess from prompt wording.

Coverage targets are planner/skill-owned research policy. Runtime may report
observed gaps such as missing source minimum, missing primary/official
authority, missing independent corroboration, or unsupported high-risk claims.
It must not convert those gaps into fixed entity-type coverage templates or
search-query strings.

The opt-in research skill pack's source-minimum observations are conservative:

- `minReadSources: 3`
- `minRelevantSources: 2` (`strong` plus `usable`/medium)
- `maxIndependentSearchAttempts: 2`

If the source minimum is not met, the runtime reports the missing source counts,
authority gap, recent searches, zero-result queries, and candidate evidence
state in the planner prompt. The planner must choose the next research move,
such as a fresh `web_search` query, a specific `read_url`, or a constrained-evidence
draft when evidence is exhausted. The action loop can flag repeated `web_search`
queries that already appear in the research search history, so the agent does
not loop on the same empty template.

Long-run progress is tracked by the generic session budget, not by a
research-only counter. Successful `web_search`, `read_url`, TodoState mutation,
virtual workspace write/finalize, and skill-tool actions advance a shared
session progress marker. This prevents false `no_progress` termination for
normal step-by-step agent work where the useful actions are not
`execute_skill_tool` calls. Read-only inspection actions such as
`todo_inspect`, `workspace_list`, and `workspace_read` do not count as forward
progress by themselves.

Independent-source attempts are counted only when an actual planner-owned
`web_search` executes. The report loop may tell the planner which authority gap
is missing, but it does not increment attempt counters for guidance alone. If
the planner executes a search after an independent-source guidance step, that
search is charged to the independent coverage budget even when the query is
topic-specific and generated by the planner. This keeps the runtime as the
bounded loop/accounting layer while leaving query strategy to the agent.

Progress accounting is also runtime-owned and generic. The session budget
advances only when a real action changes research state: a new search query,
a URL read attempt, a TodoState mutation, a workspace artifact version, or a
skill-tool result. Repeated search skips, repeated planner guidance, and
unchanged workspace rewrites are not treated as research progress. When the
workspace artifacts are complete and authority coverage is still missing after
bounded attempts, the loop should converge to a final answer with explicit limitations instead of
returning to the planner for more identical searches.

When independent corroboration is the only missing coverage, the loop still
keeps the report in final-with-limitations mode until the planner either finds usable
independent evidence or the bounded research budget is exhausted. The runtime
owns the stop condition and the disclosure requirement; the planner owns the
search strategy.

The loop also writes a claim evidence table to
`researchWorkspace.claimEvidence[]` and `researchReportLoop.claimEvidence[]`.
Each entry has `claim`, `supportStatus`, `sourceIds`, `riskKind`, and
`reason`. High-risk claims such as employment, company, education, profile
directory, dates, metrics, and project details require direct evidence. Without
direct source support, the final answer must mark those claims as unverified or
omit them.

### Evidence Graph and Final Envelope

Long-run report finalization is AI-first. The runtime does **not** own the
normal user-facing report prose. It builds a structured
`runState.researchEvidenceGraph` from actual `readSources[]`, then materializes
a small `runState.researchFinalEnvelope` that the AI finalizer can use when
writing the report. Runtime remains the harness observation layer; AI owns the
report strategy, wording, and synthesis.

The evidence graph contains:

- `sourceArtifacts[]`: sanitized source id, URL, title, source type, quality
  tier, quality explanation, source-authority detail, snippet, and extracted
  text length.
- `entity`: the resolved research entity with canonical name, aliases, inferred
  type, public identifiers, official URLs, confidence, and unresolved questions.
- `observations[]`: short direct observations extracted from readable source
  text.
- `claimEvidence[]`: source-observation claims plus planner-draft claims that
  were checked and marked `direct`, `partial`, or `unverified`.
- `claimGraph[]`: the source-authority decision for each claim. Each row records
  whether the claim can be included, must be downgraded, or must be omitted.
- `authorityCoverage`: primary/official plus independent corroboration coverage
  for full-report eligibility.
- `coverage`: owner-controlled / repository / profile-directory / independent
  coverage flags.
- `sourceMinimum`: read-source count and relevant-source count used by the
  long-research report-loop observation.
- `evidenceGaps[]`: user-facing limitations such as missing independent
  corroboration or unverified employment/education claims.

The final envelope contains internal finalization metadata:

- `finalMode`: `full_report` or `final_with_limitations`.
- `includedClaimIds`, `downgradedClaimIds`, and `omittedClaimIds`: the runtime
  claim-gate decisions.
- `finalSourceIds`: the only source ids allowed in the end-user `Sources`
  section.
- `evidenceGaps`: limitations available to the finalizer and Inspector when
  relevant.

Final citation SSOT is:

```text
claimGraph decision=include
  -> supportingSourceIds/sourceIds
  -> finalSourceIds
  -> final Sources
```

The final source list must not be reconstructed from final prose, source
titles, filtered findings, or search-result fallback text. If no claim is
included, `finalSourceIds` is empty. Blocked, off-topic, profile-directory,
context-only, rejected, and search-result-only sources remain visible in
Inspector / Debug Report / Support Bundle, but do not become end-user
citations.

The harness follows these rules:
- Source authority is evaluated before final synthesis. Registry/business
  records and repositories can be primary evidence for the claim kinds they
  actually support; official/owner-controlled sources are self-claims;
  independent media/report/review sources provide corroboration; social/profile
  directories and advertorial/profile pages are not allowed to verify
  high-risk claims by themselves.
- Registry/primary authority must come from registry-like source labels,
  hosts, URLs, or titles. A normal article body that happens to mention
  "registered" or "company profile" must not be promoted to primary authority.
  Advertorial/profile sources such as magazine profile pages remain contextual
  evidence unless another stronger source corroborates the claim.
- Official/owner-controlled source recognition uses the generic
  `research-domain-ownership` helper as the SSOT. It compares distinctive
  entity tokens from the topic against the registrable domain label, not against
  full page text, subdomain noise, or a fixed allowlist of known QA domains.
  This lets the agent use first-party sources when they are genuinely
  topic-owned without hardcoding TNO, Vite, usernames, or any other live-test
  entity.
- A source must pass topic-relevance admission before it can produce direct
  observations or claim evidence. The harness extracts distinctive topic
  tokens and rejects readable but off-topic pages as `topic_mismatch`; these
  sources may remain in debug/source-quality metadata, but they cannot become
  final findings.
- Multi-token topics also use descriptor relevance. A page that matches the
  entity name but points to a different subject, product class, or project
  meaning cannot become final evidence unless enough descriptor tokens or
  phrases also match. The planner can still inspect those results, but the
  runtime will not let same-name off-topic content verify claims.
- The final report prose is AI-owned. Runtime uses source observations and
  claim decisions to guard citations and unsafe claims, but it does not replace
  the final answer with an evidence-graph compiled fallback report.
- Planner-draft claims are kept for inspection and blocking, but direct-looking
  planner prose is not allowed to become final evidence by itself.
- Source identity observations such as "this website was read" or "this
  repository page was read" stay in debug metadata only. They do not become
  user-facing findings or claim-coverage rows.
- The AI finalizer groups source observations into readable report findings.
  Runtime may provide structured observations and claim decisions, but it does
  not author source-attributed prose, repository summaries, or reasoned
  interpretation text.
- Relevant source minimums count only non-profile sources that produced at
  least one non-identity observation. A page that was read but contributed no
  finding may appear in debug metadata, but it is not counted as final relevant
  evidence.
- Profile-directory and social-profile sources such as LinkedIn, Instagram,
  Facebook, X/Twitter, TikTok, Threads, Pinterest, Crunchbase, and people
  directories are non-verifying for employment, company, education, and private
  biography claims. They are not exposed as final sources unless a future host
  explicitly changes the policy.
- Full-report readiness observations include the source minimum and independent
  authority coverage. If the run has only owner-controlled/profile/repository
  evidence, or only profile/advertorial context, the runtime records limited-mode
  diagnostics internally; it must not force a user-facing `Research Report`
  title.
- The OODAE report loop exposes missing coverage while budget remains. Passing
  the numeric source minimum alone is not enough for the AI to honestly claim a
  full report when independent corroboration is absent.
- Final `Sources` are scoped to sources that backed included claim-graph
  decisions.
  Read URLs that only produced chrome/noise text such as GitHub support,
  report-abuse, privacy, legal-name, or personal-information boilerplate are
  filtered out of findings and citations.
- Rejected, blocked, duplicate, and context-only sources remain visible in the
  Inspector, Debug Report, and Support Bundle. They are not default end-user
  citations unless they back a final user-facing finding.
- User-facing text must not expose internal claim-graph reason codes or gate
  diagnostics. Internal labels such as
  `high_risk_claim_lacks_required_source_authority`, source-minimum counters,
  source-quality buckets, workspace/OODAE/TodoState/debug wording, and
  final-with-limitations status stay in Inspector / Debug Report / Support Bundle.
- Bot-protection challenge pages and low-value directory pages are evidence
  artifacts, not final findings. Text such as Cloudflare "Just a moment",
  "Attention Required", `cf_chl` challenge payloads, RecordOwl-style company
  profile directories, and generic "Job Openings / Career opportunities" lines
  can appear in Inspector source diagnostics, but cannot create observations,
  claim evidence, final synthesis bullets, or clickable final citations.
- Browser/app chrome and repository README implementation details such as
  placeholder tool menus, `npm install`, design tokens, documentation overview,
  workflow diagrams, and other low-value project-internal text are filtered out
  of final synthesis and claim coverage.
- Source collection must use `finalSourceIds` before applying display limits,
  so the final report never cites a source that did not support an included
  claim.
- When the evidence graph has no direct final findings, it sets the scoped
  evidence URL set to empty. Final-source normalization must then omit
  fallback search-result citations instead of attaching unrelated links.

When the provider returns an empty finalizer response, runtime may prefer an
already captured planner final answer. It must not use the evidence graph
compiler to author a new user-facing report.

This is a harness layer, not a hardcoded topic rule. Live QA topics are
regression scenarios only; they must not appear in runtime source-quality,
authority, query, or report-content rules.

### Planner Empty-Response Recovery

Provider adapters already retry Gemini empty text/tool responses once. The
action loop can also surface structured planner recovery signals when a
research turn receives a recoverable empty response (`no text`, `empty
response`, or no function/tool call). Under ADR-0012, recovery must not turn
into a hidden deterministic research strategy. The runtime may retry, repair,
or ask the planner to choose the next action, but it must not synthesize a
fixed `web_search` or `read_url` decision for long research.

Invalid planner envelopes use the same boundary. Runtime may emit structured
repair feedback such as `planner-fallback-applied` or
`planner-invalid-action-fallback`, and action policy still controls execution.
For long research, the planner/skill remains responsible for selecting the
next action.

Runtime finalization does not compile a deterministic user-facing report from
the evidence graph. If finalizer output is empty, runtime may prefer an already
captured planner final answer or surface a structured provider/finalizer
failure. It must not emit an evidence-graph compiled fallback report.

Browser Inspector projects the same state as a Research OODAE timeline and a
Claim Evidence table. Debug Report includes `[research_report_loop]` and
claim evidence lines. Support Bundle keeps the sanitized runtime object so QA
can see whether the final report came from a passed source minimum or a limited
brief fallback.

Browser chat also renders a compact end-user research progress timeline for
long-research runs. It is presentation-only and derived from sanitized runtime
steps, research loop cycles, and workspace actions. It can show high-level
states such as searching, reading, drafting evidence, evaluating coverage, and
finalizing, but it does not expose raw reasoning, raw tool arguments, API keys,
or provider payloads.

The deterministic quality harness includes a 10-topic benchmark covering
owner-only evidence, owner plus independent evidence, social/profile-only
sources, thin/blocked reads, high-risk claims, noisy UI chrome, conflicting
claims, missing source metadata, coverage failure after numeric source minimum,
and a full-report-allowed case. The benchmark requires zero unsafe claims,
zero noise leaks, and final-with-limitations output whenever required coverage is
missing.

## Research Continuity Signals

The runtime no longer resolves research continuity into a pre-built action. It
records search/read state and exposes `readAttemptSignal` as a read-only signal
to the next planner cycle.

### Signal Shape

| Field | Meaning |
|-------|---------|
| `attemptCount` | Number of recorded `read_url` results in the current research context |
| `threshold` | Informational threshold for the AI to notice repeated reads |

The planner prompt tells the AI to choose the next move itself: read a different
URL, run a fresh search, finalize with limitations, or take another available
action. The runtime does not pick the URL and does not finalize when the
threshold is reached.

## Verification State

The research system includes a verification layer:

```text
VerificationState
 ├ verified    — claims verified against sources
 ├ unverified  — claims not yet checked
 └ conflicting — sources disagree
```

Web search verification (`web-search-verification.js`) cross-references claims against read sources to assess reliability.

## Research Flow Example

```text
Cycle 1: ORIENT
  → inputResolution: evidenceState = "none"
  → readAttemptSignal: null (no prior read_url result)
  → DECIDE: planner selects web_search("agrun.js documentation")

Cycle 2: ORIENT
  → searchResults: [url1, url2, url3]
  → readAttemptSignal: null
  → DECIDE: planner/skill selects read_url(url1)
  → ACT: read_url(url1) → strong quality

Cycle 3: ORIENT
  → readSources: [url1=strong]
  → evidenceState: "sufficient"
  → readAttemptSignal: { attemptCount: 1, threshold: 2 }
  → DECIDE: planner returns final answer using evidence
```

## Historical Live Case Studies

Older AGRUN-214m / AGRUN-214n / AGRUN-214o Chrome MCP runs remain useful as
evidence that source authority scoring, blocked-source filtering, topic
preservation, and Inspector diagnostics caught real failures across company,
person/handle, and project prompts.

They are not current architecture authority for long-research strategy. In
particular, any historical note saying that the runtime backstop synthesized a
`web_search` query, authored a `Research Report`, inserted
`Reported but not independently verified`, or collapsed prompts with English
regexes is superseded by ADR-0012 / AGRUN-217.

Current live acceptance for AGRUN-217 must prove:

- AI-authored reports, with no runtime markdown fallback.
- Explicit activation via `long-web-research`, `mode: "long_research"`, or host
  opt-in; no prompt-regex activation.
- Structured observations only; no runtime-synthesized `web_search`,
  `read_url`, `workspace_write`, or `todo_plan` decisions.
- 3-topic coverage across company / person-handle / project prompts on a
  capable model.
- 3 Mandarin prompts producing non-empty AI-authored reports with the same
  activation and observation behavior as English prompts.

## Integration with Planner

The planner receives research context through:

- `searchResults`: Available in planner prompt
- `readSources`: Available in planner prompt with content summaries
- `evidenceState`: Part of planner state
- Action history entries describe prior research actions and their outcomes

This allows the planner to make informed decisions about:

- Whether more searches are needed
- Which URLs to read
- Whether enough evidence exists to answer
- How to synthesize a final answer from multiple sources
