# ADR 0012: Long-research belongs to agent skill, not runtime (AGRUN-217)

## Context

agrun.js runtime currently owns ~3000 lines of long-research policy across
three files:

- `src/runtime/research-evidence-graph.js` (1756 lines)
- `src/runtime/research-report-loop.js` (1218 lines)
- `src/runtime/research-state.js` (lexical trigger paths, ~150 lines)

Meanwhile `skills/long-web-research/SKILL.md` already describes the entire
workflow in 50 lines, and the runtime already exposes every primitive the
agent needs to execute it: `web_search`, `read_url`, `todo_*`,
`workspace_*`, and the finalize envelope.

A 2026-05-07 audit identified six categories of harness-boundary violation
where runtime is doing AI work:

1. **Lexical triggers** — `isLongResearchRun()`, `shouldCompileResearchReport()`,
   `hasFinalizeExistingEvidenceIntent()`, `hasExplicitMoreResearchIntent()`
   are English-only regex matchers. Mandarin or variant phrasing fail
   silently and the long-research mode never activates.
2. **Search-query synthesis** — `synthesizeCoverageQuery()` plus
   `buildCoverageQueryCandidates()` write search templates per entity
   type, hardcoding Singapore-specific terms (`UEN registry`, `ACRA`),
   English vocabulary, and only 5 entity kinds (company / handle /
   person / repo / profile).
3. **Action selection** — `createNextResearchAction()` chooses the next
   `read_url` URL; `createMissingWorkspaceDecision()` and
   `createMissingResearchTodoPlanDecision()` synthesize
   `workspace_write` and `todo_plan` decisions on behalf of the
   planner. Runtime is replacing planner choice instead of gating it.
4. **Markdown / prose authoring** — `compileResearchReportFromEvidence()`,
   `compileMinimalResearchFallback()`, and ~20 helper formatters write
   the user-facing report. Runtime owns the H1, the section headings,
   the "Summary" paragraph, the findings ordering, and the Sources block.
5. **English-only filters** — `NOISE_RE`, `UI_NAV_LABEL_RE`,
   `UI_EMOJI_RE`, and the `STOP_WORDS` Set in research-evidence-graph.js
   only match English. Mandarin sites bypass every noise filter and
   pollute the evidence graph.
6. **Display constants hardcoded** — `MAX_DIRECT_FINDINGS = 6`,
   `MAX_SYNTHESIS_FINDINGS = 5`, `MAX_OBSERVATIONS_PER_SOURCE = 2`,
   `MAX_CLAIM_CHARS = 320` are runtime-decided UX policies. The AI
   has no way to influence output length per topic.

This ADR locks the harness contract that resolves the violations:

> Runtime owns mechanism only — authority scoring, duplicate detection,
> loop budget, and a structured gate-signal envelope it returns to the
> AI finalizer.
>
> AI agent owns policy — search queries, action choice, draft / critique /
> final prose, mode selection, output length.

The 3-topic Chrome MCP E2E pass (TNO / yapweijun1996 / Vite) reported in
AGRUN-214m was selection bias: those three topics happen to hit the
hardcoded English + Singapore + 5-entity-type bias. A fourth topic in
Mandarin or referring to a Malaysian company (SSM rather than UEN)
would silently degrade.

CLAUDE.md hard rules being violated:
- *Do not use hardcode logic.*
- *Always use Agentic Harness Engineering* (mechanism / policy split).

## Decision

### 2026-05-11 amendment — planner prompt policy split

AGRUN-217 now also applies to planner/native prompt surfaces:

- `src/runtime/planner-prompt.js` and
  `src/runtime/planner-native-system-prompt.js` may describe tool
  mechanics, action contracts, read-only state, and planner envelope
  shape.
- They must not carry long-research workflow policy such as source
  sufficiency heuristics, workspace packet requirements, exact limited
  publish JSON examples, or broad-search/publish sequencing rules.
- That policy belongs in `skills/long-web-research/SKILL.md`, where the
  AI can read and follow the domain workflow after explicit skill
  discovery/activation.
- TodoState prompt detection defaults are structural only. Runtime may
  detect explicit progress/todo wording, but it must not infer task
  domains like research, news, report, debug, or build from English
  tokens. Hosts that want that behavior must opt in with
  `todoAutopilot.corePattern`, `todoAutopilot.extendedPattern`, or the
  nested `todoAutopilot.detection.*` forms.
- Virtual workspace internal-section stripping has a single runtime SSOT
  in `src/runtime/virtual-workspace.js`, and it must work with free-form
  filenames, not only the reserved conventions.

Verification for this amendment is unit/build scoped unless otherwise
documented in a live-test note. A live provider run is still required to
prove model-quality effects; this amendment only proves the harness
boundary and regression behavior.

### Boundary contract (locked)

**Runtime keeps:**

| Responsibility | Owner module |
|---|---|
| Source authority / quality scoring | `src/runtime/research-source-authority.js` |
| Duplicate / repeat-search detection | `noteResearchCoverageSearchAttempt` |
| Loop budget + state lifecycle | `maybeCreateResearchReportLoopVeto`, `evaluateResearchReportLoop`, `createResearchReportLoopState`, `normalizeResearchReportLoopConfig` |
| Raw evidence graph construction | `buildResearchEvidenceGraph`, `materializeEvidenceGraph`, `createResearchFinalEnvelope`, `classifyResearchClaimRisk`, `collectFinalEvidenceSourceArtifacts`, `collectResearchReportSourceArtifacts` |
| Source-minimum counters | `readSourceMinimum`, `countReadSources`, `countRelevantSources`, `normalizeSourceMinimumWithArtifacts` |

**Runtime loses (deletions in PR 1 → 3):**

- All lexical regex triggers in `research-state.js` and
  `research-evidence-graph.js` that decide whether long-research mode
  activates from user prompt content.
- `synthesizeCoverageQuery`, `buildCoverageQueryCandidates`,
  `guessOfficialDomainHint`, `createNextResearchAction`,
  `createMissingResearchTodoPlanDecision`,
  `createMissingWorkspaceDecision`, `createCoverageTargets`,
  `selectNextSearchCoverageTarget`, `inferCoverageTargetFromSearchQuery`.
- `compileResearchReportFromEvidence` (entire export, including the
  `src/index.js` re-export), `compileMinimalResearchFallback`, and the
  ~20 markdown / prose formatters in research-evidence-graph.js.
- `buildEvidenceJson`, `buildDraftMarkdown`, `buildCritiqueMarkdown`,
  `buildFinalCandidateMarkdown` in research-report-loop.js.
- `NOISE_RE`, `UI_NAV_LABEL_RE`, `UI_EMOJI_RE`, `STOP_WORDS`,
  and the four `MAX_*` display constants.

**AI / SKILL.md owns:**

- Step 1–12 of `skills/long-web-research/SKILL.md`: plan, search, read,
  draft, critique, finalize.
- Choosing search queries (no template).
- Choosing the next read URL.
- Writing all user-facing markdown (no runtime prose fallback).
- Deciding full report vs final answer with explicit limitations based on the *gate signal*.

### Trigger contract (replaces lexical regex)

Long-research mode activates iff at least one of:

1. The active agent skill is `long-web-research` (skill-id match,
   not prompt regex).
2. The current plan envelope carries `mode: "long_research"` (new
   internal harness signal, validated by planner-tools schema, not
   documented as host config in `public-runtime-api.md`).
3. The host explicitly opts in via existing config flag.

No other path activates long-research. Mandarin and English prompts
behave identically because no path inspects prompt text.

### Gate-signal envelope (runtime → AI)

```ts
researchEvidenceGraph: {
  topic,
  observations,         // raw evidence items, not prose
  sourceArtifacts,      // raw, with authority tier per source
  sourceMinimum,        // counts + configured thresholds (no .passed boolean veto)
  claimGraph,           // raw evidence rows, no decision strings
  authorityCoverage,    // counts per kind + flags, no markdown
  evidenceGaps,         // structured codes, not prose
  snippetEvidence       // raw search snippets when reads fail
}

researchFinalEnvelope: {
  finalMode,            // signal value: "full_report" | "final_with_limitations" | "needs_more"
  sourceMinimumStatus,  // structured fields the AI reads
  authorityStatus,      // structured fields the AI reads
  budgetStatus          // structured: cycles used / max, vetoes used / max
}
```

The AI finalizer reads these structured signals and writes the report
in the user's language. Runtime never substitutes prose. There is no
runtime markdown fallback path.

### Persistence-excluded scope

This ADR does not change `agrun_docs/public-runtime-api.md`. The new
`mode: "long_research"` plan-envelope field is an internal harness
signal documented inside this ADR and the planner-tools schema.

This ADR does not change provider error handling, native-tools mode,
approval flow, or any other harness contract.

This ADR does not require any host migration: hosts still get
long-research by attaching the `long-web-research` skill, the same way
they do today.

### Implementation cadence (locked 2026-05-07)

Three sequential PRs under AGRUN-217, arc *Runtime harness contract
hardening*. Each PR runs full `npm run check` plus the 3-topic Chrome
MCP E2E gate before merging:

- **PR 1** — Remove lexical triggers, switch to explicit mode declaration
  via plan envelope and skill activation.
- **PR 2** — Remove runtime action selection (read_url / workspace_write
  / todo_plan synthesis) and runtime search-query synthesis.
- **PR 3** — Remove markdown / prose authoring, English-only filters,
  display constants. Hard-cut `compileResearchReportFromEvidence`
  export and re-export.

After PR 3, `git grep -n "synthesizeCoverageQuery|compileResearchReportFromEvidence|compileMinimalResearchFallback|isLongResearchRun"`
returns zero hits in `src/`.

### Risk

Small models (Gemini Lite et al.) previously needed the AGRUN-214n
runtime backstop. Without runtime backstop, small-model long-research
will produce shorter or incomplete reports. This is the *desired*
failure mode: visible degradation that lets the host route long-research
to a capable model. It is documented in `agrun_docs/live-tests/`, not
patched in runtime.

## Consequences

- Runtime shrinks from ~3000 lines of long-research code to ~600 lines
  of mechanism (authority + budget + duplicate + gate-signal).
- New topic types, languages, and entity kinds no longer require runtime
  changes. They are skill-instruction or AI-ranking changes.
- Test surface shrinks: `test/unit/research-state.test.js` and
  `test/unit/research-evidence-graph.test.js` lose their lexical /
  prose assertions and gain assertions on raw graph structure.
- The `compileResearchReportFromEvidence` export in `src/index.js` is
  removed in PR 3. No host today is known to consume it; a deprecation
  warning step would only delay churn.
- AGRUN-214n runtime backstop (`synthesizeCoverageQuery`) is deleted in
  PR 2. Its purpose — keeping small models from dead-looping on
  guidance vetos — is delegated to skill instructions and host model
  choice. The veto becomes a budget gate, not an action selector.
- The earlier `agrun_docs/research-subsystem-decomposition.md` spike is
  superseded by this ADR. Decomposition into sibling modules under
  `src/runtime/research/**` may still be useful after the deletion
  shrinks the surface, but is no longer urgent and is not part of
  AGRUN-217.

## Verification

For each PR:

- `npm run check` (build + dist:check + smoke + 107 unit + 20 concern)
  green.
- `git grep -n "<deleted symbol>"` returns no hits in `src/` for that
  PR's scope.
- 3-topic Chrome MCP E2E (TNO / yapweijun1996 / Vite) on a capable
  model produces an AI-authored report with no runtime markdown.
- Adding three Mandarin-language topics (`深度调研 [中文公司]`、
  `帮我整理 [中文项目] 的公开资料`、`用现有信息总结一下 [人物]`)
  produces non-empty AI-authored reports — proving lexical triggers no
  longer gate the workflow.
