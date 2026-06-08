# research-state de-import — design spike (the "dangerous-last" edge, re-assessed)

Status: **DESIGN ONLY — no code, no commit.** Follows the 3.0 package split + roles
de-import (all merged). `research-state.js` is the last research-named file with many core
importers; the original plan (micro-kernel-dependency-inversion-design.md + an early KB
memory) flagged it as **dangerous-last** and proposed inverting its gate predicate into a
host hook. **This spike re-reads the code and concludes that plan is now outdated and the
remaining work is much smaller and lower-risk than "dangerous-last" implied.** Maintainer
reviews this before any code.

---

## 1. What research-state.js actually is (fresh read)

`src/runtime/research-state.js` imports only generic helpers (`read-source-quality.js`) +
the legacy-flag seam (`research-activation-token.js`). It imports NO research-*.js file —
it is a near-leaf. Its exports fall into THREE groups, and the 10 core importers want
different groups:

| group | exports | who imports | nature |
|---|---|---|---|
| **A. Gate predicate** | `isEvidenceConvergenceRun`, `isResearchQualityGateRequired` (= a 1-line wrapper of it) | planner.js, planner-action-surface.js, action-pattern-convergence.js, action-loop-action.js, research-finalize-contract.js, virtual-workspace-actions.js | **GENERIC** (see §2) |
| **B. State factory / slot** | `createResearchState`, `createEmptyResearchWorkspace`, `createResearchWorkspace`, `refreshResearchState` | state.js (slot init), planner-prompt.js, virtual-workspace-actions.js | research-flavored DATA shape |
| **C. Thread/topic helpers** | `detectContinuedResearchThread`, `readStableResearchTopic` | (convergence / report-loop internals) | research-flavored |

---

## 2. The key finding — the gate predicate is ALREADY generic (the old plan is moot)

The original "dangerous-last" framing assumed `isResearchQualityGateRequired` was a
DOMAIN predicate the kernel should not contain, to be inverted into
`runtimeConfig.requiresQualityGateFn` (host-supplied). **But AGRUN-313 P2b/P2c already
de-domained it.** Reading `isEvidenceConvergenceRun` today:

```
isEvidenceConvergenceRun(runState, options):
  1. if matchesLegacyResearchActivation(runState.researchActivation || options.researchActivation) → true
  2. else → does the ENGAGED skill object declare the generic capability
            `requiresEvidenceConvergence`? (activeSkill / lastReadSkill / options)
```

This is **capability-gated convergence detection** — name-free, exactly the
object-capability mechanism the skills split relies on. The skill that needs the gate
declares `requiresEvidenceConvergence: true` in its SKILL.md (it ships in
`@agrun/skills-research`); the DETECTOR is generic and knows no skill name. This is the
same class as `evidence-state` / `evidence-policy` / `research-coverage-guard` — **generic
infrastructure mislabeled "research" that the spike already said STAYS in core.**

So **group A does NOT need a host hook and does NOT move.** A generic runtime with no
skills: branch 1 false (no activation flag), branch 2 false (no skill) → predicate returns
false → no gate. Wire `@agrun/skills-research` → its skills carry the capability → gate
activates. The opt-in already works through the capability, not through this file's location.

The only residue in group A is **vocabulary**: the function/file NAMES say "Research" though
the logic is generic. That is the §6 cosmetic-rename concern, not a behavioral edge.

---

## 3. Proposed minimal plan (low-risk; replaces the host-hook inversion)

Do NOT invert the predicate into a host hook (unnecessary — §2). Instead:

### Phase R1 — relocate the GENERIC predicate to a generic seam (mechanical, no behavior change)
Move `isEvidenceConvergenceRun` + its private helpers (`readSkillCapability`,
`matchesLegacyResearchActivation` usage) into a generically-named kernel file, e.g.
`src/runtime/convergence-activation.js` (or extend an existing kernel seam). Keep
`isResearchQualityGateRequired` as a re-export alias for back-compat OR rename the 6
importers (decision R-a below). Litmus: `npm run check` byte-identical prompt-snapshot
(the logic is unchanged, only the file/symbol location). This removes the "research" name
from the predicate's home without touching behavior.

### Phase R2 — the state factory/slot (group B): kernel-seam relocation, like report-loop 2.2
`createResearchState` / `refreshResearchState` build the runState research-workspace slot
(questions/queries/sourceQuality/topic/vetoCount/qualityGateRequired). state.js inits the
slot; planner-prompt + virtual-workspace read it. Apply the **2.2 data/behavior split**:
the slot factory is pure DATA → relocate to a kernel seam (core readers keep the slot);
any research DECISION logic in `refreshResearchState` that calls research behavior moves
behind an existing hook or to the pack. The slot-absent arbiter (stub the factory → null,
`npm run check`) decides whether readers already null-guard. Likely outcome: the slot is
generic-enough to stay as kernel-seam data (vocabulary residue), same as report-loop.

### Phase R3 — helpers (group C) + legacy token
`detectContinuedResearchThread` / `readStableResearchTopic` ride with whichever group
their callers need (probably the convergence seam). `matchesLegacyResearchActivation` +
the `researchActivation` token is the back-compat serialization flag — its migration is the
separate AGRUN-313 2.0 serialization change (research-thread-sync), NOT this spike.

### Decision R-a (maintainer) — vocabulary
Rename the generic symbols/file to drop "Research" (`isResearchQualityGateRequired` →
`isQualityGateRequired`, `research-state.js` → `convergence-state.js`, the `qualityGateRequired`
field stays as-is since it's already generic) — a breaking rename batched as 3.1, OR keep
the names as back-compat aliases (no break). Recommend: **alias now, rename at the next
breaking bump** so this phase is non-breaking.

---

## 4. Why this is NOT "dangerous-last" anymore

- The predicate is already generic (P2b/P2c) — no behavioral inversion, no host hook, no
  risk of changing when the gate fires. The 10 importers keep calling the same logic.
- research-state.js imports no research-*.js — moving its pieces drags nothing.
- Each phase is independently `npm run check` + live-verifiable; R1 is byte-identical.
- It does NOT intersect AGRUN-299/300/301/307 the way a *behavioral* gate change would —
  those were about WHEN the gate fires; this spike changes only WHERE the (unchanged)
  predicate lives and what it's named.

## 5. Honest scope — what this does and does not deliver

DELIVERS: removes the last "research-named" file from core's import grep by relocating its
generic predicate to a generic seam and its slot to a kernel seam; makes explicit that the
gate is capability-driven, not name-driven.

DOES NOT: change when the quality gate fires (behavior identical); migrate the legacy
`researchActivation` serialization token (separate 2.0 change); make every runState field
name generic (the `qualityGateRequired` / research-workspace slot vocabulary is already
mostly generic; full rename is the optional R-a).

**Recommendation:** approve R1 (mechanical, byte-identical) as the first concrete step;
treat R2 with the slot-absent arbiter; defer R-a (rename) to a breaking bump. This is a
low-risk vocabulary/relocation pass, not the dangerous behavioral inversion the old plan
implied.
