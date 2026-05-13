# ADR-0015 — Workspace files are AI-authored, runtime is storage

Status: Proposed (2026-05-07)
Builds on: ADR-0012 (long-research belongs to skill), ADR-0013 (skill discovery is a tool), ADR-0014 (recovery belongs to AI)
Ticket: AGRUN-223 (parent epic AGRUN-221)

## Context

ADR-0012 deleted ~1300 lines of long-research markdown authoring from
`research-evidence-graph.js` (`compileResearchReportFromEvidence`,
`compileMinimalResearchFallback`, ~20 prose formatters). The AGRUN-221
audit (2026-05-07) found the **same anti-pattern survived in
`src/runtime/virtual-workspace.js`** — a parallel push-mode authoring
path with five distinct violations:

### V2.1 — Templated `# Research Report:` prose
[virtual-workspace.js:551-609](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/virtual-workspace.js)
literally writes:

```
# Research Report: ${topic || "Requested Topic"}
## Summary
This report is based on N directly read public source(s)…
## What is supported
- ${title} (${url}): ${quality} source.
## Source quality
This run found N strong, N medium, N weak, and N thin source(s).
## Evidence gaps
…
## Claim coverage
…
## Sources
- [${title}](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/adr/${url})
```

Q3 ✅ — runtime authors user-facing prose. Identical pattern to the
deleted `compileResearchReportFromEvidence` from ADR-0012.

### V2.2 — `materializeVirtualWorkspaceFromFinalAnswer` writes 5 files
[virtual-workspace.js:412-445](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/virtual-workspace.js)
fires from [runtime-finalize.js:180](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/runtime-finalize.js)
on every final-answer terminal. When AI's `final_candidate.md` is
empty, runtime backfills:
- `outline.md` — `# Workspace outline for ${topic}…` template
- `evidence.json` — runtime-built JSON from `researchWorkspace`
- `draft.md` — falls back to `buildWorkspaceResearchReportDraft`
  (templated prose above)
- `final_candidate.md` — clones `draft.md`
- `critique.md` — runtime-built quality summary

Q1 ✅ — runtime decides which 5 files exist. Q3 ✅ — runtime prose.

### V2.3 — Three English-only regex on user prompt
[virtual-workspace.js:15-17](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/virtual-workspace.js):

```js
const COMPLEX_PROMPT_RE = /\b(long[-\s]?run|research|report|deep\s+(?:thinking|research|analysis)|compare|comparison|analysis|investigate|multi[-\s]?turn|multi[-\s]?step|draft|final\s+report|source\s+quality|evidence\s+gaps?)\b/i;
const FINAL_CANDIDATE_GATE_PROMPT_RE = /\b(long[-\s]?run|research|deep\s+(?:thinking|research|analysis)|investigate|source\s+quality|evidence\s+gaps?|final\s+report)\b/i;
const STRICT_RESEARCH_WORKSPACE_PROMPT_RE = /\b(long[-\s]?run|research|deep\s+(?:research|analysis)|investigate|source\s+quality|evidence\s+gaps?|final\s+report)\b/i;
```

Q4 ✅ — three regexes decide whether workspace activates / strict mode
applies. Mandarin / non-English prompts always return `false` →
workspace stays disabled or veto never fires → AI never knows it
should write artifacts.

### V2.4 — Runtime-synthesised `workspace_write` veto decisions
[virtual-workspace.js:294-410](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/virtual-workspace.js)
`maybeCreateVirtualWorkspaceFinalizeVeto` returns synthetic
`workspace_write` decisions when the workspace is "incomplete":

```js
return createWorkspaceVeto({
  decision: createWorkspaceWriteDecision({
    content: answer || buildWorkspaceResearchReportDraft(runState) || …,
    path: "draft.md",
    summary: "wrote required draft before final answer"
  }),
  …
});
```

Q1 ✅ — runtime picks file path, content, and order. Q5 ✅ — runtime
"fixes" AI's missing artifact by writing it itself.

### V2.5 — Hard-coded 5-file allowlist
[virtual-workspace.js:3-9](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/virtual-workspace.js):

```js
export const VIRTUAL_WORKSPACE_FILE_PATHS = Object.freeze([
  "outline.md", "evidence.json", "draft.md", "critique.md", "final_candidate.md"
]);
```

Q1 partial — runtime decides AI's filesystem layout. Different
research types (legal brief / engineering RFC / market analysis) want
different file shapes.

### Combined impact

Live evidence: AGRUN-220 4-cell matrix C4 (gpt-5-mini × Mandarin)
showed `runtime-materialized:5` while `planner-written:0` — runtime
authored every workspace file because the regex-gate left workspace
disabled and the materialize step backfilled at finalize-time.

## Decision

**Runtime owns workspace storage + structural quality signal. AI owns
file authorship, prose, and file shape.**

Concrete contract:

1. **Delete `materializeVirtualWorkspaceFromFinalAnswer` entirely.** No
   runtime-backed file backfill. If AI did not write a file, the file
   is empty. Period.

2. **Delete `buildWorkspaceResearchReportDraft` (the `# Research
   Report:` template).** No runtime prose for any workspace file.

3. **Delete `buildWorkspaceActionScaffold` (the `# Workspace outline
   for…` template).** Same reason.

4. **Delete `buildMaterializedOutline` / `buildMaterializedEvidence` /
   `buildMaterializedCritique`.** All three synthesise prose JSON or
   markdown for AI-owned files.

5. **Delete the 3 prompt regexes.** Workspace activation no longer
   gated by English keyword on prompt. New rule:
   - Workspace is enabled if AI calls `workspace_write` once, OR
   - Host explicitly enables via config `virtualWorkspace.enabled = true`,
     OR
   - Active skill declares `workspace: true` in its manifest (additive
     skill metadata, default false).

6. **Replace `maybeCreateVirtualWorkspaceFinalizeVeto` decision
   manufacturing with structured signal.** New shape:

   ```jsonc
   {
     "kind": "workspace_quality_signal",
     "issues": ["missing_final_candidate" | "missing_draft" | "missing_evidence" | "missing_critique" | "draft_equals_outline" | …],
     "files": { "outline.md": { "exists": true, "chars": 312, "version": 2 }, … },
     "vetoCount": 1
   }
   ```

   The signal is read by AI via planner prompt context (next turn). AI
   decides whether to write missing artifact or finalize as-is. Runtime
   never returns `decision: { name: "workspace_write", … }`.

7. **Drop the hard-coded 5-file allowlist.** Replace with a free
   namespace under `workspace.files`. AI picks its own filenames. Path
   validation keeps the security mechanism (`validateWorkspacePath`):
   no `..`, no absolute paths, no overwriting reserved
   `_runtime/*` namespace if any. Default file count budget = 16,
   host-overridable.

8. **Quality evaluator survives as mechanism.** `evaluateWorkspaceQuality`
   returns structural signals (file exists / file too short / draft
   equals outline). It does NOT recommend a fix; it reports state. AI
   reads the signal in its next planner prompt and decides.

## Tool surface (no public API breakage)

`workspace_write` / `workspace_replace` / `workspace_finalize_candidate`
keep their current signatures. New behaviour:
- File path is free-form (subject to `validateWorkspacePath`).
- No reserved file required.
- No 5-file limit.

`result.diagnostics.workspace` adds:

```ts
{
  files: Array<{ path: string; chars: number; version: number; updatedAt: string }>;
  qualityIssues: Array<"missing_final_candidate" | …>;
  vetoCount: number;  // how many times a quality signal was emitted
}
```

`result.workspace` (the legacy host-facing snapshot) keeps the same
top-level shape. Only the file dictionary becomes free-form.

## Design principles (locked)

1. **Runtime never authors prose.** Continuation of ADR-0012. ADR-0015
   closes the parallel virtual-workspace prose path that survived
   ADR-0012.
2. **Runtime never picks file paths or layout.** AI owns workspace
   shape. Path validation is mechanism (security).
3. **Workspace activation is opt-in, not regex-on-prompt.** AI calls
   `workspace_write` → workspace turns on. Or host config / skill
   manifest declares it. No language-detection.
4. **Quality signals are structural, not prose.** `issues: [enum…]` —
   AI reads enum codes, not English instructions.
5. **Veto = signal, not synthetic action.** Same pull-mode pattern as
   ADR-0014. Runtime says "you're missing X"; AI decides next move.

## Alternatives

1. **Keep templates, add Mandarin / Spanish / etc translations.**
   Rejected — same anti-pattern as ADR-0014 alternative 1. Doesn't
   scale.
2. **Make templates host-pluggable (host injects its own report
   template).** Rejected — pushes prose authorship to host. AI is
   already a language model; host shouldn't author user-facing prose
   either. Skills can carry a recommended template if they want.
3. **Move templates to `skills/long-web-research/SKILL.md` as
   reference output.** Accepted as additive — SKILL.md may recommend
   structure ("consider sections: Summary, Sources, Gaps"). But the
   skill instructs AI; AI authors the report. Not a runtime path.
4. **Delete virtual-workspace.js entirely.** Rejected — file storage
   + version tracking + path validation are real mechanism. AI needs
   a place to put intermediate work. Keep storage; drop policy.

## Consequences

Pros:
- Removes ~500 lines of prose authoring + ~120 lines of regex/veto
  logic from `virtual-workspace.js`.
- Mandarin / non-English prompts get workspace activation parity once
  AI calls `workspace_write` (no language gate).
- AGRUN-220 C4 cell `runtime-materialized:5` → `runtime-materialized:0`
  expected. Forces AI to author every artifact.
- Skills can declare workspace shape per use-case (legal brief vs RFC
  vs market analysis vs simple Q&A).

Cons:
- Hosts that read `result.workspace.files["draft.md"]` by hard-coded
  filename break. Mitigation: ADR documents migration; host should
  iterate `result.workspace.files` keys instead.
- AI on small models may emit fewer files than the current 5-file
  template forced. Acceptable: small models are not the production
  target (per ADR-0012 risk register).
- 4 unit tests in `test/unit/virtual-workspace.test.js` (~14
  assertions) need rewrite — most assert on synthetic workspace_write
  decisions or runtime-materialised content.

Risks:
- AI might never call `workspace_write` and finalize directly. Result:
  no workspace files at all. **This is the desired behaviour for
  simple prompts.** For complex prompts where the host wants forced
  workspace usage, host config `virtualWorkspace.enabled = true` keeps
  the gate active; the gate now emits a signal asking AI to write,
  rather than runtime writing it.
- ADR-0012 deleted-but-not-fully-removed: live runs may have grown
  habits around the 5-file template. Mitigation: PR 3 includes a
  4-cell matrix re-run + AGRUN-217 3-topic regression check.

## Implementation cadence — 3 sequential PRs

Mirror AGRUN-217 / AGRUN-220 / AGRUN-222 cadence.

### PR 1 — Delete prose authoring + 5-file allowlist

Files modified:
- `src/runtime/virtual-workspace.js`
  - Delete `buildWorkspaceResearchReportDraft` (line 551-609).
  - Delete `buildWorkspaceActionScaffold` (line 525-549).
  - Delete `buildMaterializedOutline` / `buildMaterializedEvidence` /
    `buildMaterializedCritique` (line 643-720).
  - Delete `materializeVirtualWorkspaceFromFinalAnswer` (line 412-445).
  - Delete `materializeWorkspaceFile` helper (line 622-635).
  - Replace `VIRTUAL_WORKSPACE_FILE_PATHS` Object.freeze with
    `RESERVED_WORKSPACE_PATHS` (empty Set, host-extendable). Existing
    file iteration (`createVirtualWorkspace`, `listWorkspaceFiles`,
    `buildVirtualWorkspacePromptBlock`) iterates `Object.keys(workspace.files)`.
- `src/runtime/runtime-finalize.js:180`
  - Remove `materializeVirtualWorkspaceFromFinalAnswer` import + call.
- `test/unit/virtual-workspace.test.js`
  - Delete tests asserting on `buildWorkspaceResearchReportDraft`
    output, `materializeVirtualWorkspaceFromFinalAnswer` writes,
    5-file allowlist enforcement.

Acceptance:
- [ ] `git grep -n "Research Report:\|Workspace outline for\|buildWorkspaceResearchReportDraft\|materializeVirtualWorkspaceFromFinalAnswer" src/` → 0 hits.
- [ ] `npm run check` green.

### PR 2 — Replace regex-gated veto with structured workspace_quality_signal

Files modified:
- `src/runtime/virtual-workspace.js`
  - Delete `COMPLEX_PROMPT_RE`, `FINAL_CANDIDATE_GATE_PROMPT_RE`,
    `STRICT_RESEARCH_WORKSPACE_PROMPT_RE` (line 15-17).
  - Refactor `shouldEnableVirtualWorkspace` (line 106-112) to drop
    prompt regex; activation = config `enabled === true` OR skill
    manifest declares OR AI called `workspace_write` once.
  - Refactor `maybeCreateVirtualWorkspaceFinalizeVeto` (line 294-410)
    to return:
    ```jsonc
    {
      "kind": "workspace_quality_signal",
      "issues": ["missing_final_candidate", …],
      "files": { … snapshot … },
      "vetoCount": N
    }
    ```
    No `decision` field. No `createWorkspaceWriteDecision` callsite.
  - Delete `createWorkspaceWriteDecision`, `createWorkspaceRepairDecision`
    (line 470-509) entirely.
- `src/runtime/action-loop-session-terminals.js:62`
  - Consume the new signal shape; pass via planner-prompt
    `loopState.workspaceQualitySignal` instead of acting on a runtime
    decision.
- `src/runtime/planner-prompt.js`
  - Render `workspaceQualitySignal` block as structured context (similar
    to ADR-0014 recoveryContext): "Workspace quality issues: missing
    final_candidate. Files: outline.md(312 chars), evidence.json(0
    chars). Either write the missing artifact or finalize as-is."
- `test/unit/virtual-workspace.test.js`
  - Replace 14 assertions on synthetic decisions with assertions on
    `kind: "workspace_quality_signal"` shape.

Acceptance:
- [ ] `git grep -n "COMPLEX_PROMPT_RE\|FINAL_CANDIDATE_GATE_PROMPT_RE\|STRICT_RESEARCH_WORKSPACE_PROMPT_RE\|createWorkspaceWriteDecision\|createWorkspaceRepairDecision" src/` → 0 hits.
- [ ] `npm run check` green.

### PR 3 — Live matrix verification + skill-driven workspace activation

Files modified:
- `skills/long-web-research/SKILL.md`
  - Add `workspace: true` to manifest (or document expected `workspace_write`
    sequence). Update step 11-12 to clarify AI authors all 5 sections
    in `final_candidate.md` directly.
- `agrun_docs/live-tests/workspace-2026-05-XX.md` (new)
  - 4-cell matrix (lite/gpt-5-mini × EN/ZH).
  - Acceptance: `runtime-materialized:0` in all cells; AI either
    writes workspace files or finalizes without them; no
    runtime-authored prose anywhere in `result.workspace`.
- `agrun_docs/audits/non-ai-first-2026-05-07.md`
  - Mark V2 row resolved.
- `agrun_docs/public-runtime-api.md`
  - Document free-form workspace file namespace and
    `result.diagnostics.workspace` shape.

Acceptance:
- [ ] All 4 cells: `runtime-materialized:0` (was 0/1/?/5 in baseline).
- [ ] AGRUN-217 3-topic Chrome MCP E2E remains green.
- [ ] Live matrix report committed.

## Rollback

If post-PR matrix shows regression vs baseline:
1. `git revert` the PR 1 deletions (prose templates restored).
2. PR 2 signal infrastructure stays — it is additive.
3. Re-open ticket and document the failure mode in the audit doc.

## Files to modify (full list)

```
agrun_docs/adr/0015-workspace-files-are-ai-authored.md   (new — this file)
agrun_docs/live-tests/workspace-2026-05-XX.md            (new — PR 3)
agrun_docs/public-runtime-api.md                         (PR 3)
agrun_docs/audits/non-ai-first-2026-05-07.md             (PR 3 — mark V2 resolved)
skills/long-web-research/SKILL.md                        (PR 3)
src/runtime/virtual-workspace.js                         (~600 line deletion + ~80 line addition)
src/runtime/runtime-finalize.js                          (drop materialize call)
src/runtime/action-loop-session-terminals.js             (consume signal shape)
src/runtime/planner-prompt.js                            (render workspaceQualitySignal block)
test/unit/virtual-workspace.test.js                      (rewrite ~14 tests)
task.md                                                  (mark AGRUN-223 in flight)
```

## Verification

1. Static checks per PR: `npm run check` (645 unit + concern tests).
2. Grep gates per PR-1 acceptance.
3. Live 4-cell matrix per PR-3 acceptance.

## Non-goals

- No change to `validateWorkspacePath` security mechanism.
- No change to `workspace_write` / `workspace_replace` /
  `workspace_finalize_candidate` action signatures.
- No removal of workspace from `result` shape — hosts still see file
  list, just free-form.
- No i18n of `planner-prompt.js` workspace-signal rendering (tracked
  separately).
- No removal of `workspaceQualitySignal` itself (it is mechanism).

## Confirmed decisions

1. **Hard-cut deletion in PR 1.** No deprecation cycle for
   `materializeVirtualWorkspaceFromFinalAnswer` — same rationale as
   ADR-0013 / ADR-0014. Soft deprecation only delays churn.
2. **Free-form file namespace replaces 5-file allowlist.** Skills /
   AI choose filenames. `validateWorkspacePath` security mechanism
   stays.
3. **`workspace_quality_signal` is internal** — surfaced to AI via
   planner prompt context, not via public API. `result.diagnostics.workspace`
   shows the file snapshot + issues for hosts (read-only).
4. **Skill manifest may declare `workspace: true`** as additive
   metadata. Default false; when true, runtime keeps workspace
   activated even if AI hasn't called `workspace_write` yet — useful
   for hosts that want forced artifact authoring.

## Post-merge verification

- AGRUN-220 4-cell matrix re-run: target `runtime-materialized:0` in
  all cells.
- AGRUN-217 3-topic Chrome MCP E2E: must remain green.
- AGRUN-221 audit V2 row marked "resolved by ADR-0015".
- Combined with ADR-0014: 4-cell usable rate target ≥3/4 (1/4 baseline).
