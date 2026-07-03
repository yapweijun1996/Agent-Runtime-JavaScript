# AGRUN-313 §4.1 — Core Planner-Prompt Domain-Vocabulary Audit (2026-06-12)

**Status:** AUDIT ONLY — no behavior change in this PR. This delivers step 1 of
the staged plan in the [AGRUN-313 pre-assessment](./micro-kernel-313-preassessment-2026-06-12.md)
§4: *"Prompt-vocabulary audit — triage the core planner-prompt research
references into {generic / already-gated / dead}; remove the dead, gate the
domain-specific."*

**Headline result:** the removable-by-prompt-surgery set is **empty (0 dead
references)**. The residual domain vocabulary in the generic prompt is
**generic-mechanism vocabulary entangled with the dormant-but-resident machinery**
(convergence / terminal-repair / requirement-recovery / workspace-publish). It
can only be reduced by **relocating that machinery** (the deferred §4.3–4.4
work), not by editing prompt text. The research-SPECIFIC blocks are already
correctly gated and inert for a generic `agentSkills: []` agent.

Every claim below was spot-verified against current `src/` (file:line cited).

---

## 1. The right metric: words in the RENDERED prompt, not the source grep

The pre-assessment counted ~88 "research" source references in `planner-prompt.js`.
That over-counts: most are data-plumbing helpers and a conditional block that does
not render for a generic agent. The honest metric is **how many domain words
appear in the prompt a generic agent actually receives.** Measured against the
committed snapshot (`test/unit/prompt-snapshot.snapshot.json`), counting
`research | evidence | workspace_publish | acceptance packet | source minimum`:

| Scenario | domain words | breakdown |
|----------|-------------:|-----------|
| `systemPromptLines:globe3-shape` (a NON-research ERP domain) | 8 | evidence×6, workspace_publish×2 |
| `native:native-minimal` | 17 | evidence×10, research×2, workspace_publish×5 |
| `systemPromptLines:compact-full` | 13 | evidence×7, workspace_publish×5, research×1 |
| `systemPromptLines:default-full` | 45 | evidence×19, research×5, workspace_publish×21 |

So the premise holds: even the minimal and the non-research (`globe3`) prompts
carry domain nouns. The question §4.1 answers is **where they come from and
whether any are safely removable.**

---

## 2. Triage — every reference bucketed

| Bucket | Count | What it is |
|--------|------:|------------|
| **GENERIC-MECHANISM** | ~52 | A generic runtime mechanism (actionPatternConvergence, terminalRepairState, requirementRecoveryEvaluator, the workspace-publish finalize contract) that any long-running agent uses. Mentions a domain-flavored noun, but the MECHANISM is generic. |
| **ALREADY-GATED** | ~4 | Renders only when research/skill state is present; inert for generic agents. |
| **DEAD** | **0** | None. |

### 2a. ALREADY-GATED (verified inert for `agentSkills: []`)

- **`researchDirectives` block** — `prompts/research-directives.js` `buildLines`
  gates BOTH the base-mode and compact-mode blocks on
  `(hasAction("read_url") || hasAction("web_search"))`
  ([research-directives.js:12,24](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/prompts/research-directives.js)).
  A host with neither action sees zero web_search/read_url directives — this is
  exactly the ADR-0034 "Globe3 leak" closure. ✅ verified.
- **Focused research-phase block** (`acceptancePacket`, `sourceMinimum`, "report
  loop") — `buildFocusedResearchPhasePromptBlock` returns `""` immediately unless
  `researchActive` is true: `const researchActive = isLongResearchPromptState(...);
  if (!researchActive) return "";`
  ([planner-prompt.js:817-818](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner-prompt.js)).
  `isLongResearchPromptState` is **capability-driven** — it keys off
  `requiresEvidenceConvergence` on the engaged skill / an active research report
  loop ([planner-prompt.js:896-906](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner-prompt.js)). A generic
  agent has neither → the entire block (and all its acceptance-packet / source-minimum
  vocabulary) is absent. ✅ verified.

### 2b. DEAD — none found

- `long_research` literal: **0 matches** in `src/runtime/` (removed in
  AGRUN-313-H2). ✅ verified.
- No directive references a removed evaluator or a never-populated state slot:
  every field the directives name (`requirementRecoveryEvaluator`,
  `terminalRepairState`, `actionPatternConvergence`, `researchAcceptanceEvaluator`)
  is initialized in `state.js` and refreshed each cycle on BOTH dispatch paths.
- The near-duplicate convergence lines across `planner-base-directives.js` and
  `planner-native-directives.js` (e.g. base:27 ≈ native:30) are **not** dead
  duplicates: base renders in envelope mode and native in native_tools mode —
  they never both render in one prompt. Intentional per-mode copies.

### 2c. GENERIC-MECHANISM — the bulk, always-rendered, entangled

`prompts/planner-base-directives.js` `buildLines({ runtimeConfig })` is
**unconditional** — it always emits the base action-loop contract, which includes
the convergence / terminal-repair / publish guidance
([planner-base-directives.js:9-](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/prompts/planner-base-directives.js)).
Those lines reference the domain nouns as **the names of generic mechanisms and
example terminal actions**, e.g.:

- `actionPatternConvergence.*` signals (repeated terminal intent, terminalCorrectionState,
  terminalRetryCooldown, structureRepairConvergence, readOnlyPlanning) — pure
  loop-health, applies to any agent.
- `terminalRepairState.active` / `allowedActions` — the generic
  deadline/deficit-pressure repair state machine; starts inactive, enforced at
  preflight regardless of prompt text.
- `requirementRecoveryEvaluator.convergence.repeatedInvalidTerminalCount` — generic
  no-progress terminal-retry tracking.
- `workspace_publish_candidate` / `workspace_finalize_candidate` — the
  finalize-an-artifact terminal action, named as the concrete example of the
  terminal intent the convergence rules govern (alongside `finalize` /
  `final_answer`).

These words cannot be dropped by prompt surgery without one of:
1. **Rewording** every convergence directive to remove the concrete action-name
   examples (a behavior-sensitive edit to the highest-traffic prompt whose only
   safety net would be snapshot regeneration — no live A/B), for marginal benefit; or
2. **Relocating** the machinery (state init + refresh hooks + preflight
   enforcement + the directive text) into `@agrun/skills-research` / a
   long-running-harness pack, so a generic agent never wires it. This is §4.3–4.4.

---

## 3. Entanglement map — removable only WITH relocation

| Vocabulary | Backing machinery | Init | Refresh (both doors) | Removable by prompt edit? |
|------------|-------------------|:----:|:--------------------:|---------------------------|
| `actionPatternConvergence.*` | action-pattern-convergence.js | state.js | action-loop-action.js + action-loop-plan-actions.js | No — generic loop-health; enforced at preflight |
| `terminalRepairState.*` | terminal-repair/core.js | state.js | terminal-repair-hook + both action paths | No — generic repair state machine |
| `requirementRecoveryEvaluator.*` | requirement-recovery-evaluator.js | state.js | both action paths | No — generic no-progress tracking |
| `workspace_publish_candidate` | virtual-workspace + kernel-terminal-actions | always | per action | No — generic finalize-artifact action |
| `evidence` (as a noun) | n/a — generic word for "gathered facts" | — | — | No — not domain-specific |

---

## 4. Conclusion & handoff

§4.1 is **complete as an audit with a null code result**: there is **no
zero-risk prompt-surgery reduction** available. This is itself the valuable
finding — it redirects effort away from a tempting but unsafe "trim the prompt
vocabulary" path and confirms the pre-assessment's call to **defer the reduction
until the machinery is relocated.**

What the next session inherits, precisely:
- The research-specific prompt surface is already clean (gated, inert for generic
  agents) — do NOT spend time there.
- The residual domain nouns are generic-mechanism vocabulary owned by the
  convergence / terminal-repair / requirement-recovery / workspace-publish
  machinery. They retire **only** when that machinery moves to an opt-in pack
  (§4.3 leaf research evaluators first; §4.4 terminal-repair LAST, H10-style
  mechanical ladder, gated on a concrete second non-research host need).
- Any prompt-text change here must be validated by a live A/B run (research +
  generic), not by snapshot regeneration alone, because it alters the
  highest-traffic prompt.

Recommendation: keep `AGRUN-313` open as the tracked epic; mark §4.1 done; the
remaining vocabulary reduction is folded into the §4.3–4.4 relocation, deferred.
