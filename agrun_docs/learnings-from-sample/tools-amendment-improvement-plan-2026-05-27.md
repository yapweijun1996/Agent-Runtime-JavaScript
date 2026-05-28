# agrun Tools & Action Logic Improvement Plan
**Date:** 2026-05-27  
**Source:** Deep research of opencode-main, claude-code-source-code-main, codex-main  
**Scope:** File amendment tools + action contract + harness architecture

---

## Research Summary

Three production AI coding systems were reverse-engineered to extract patterns applicable to agrun.

| System | Edit Model | Fuzzy Match | Read-Before-Write | Permission | Event Bus |
|--------|-----------|-------------|-------------------|------------|-----------|
| **Claude Code** | old_string→new_string | Quote normalization only | fileStateCache LRU (TOCTOU double-check) | 6-layer chain (deny→whitelist→safety→ask→allow→default) | ❌ |
| **opencode** | old_string→new_string | 9-strategy cascade (Levenshtein) | FileTime.assert() + Promise mutex | ctx.ask() declarative ruleset | ✅ Bus typed events |
| **Codex** | Patch DSL text | 4-level fuzzy seek (exact→trim→unicode) | N/A (patch is self-contained) | Sandbox + approval gate | ❌ |
| **agrun (current)** | workspace_replace exact | ❌ none | ❌ none | Pluggable classifier (no default) | ❌ |

---

## agrun Current Gaps (from source audit)

| ID | Location | Issue | Severity |
|----|----------|-------|----------|
| G1 | `virtual-workspace-actions.js:isResearchPublishReadinessRequired()` | `skillName === 'deep-research-writer'` hardcoded — new skills bypass gate silently | HIGH |
| G2 | `action-result-envelope.js` | Body is opaque — no per-action field validation, bugs silent until AI makes wrong decision | MEDIUM |
| G3 | `action-permission-judge.js` | No tier-based default — hosts without classifier get "ask" for everything (no discrimination) | MEDIUM |
| G4 | `action-args-validation.js` | Alias normalization is opt-in per-field — inconsistent camelCase/snake_case drift handling | LOW |
| G5 | `repo-file-actions.js` | Factory returns null when no adapter — silently absent from registry with no planner signal | LOW |
| G6 | `virtual-workspace-actions.js:inspectPublishReadiness()` | `successfulReadUrlCount` silently overwritten — AI never told its declared value was wrong | MEDIUM |
| G7 | `planner-action-surface.js` | SKILL_SETUP_ACTION_NAMES hardcoded Set — adding skill actions requires code change | LOW |
| G8 | `virtual-workspace-actions.js` | workspace_replace uses exact string match only — frequent "not found" failures with weak models | HIGH |

---

## Improvement Plan

### ROI Scoring Formula
`ROI = (Impact × Frequency) / Effort`  
- **Impact**: 1–5 (5 = production-blocking / quality-critical)  
- **Frequency**: 1–5 (5 = every run)  
- **Effort**: 1–5 (1 = ~1 day, 5 = ~1 week)

---

### TIER 1 — Quick Wins (ROI ≥ 10, Effort ≤ 2)

#### P1: Fix `isResearchPublishReadinessRequired()` hardcoded skill names
**Source:** agrun G1 gap  
**Problem:** `skillName === 'deep-research-writer' || skillName === 'long-web-research'` — any new research skill bypasses the publish readiness gate silently.  
**Fix:**  
1. Add `capabilities: { requiresPublishReadiness: true }` to skill descriptor schema.  
2. Replace hardcoded string compare with `skill.capabilities?.requiresPublishReadiness === true`.  
3. Same pattern for `SKILL_SETUP_ACTION_NAMES` → source from skill registry query.

| Impact | Frequency | Effort | **ROI** |
|--------|-----------|--------|---------|
| 5 | 3 | 1 | **15** |

**Files:** `virtual-workspace-actions.js`, `planner-action-surface.js`, `define-skill.js`  
**Ticket:** AGRUN-262

---

#### P2: Global camelCase↔snake_case alias normalization
**Source:** agrun G4 gap  
**Problem:** `aliases: [...]` opt-in per field — weaker models emitting snake_case for camelCase fields (or vice versa) get unpredictable parse failures.  
**Fix:** In `action-args-validation.js:normalizeAliases()`, add auto-generation of snake↔camel pairs for every field unless `noAutoAlias: true`.

| Impact | Frequency | Effort | **ROI** |
|--------|-----------|--------|---------|
| 3 | 4 | 1 | **12** |

**Files:** `action-args-validation.js`  
**Ticket:** AGRUN-263

---

#### P3: Tier-based default permission policy
**Source:** agrun G3 gap  
**Problem:** When host provides no classifier and judge is disabled, all tiers get "ask". Tier 0 (workspace) should default allow; Tier 1 (repo file) should default ask.  
**Fix:** In `action-permission-judge.js`, add built-in fallback rule:  
```js
if (!hasClassifier) return { action: tier === 0 ? 'allow' : 'ask', source: 'built_in_tier_default' }
```

| Impact | Frequency | Effort | **ROI** |
|--------|-----------|--------|---------|
| 3 | 5 | 1 | **15** |

**Files:** `action-permission-judge.js`  
**Ticket:** AGRUN-264

---

### TIER 2 — Core Improvements (ROI 6–10, Effort 2–4)

#### P4: 9-Strategy Fuzzy Replacer for workspace_replace / workspace_multi_edit
**Source:** opencode `edit.ts` — 9-strategy fuzzy replacer cascade  
**Problem:** agrun's `workspace_replace` uses exact string match. AI models (especially weak ones) frequently output `oldContent` with whitespace drift, indentation mismatch, or escape-sequence differences. Live runs show repeated `insert_after_section not_found` and `workspace_replace` failures costing 5–10 extra cycles per run.

**Fix:** Port opencode's `replace(content, old, new)` function into agrun as `fuzzyReplace(content, old, new)`:

```
Strategy chain (try in order, first unique match wins):
1. SimpleReplacer          — exact indexOf
2. LineTrimmedReplacer     — per-line .trim() match with byte-offset rebuild
3. BlockAnchorReplacer     — first+last line anchors + Levenshtein (threshold: 0.0 single, 0.3 multi)
4. WhitespaceNormalizedReplacer — \s+ collapsed to single space
5. IndentationFlexibleReplacer  — strip minimum common indentation
6. EscapeNormalizedReplacer     — unescape \\n \\t \\r before match
7. TrimmedBoundaryReplacer      — trim() both ends
8. ContextAwareReplacer         — first+last anchor + ≥50% middle lines match
9. MultiOccurrenceReplacer      — all exact occurrences (for replaceAll=true)
```

**Two failure modes:**
- `notFound` → "oldContent not found — provide more context"
- Multiple unique matches → "multiple matches — provide more surrounding lines"

**Apply to:** `workspace_replace`, `workspace_multi_edit`, `workspace_apply_patch` old_lines matching

| Impact | Frequency | Effort | **ROI** |
|--------|-----------|--------|---------|
| 5 | 5 | 3 | **8.3** |

**Files:** New `src/runtime/fuzzy-replacer.js`, `virtual-workspace-actions.js`  
**Ticket:** AGRUN-265  
**Note:** This single change is likely the highest absolute value improvement — every workspace edit becomes more resilient.

---

#### P5: Read-before-write enforcement for workspace mutations
**Source:** opencode `FileTime.assert()` + Claude Code `fileStateCache`  
**Problem:** AI can call `workspace_write/replace/multi_edit` without a prior `workspace_read` on that path. This allows AI to overwrite workspace content it has never read — a hallucination vector.  

**Fix:**
1. Add `workspaceReadStamps: Map<path, timestamp>` to `runState`.
2. In `workspace_read` action: stamp the path on success.
3. In `workspace_write/replace/multi_edit/apply_patch` preflight: reject if no stamp exists for that path.
4. Clear stamp when path is written (force re-read before next mutation).

**AI-facing error when missing stamp:**
```
blocked: You must call workspace_read for "draft.md" before modifying it.
```

| Impact | Frequency | Effort | **ROI** |
|--------|-----------|--------|---------|
| 4 | 3 | 2 | **6** |

**Files:** `virtual-workspace-actions.js`, `state.js` (runState schema)  
**Ticket:** AGRUN-266

---

#### P6: Promise-chain mutex for concurrent workspace mutations
**Source:** opencode `FileTime.withLock()` — pure Promise-chain mutex (no OS locks)  
**Problem:** Subagents (AGRUN-254 shipped) can issue workspace mutations concurrently. Without serialization, two subagents writing the same path create a data race.

**Fix:** Add `withWorkspaceLock(path, fn)` to `virtual-workspace-actions.js`:
```js
// Pure JS Promise-chain mutex, browser-safe:
const locks = new Map() // path → Promise<void>
async function withWorkspaceLock(path, fn) {
  const current = locks.get(path) ?? Promise.resolve()
  let release
  const next = new Promise(resolve => { release = resolve })
  locks.set(path, current.then(() => next))
  await current
  try { return await fn() } finally { release() }
}
```

| Impact | Frequency | Effort | **ROI** |
|--------|-----------|--------|---------|
| 4 | 2 | 1 | **8** |

**Files:** `virtual-workspace-actions.js`  
**Ticket:** AGRUN-267

---

#### P7: `defineAction()` wrapper — unified validation + truncation
**Source:** opencode `Tool.define()` — auto-validate + auto-truncate wrapper  
**Problem:** agrun action authors manually handle args validation, output truncation, and tracing. Cross-cutting behavior is distributed across 30+ action files.

**Fix:** Create `defineAction(id, init)` wrapper in `src/runtime/define-action.js`:
```js
export function defineAction(id, { description, tier, planner, execute, outputSchema }) {
  return Object.freeze({
    name: id, description, tier, planner,
    outputSchema,
    async execute(context, args) {
      // 1. Validate args against planner.argsSchema (AJV or manual)
      const validated = validateArgs(args, planner.argsSchema) // throws on failure
      // 2. Execute
      const result = await execute(context, validated)
      // 3. Auto-truncate if body.text > TRUNCATE_THRESHOLD (2000 lines / 50KB)
      return autoTruncate(result)
    }
  })
}
```

| Impact | Frequency | Effort | **ROI** |
|--------|-----------|--------|---------|
| 3 | 5 | 3 | **5** |

**Files:** New `src/runtime/define-action.js`, migrate high-traffic actions first  
**Ticket:** AGRUN-268

---

#### P8: Per-action body schema validation (fix G2)
**Source:** agrun G2 gap  
**Problem:** Action body is opaque at envelope level — a buggy action returning wrong-typed fields goes undetected until the AI makes a downstream wrong decision.  
**Fix:** Add optional `bodySchema` (JSON Schema) to action definition. `normalizeActionResultEnvelope()` validates body against it when present. Start with highest-risk actions: `workspace_publish_candidate`, `workspace_propose_patch`.

| Impact | Frequency | Effort | **ROI** |
|--------|-----------|--------|---------|
| 3 | 2 | 2 | **3** |

**Files:** `action-result-envelope.js`, `action-output-contract.js`  
**Ticket:** AGRUN-269

---

### TIER 3 — Architecture Improvements (Effort 4–5, Long-term ROI)

#### P9: Snapshot-then-compare for workspace mutations
**Source:** Codex `TurnDiffTracker` — harness independently verifies AI-declared changes  
**Problem:** agrun relies on AI to self-report what was changed; `successfulReadUrlCount` already shows we need to override AI declarations. Workspace content changes have the same problem.  
**Fix:** 
1. Before any workspace mutation, snapshot `virtualWorkspace.content` for that path.
2. After mutation, compute text diff (before vs after).
3. Expose diff as observable in `action-result-envelope.body.diff`.
4. Inspector and readinessAudit can now independently verify "did the AI actually write what it said?"

| Impact | Frequency | Effort | **ROI** |
|--------|-----------|--------|---------|
| 4 | 4 | 4 | **4** |

**Files:** `virtual-workspace-actions.js`, `action-result-envelope.js`, `workspace-candidate-lifecycle.js`  
**Ticket:** AGRUN-270

---

#### P10: Declarative permission ruleset layer
**Source:** opencode `permission/next.ts` — `{permission, pattern, action}` last-rule-wins  
**Problem:** agrun's permission judge requires the host to implement a full async `classify()` function. Simple use cases (allow all tier-0, ask for tier-1) need boilerplate.  
**Fix:** Add default declarative layer before custom classifier:
```js
// Host can pass rules array instead of (or in addition to) classifier:
const rules = [
  { permission: 'workspace.*', pattern: '*', action: 'allow' },
  { permission: 'repo.*',      pattern: '*', action: 'ask'   },
]
// Last matching rule wins (CSS priority)
```

| Impact | Frequency | Effort | **ROI** |
|--------|-----------|--------|---------|
| 3 | 3 | 3 | **3** |

**Files:** `action-permission-judge.js`, host API surface  
**Ticket:** AGRUN-271

---

#### P11: Structured multi-file patch DSL (Codex-style)
**Source:** Codex `apply_patch` patch format + 4-level fuzzy seek  
**Problem:** `workspace_propose_patch/workspace_apply_patch` has an ad-hoc format; AI-generated patches have formatting issues; single-file only.  
**Fix:** Define formal patch DSL:
```
*** Begin Patch
*** Update File: draft.md
@@ ## Section Title
-Old content line
+New content line
*** End Patch
```
Implement 4-level fuzzy seek for `old_lines` matching (exact → rstrip → trim → unicode normalize). Add "lenient" mode parsing (handle model-specific format variants). Support multi-file in one patch.

| Impact | Frequency | Effort | **ROI** |
|--------|-----------|--------|---------|
| 4 | 3 | 5 | **2.4** |

**Files:** `virtual-workspace-actions.js`, new `src/runtime/patch-parser.js`  
**Ticket:** AGRUN-272

---

## Execution Priority

### Sprint A (Week 1–2): Quick Wins
| Ticket | Item | Effort |
|--------|------|--------|
| AGRUN-262 | Skill capability flags (fix G1) | 1d |
| AGRUN-263 | Global alias normalization (fix G4) | 0.5d |
| AGRUN-264 | Tier-based default permission (fix G3) | 1d |
| AGRUN-265 | **9-strategy fuzzy replacer** | 3d |

**Sprint A ROI:** Highest value change (P4 fuzzy replacer) + 3 low-effort fixes. Expected impact: 30–50% reduction in `workspace_replace not_found` failures.

---

### Sprint B (Week 3–4): Safety Layer
| Ticket | Item | Effort |
|--------|------|--------|
| AGRUN-266 | Read-before-write enforcement | 2d |
| AGRUN-267 | Promise-chain mutex | 1d |
| AGRUN-268 | defineAction() wrapper | 3d |

**Sprint B ROI:** Concurrent subagent safety + consistent action contract. Prerequisite for safe multi-agent workspace editing.

---

### Sprint C (Week 5–7): Architecture
| Ticket | Item | Effort |
|--------|------|--------|
| AGRUN-269 | Body schema validation | 2d |
| AGRUN-270 | Snapshot-then-compare | 4d |
| AGRUN-271 | Declarative permission ruleset | 3d |
| AGRUN-272 | Structured patch DSL | 5d |

---

## What NOT to Borrow

| Pattern | From | Reason to Skip |
|---------|------|---------------|
| Model-decided termination (`finish` field) | opencode | agrun's runtime-gated readiness is correct for long-form — don't weaken it |
| LSP integration (real-time diagnostics) | opencode + Claude Code | agrun is browser-runtime; no LSP server available |
| fileHistory on-disk backup + rewind | Claude Code | agrun uses virtualWorkspace (in-memory); disk backup irrelevant for browser context |
| Linux sandbox / seccomp isolation | Codex | Browser context has no OS-level sandbox hooks; use iframe/origin isolation instead |
| Effect-TS ManagedRuntime | opencode | Too heavy for agrun's "keep runtime simple" rule |
| Multi-edit non-atomicity | opencode | opencode's MultiEdit is not atomic; agrun's workspace_multi_edit should be atomic (all or none) |

---

## Key Principle

> **Harness's job = enforce contracts. AI's job = judge quality.**  
> Every pattern above moves runtime validation from "trust the AI's self-report" to "harness independently verifies". This is the single underlying principle behind all 11 improvements.

---

## Dependencies Map

```
P1 (skill capability flags)
  └→ unblocks all future skill gates

P4 (fuzzy replacer) — independent, deploy first
P5 (read-before-write) — independent
P6 (mutex) — independent
  └→ both P5+P6 together = full subagent workspace safety

P7 (defineAction wrapper)
  └→ P8 (body schema) — needs P7 wrapper in place

P9 (snapshot-then-compare)
  └→ P10 (patch DSL) — snapshot data feeds patch verification
  └→ AGRUN-255 (typed event bus) — needed to surface diff events to inspector
```
