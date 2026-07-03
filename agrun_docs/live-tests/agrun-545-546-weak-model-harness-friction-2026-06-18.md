# Weak-model churn is harness friction, not a capability floor (AGRUN-544/545/546/547)

Date: 2026-06-18

## Goal

Make gemini-3.1-flash-lite (low thinking) produce a correct 3000-word deep
research report. Baseline: gpt-5.4-mini(low) and deepseek-v4-flash(high) both
score 100; gemini-lite repeatedly fails and hits maxSteps.

## Result first

| Change | Real fix? | Fixes gemini-lite? |
| --- | --- | --- |
| **AGRUN-546** skill paradigm neutralization | ✅ removes hardcode | ❌ (it doesn't engage the skill) |
| **AGRUN-545** non_monotonic audit bug (H2 sub-sections) | ✅ has repro + test | ❌ (secondary cause) |
| **AGRUN-544** editChurnConvergence | ❌ **REVERTED** (forced-action hardcode) | ❌ never fired |
| **AGRUN-547** insert_after_section semantic trap | ← **PRIMARY cause, still open** | — |

Two independent, correct fixes shipped (545 + 546). Neither resolves the weak
model. The primary cause was located but deliberately left for a separate,
AI-first (reduce-intervention) change — NOT another block.

## The investigation (and two corrections I had to make)

### 1. editChurn (AGRUN-544) was the wrong shape — reverted

First attempt: a mechanical "N edits without progress → hard_veto" convergence
dimension. Rejected for three reasons:
- `hard_veto` forcibly blocks actions = **forced-action hardcode**, violating
  AGRUN-244/214k ("runtime emits observation/guidance, not forced action").
- It bound to `structureEcho`'s 4 content codes, but the real gemini-lite churn
  ran with `structureEcho` CLEAN the whole time, so it **never fired**.
- The system already has terminal-repair + read-only-planning + structure-repair
  blocks fighting each other; a 4th block is fuel on the fire.

### 2. "Capability floor" was a lazy verdict — reading the log overturned it

I first concluded gemini-lite was simply incapable. That was wrong — I had only
looked at aggregate metrics (score/calls), not the reasoning log. Reading all 90
steps: **48% of steps fought duplicate headings; 9 steps were explicitly trapped
by harness blocks** ("I am forbidden from calling workspace_read", "I am in
terminal repair mode... must advance todo"). The model was trying to do the right
thing; the harness trapped it.

### 3. I then fixed the SECONDARY cause first — corrected by quantifying

I found `non_monotonic_section_numbers` mis-firing and fixed it (AGRUN-545). But
the re-test still hit maxSteps. Quantifying reasoning-step share across runs:

- **duplicate-heading / merge / consolidate: ~30 steps/run → PRIMARY**
- non_monotonic / renumber: ~13 steps/run → secondary

I had fixed the secondary cause. The lesson: **quantify each cause's share before
picking what to fix** — don't fix the first bug you see.

## AGRUN-545 — non_monotonic audit bug (real fix, secondary)

`collectTopLevelNumberedHeadings` (src/runtime/virtual-workspace.js) folded a
dotted sub-section number to its major integer (`"2.1"` → `2`), so a model that
authored sub-sections at H2 depth (`## 2.1`, `## 2.2`) produced a top-level
sequence read as `[1, 2, 2, 2, 3]` → mis-fired `non_monotonic_section_numbers`.
`extractMarkdownSectionNumber` strips the trailing dot, so a genuine top-level
heading is a bare integer (`"2"`) while a sub-section keeps its dot (`"2.1"`).
Fix: ignore dotted numbers in the top-level sequence. One collector backs
non_monotonic + gapped + sequence-repair-hints → one change fixes all three
(SSOT). Regression test `test/unit/agrun-545-subsection-number-audit.test.js`:
H2 sub-sections now CLEAN; genuine out-of-order / gapped / flash-lite-style /
duplicate top-level numbers still flagged.

## AGRUN-546 — skill paradigm neutralization (real fix, capable models)

The deep-research-writer SKILL hardcoded a bias toward incremental editing
("Single-shot answers under-deliver... Use this LOOP instead"; Phase D "Avoid
repeating small workspace_write rewrites that replace the whole draft"). The
capable gpt-5.4-mini that did NOT engage the skill self-chose a single-shot path
and scored 100; gemini engaging the skill churned. Per AGRUN-244/214k the skill
now presents paradigms NEUTRALLY (gather evidence, then EITHER draft in one pass
OR build section by section — pick by your strengths). SSOT: SKILL.md → 
`node build/generate-source-agent-bundles.cjs` → bundles. `npm run build` does
NOT regenerate SKILL.md (an implementation subagent wrongly reverted this work
believing it would; re-applied and verified).

## AGRUN-547 — insert_after_section semantic trap (PRIMARY, open)

The weak model wants to EXPAND an existing section (`Expanding the 'Core
Principles' section` appears repeatedly) and calls `workspace_insert_after_section`
with content carrying its own `## Core Principles` heading → creates a REAL
duplicate heading → audit/terminal-repair blocks it → it merges/renames → then
re-inserts to keep expanding → endless insert→duplicate→merge→insert loop until
maxSteps. `structureEcho` already surfaces the duplicate, but the weak model
cannot escape. This is the semantic trap flagged early in the session. The fix
must stay AI-first (reduce intervention, not a block): investigate whether the
tool can treat "insert content whose leading heading duplicates the target
section" as an in-section append (strip the duplicate heading line) so expanding
a section stops manufacturing duplicates — without regressing legitimate
new-section inserts.

## Three-model re-test data

| Model | score | gates (len/struct/src) | calls | words | note |
| --- | ---: | --- | ---: | ---: | --- |
| gpt-5.4-mini (low) | **100** | ✅/✅/✅ | 19 | 3016 | no regression after 545+546 |
| gemini-lite (low), before 545 | 46 | ❌/❌/❌ | 90 (maxSteps) | 2769 | duplicate churn |
| gemini-lite (low), after 545 | 32 | ❌/❌/❌ | 90 (maxSteps) | 1927 | still insert-trap churn (AGRUN-547) |

Deterministic: full unit suite 330/330, `npm run build` exit 0.

## Principles reaffirmed

1. **Debug from the reasoning log, not aggregate metrics** — score/calls say
   "it failed"; the reasoning says "the harness trapped it". Quantify each
   cause's step-share before choosing what to fix.
2. **Reduce intervention, don't add blocks** — fix mis-firing audits and
   tool-semantic traps; the only legitimate hard bound is the universal brake
   (maxSteps/budget), which already produces an honest limited publish.
3. **observation (structureEcho) is AI-first; forced-action (hard_veto) is
   hardcode in disguise** — that is why editChurn (AGRUN-544) was rejected.
