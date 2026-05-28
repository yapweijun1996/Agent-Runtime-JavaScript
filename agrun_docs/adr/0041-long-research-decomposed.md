# ADR 0041 — long-research-decomposed skill (plan-then-write for weak models)

Status: DRAFT (advisor review pending)
Date: 2026-05-27
Related: AGRUN-244 Phase 3, commit 32d4a7921 (Fix A), KB items `051379af`/`f5ccf06b`/`f0978bd4`/`a1bbd535`

## Goal

Stable long-form (1200+ word) markdown reports from lite-tier models
(gemini-3.1-flash-lite, gpt-4o-mini, haiku) by removing the single
hardest task they fail at: holding global structure (heading numbering,
section dependencies, length budget) while generating prose token-by-token.

Research backing (websearch 2026-05-27):
- LongWriter / AgentWrite (arXiv 2408.07055) — 9B model beats much larger
  proprietary models on >2k word output using plan-then-write decomposition.
- arXiv 2410.06203 (planning-in-single-turn), arXiv 2502.19103 (LongEval).
- RANLP 2025 — heading renumbering is regex/AST work, never LLM work.
- arXiv 2404.17140 — small LMs cannot self-verify, need external verifier.

## Non-goals

- Replace deep-research-writer for pro-tier models. They handle monolithic
  draft writing fine; the decomposition tax (more LLM calls, more context
  juggling) hurts them.
- Solve "AI loops past completion" / lite-tier maxSteps overruns. That's
  AGRUN-256/AGRUN-263 territory.
- Build a JSON-tree renderer that supports nested lists / footnotes / etc.
  v1 is flat sections with optional level-3 subsections.

## Architecture

Three new pieces, no deletions:

### Piece 1: `skills/long-research-decomposed/SKILL.md`

New skill. Activation contract: same `mode: "long_research"` declaration in
the first plan envelope (reuses existing planner mode gating, no new mode
keyword). Runtime selects this skill over `deep-research-writer` when
isLiteTierModel(model) returns true; pro-tier still routes to the old skill.

Phases (loop, not sequence — same shape as old skill):
- A: decompose question
- B: web_search + read_url (unchanged)
- C: cross-reference (unchanged)
- **D-new: outline first.** Emit a single `outline.json` via
  `workspace_write_outline_json`. NOT free-form markdown. JSON schema
  enforced by runtime; invalid JSON gets rejected with the validation error
  appended to the prompt for next cycle.
- **E-new: write sections one at a time.** For each section in outline,
  write `sections/<id>.md` with `workspace_write` containing ONLY body
  markdown (no heading line, no section number). Body must hit
  target_words ± 30%.
- F: critique per section (read sections/<id>.md, write critique-<id>.md
  if needed, rewrite that one section). Skill explicitly forbids
  cross-section critique on lite-tier (per "Small LMs Need Strong
  Verifiers").
- **G-new: assemble.** Call `workspace_assemble_final`. Runtime composes
  final_candidate.md from outline + sections deterministically (numbering,
  ordering, validation). AI never writes the heading numbers.
- H: publish (workspace_publish_candidate, unchanged).

### Piece 2: action `workspace_write_outline_json`

Arguments:
```ts
{
  outline: {
    title: string,         // → # H1 of final report
    sections: Array<{
      id: string,            // filename-safe slug, unique
      heading_text: string,  // no leading #, no number
      level: 2 | 3,          // default 2
      target_words: number,  // 100..800
      key_points?: string[], // optional, max 6
      evidence_refs?: string[] // optional, max 8
    }>
  },
  summary?: string
}
```

Runtime behavior:
1. Validate JSON shape against schema. On fail return
   `status: "schema_invalid"` with `validationErrors[]` listing the path
   and reason for each failure. AI's next cycle sees the errors.
2. Validate id uniqueness, levels in {2,3}, target_words in [100, 800],
   section count in [2, 20]. Each violation → `validationErrors[]`.
3. Persist outline at `outline.json` in the workspace (existing file
   storage; new path is just JSON content).
4. Return `{ status: "ok", outline, suggestedNextSections: [id, ...] }`
   where suggested order is outline order. AI uses this list to drive
   the per-section writes.

Tier: 0 (same as workspace_write).

### Piece 3: action `workspace_assemble_final`

Arguments: `{ summary?: string }`. No path argument — assembler writes
to `final_candidate.md` by convention (matches existing finalize path).

Runtime behavior:
1. Read `outline.json` from workspace. If missing → status:"no_outline".
2. For each section in outline order, read `sections/<id>.md`. Missing
   sections → status:"missing_sections" with `missing: [id, ...]`.
3. Compose `final_candidate.md`:
   - Line 1: `# {outline.title}`
   - For each section (sequential numbering): assign next-available
     integer at heading.level, output
     `{'#'.repeat(level)} {N}. {section.heading_text}\n\n{body_content}`
   - Level-3 subsections (if any) interleave under their level-2 parent
     using parent's number + ".1", ".2", etc. v1 keeps it simple: flat
     section list; level-3 only if explicitly placed by parent_id field
     (deferred to v2).
4. Run `inspectWorkspaceCandidateStructure` on assembled content.
   By construction structure.ok should be true; if not, log a runtime
   warning and still proceed (the assembler is the SSOT, downstream
   tools must accept its output).
5. Append `auto_assemble_final` op to workspace.operations.
6. Return `{ status: "ok", file: summarizeFile(final_candidate), wordCount, sectionCount }`.

Tier: 0.

### Skill selection wiring

In `src/runtime/skills/selectSkill.js` (or wherever skill catalog is
resolved — TBD): when `request.mode === "long_research"`, branch on
`isLiteTierModel(request.model)`:
- lite → `long-research-decomposed`
- capable → existing `deep-research-writer`

If new skill bundle missing (host opt-out), fall through to old skill.
No silent failure.

## Why this is AI-first compliant

Runtime does mechanical work (schema validation, heading numbering,
section assembly). Content (outline shape, section bodies, critique
findings) remains AI's. Runtime never decides "this section is bad" or
"add another section". The single decision runtime makes — "duplicate
section number = renumber" — is provably deterministic and stateless.

Contrast with the rejected Phase 2 gate (KB `f0978bd4`): that one forced
the AI to repair structure, pinning lite-tier in unresolvable loops. This
design removes the structure problem from the AI's plate entirely.

## Test strategy

Unit (test/unit/long-research-decomposed.test.js — new file):
1. workspace_write_outline_json happy path (valid JSON → status:ok, file
   persisted, suggestedNextSections matches order).
2. Schema invalid cases:
   - missing title
   - duplicate section id
   - level not in {2,3}
   - target_words out of bounds
   - sections.length out of bounds
   Each returns status:schema_invalid with specific validationErrors[].
3. workspace_assemble_final happy path: outline with 3 sections + 3
   section files → final_candidate.md has `# title`, sections numbered
   1/2/3 in outline order, no duplicates.
4. workspace_assemble_final missing_sections: outline declares 3, only
   2 written → status:missing_sections with missing=[third_id].
5. workspace_assemble_final no_outline: no outline.json → status.
6. Renumbering uniqueness with mixed levels (level-2 sections only at v1
   → simple sequential).

Integration (test/node-long-research-decomposed-live.mjs — new):
Lite-tier prompt that goes through the full A→G flow with a real
provider (gemini key). Asserts:
- outline.json present after Phase D
- ≥3 sections/<id>.md files after Phase E
- final_candidate.md has structure.ok=true after Phase G assemble
- finalCandidateReady=true
- Word count within ±20% of sum of target_words

## Open decisions before coding

1. **Skill activation**: should activation be automatic on
   `isLiteTierModel(model)` + `mode:"long_research"`, or opt-in via a
   new config flag `useDecomposedLongResearch: true`?
   Recommendation: automatic. Hosts can disable via existing
   `disabledSkills:["long-research-decomposed"]` if they prefer the old
   flow.

2. **Filename convention**: sections live at `sections/<id>.md`. The `/`
   in path might collide with existing workspace path validators.
   Need to verify validateWorkspacePathRecoverable accepts single-level
   subdir paths; if not, fall back to `section-<id>.md`.

3. **Level-3 subsections**: defer to v2 to keep v1 surface tight. v1
   only supports flat level-2 sections.

4. **Reuse of long-web-research vs deep-research-writer**: which is the
   "current" lite-tier skill being replaced? Need 5-min audit before
   wiring selectSkill.js.

5. **AGENTS.md / agrun_docs/feature-toggles.md updates**: document new
   actions + skill + tier-aware routing.

## Implementation order

1. Add `validateWorkspacePathRecoverable` test for `sections/<id>.md`
   path. If rejected, decide naming convention. (5 min)
2. Add `workspace_write_outline_json` action + schema validator + tests.
   (2 hr)
3. Add `workspace_assemble_final` action + assembler + tests. (2 hr)
4. Write skill manifest `long-research-decomposed/SKILL.md`. (1 hr)
5. Wire skill selection in catalog resolver. (30 min)
6. Live e2e test with lite-tier provider. (1 hr)
7. Doc updates (feature-toggles.md, AGENTS.md if needed). (30 min)

Total estimate: ~7 hr focused. Plus integration debugging buffer ~3 hr.

## Risks

- **Multi-call cost**: 1 outline + N sections + 1 assemble = N+2 LLM
  calls per report (vs 1-3 today). Token spend grows linearly with
  section count. Acceptable: lite-tier is cheap; per-call quality matters
  more than call count.
- **Per-section context loss**: each section call sees outline + maybe
  previous section summary, not the full evidence corpus. Mitigation:
  include evidence_refs in section prompt; AI re-reads relevant
  read_url snippets per section.
- **Skill selection collision**: if a host has both
  deep-research-writer and long-research-decomposed enabled with the
  same mode, selectSkill needs a clear tie-breaker. Recommendation:
  lite-tier model always wins decomposed.
- **Migration**: hosts currently relying on Phase E self-critique in
  deep-research-writer get a different critique semantic
  (per-section) when their lite-tier traffic shifts to the new skill.
  Document migration note in feature-toggles.md.

## What this does NOT solve

- AI looping past completion (the cycle 80 maxSteps overrun in TNO sess
  2). That needs a separate AGRUN ticket.
- Coverage / evidence quality (still relies on Phase B unchanged).
- Cost predictability for hosts (token spend higher per report).
