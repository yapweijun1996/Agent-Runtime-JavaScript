# Audit — Prompt Content Leak Surface (2026-05-25)

## Why this audit exists

Globe3 ERP ticket AGRUN-?? (5 email rounds, May 2026) exposed an
architectural leak: the agent runtime is named "just a runtime
library", but in practice it ships ~150 lines of opinionated
planner-prompt content that tells the model *what to do* — including
hardcoded directives to "Use web_search" when web_search exists, and
"do not loop on read_url" when read_url exists. When a host disables
those actions, the prompt still leaks them, and the lite-tier model
follows the prompt's advice, producing the planner-invalid-action ×
planner-repair-failed loop that ADR-0034 closes.

ADR-0034 + commit `6dd00c00` solved the immediate symptom but did NOT
remove the architectural root cause: **prompt content is buried in
JavaScript string arrays across multiple files, with no
host-override path**.

This audit catalogs every prompt-content site that ships in the
runtime and decides which need extraction / host-override capability.

User intent (2026-05-25 conversation): keep the runtime opinionated
with sane defaults, BUT extract prompts into dedicated files so
engineers can review and selectively override.

## Audit inventory

### Tier 1 — Big static prompt arrays (must extract)

| File | Lines | Prompt-directive count | Action refs |
|------|------:|-----------------------:|------------:|
| [src/runtime/planner-prompt.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner-prompt.js) | 1361 | ~52 | 17 |
| [src/runtime/planner-native-system-prompt.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner-native-system-prompt.js) | 74 | ~29 | — |

These are the two giant `BASE_SYSTEM_LINES` / `COMPACT_SYSTEM_LINES`
arrays plus conditional `lines.push()` blocks inside
`buildSystemPromptLines` / `buildNativeToolsSystemPrompt`. Almost all
the customer-visible prompt content lives here.

### Tier 2 — Action / state-specific prompt blocks (already partly extracted)

| File | Notes |
|------|-------|
| [src/runtime/invalid-action-prompt-block.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/invalid-action-prompt-block.js) | ADR-0034 — new, isolated; uses summarized state only, no hardcoded action names. Good template. |
| [src/runtime/terminal-repair-strings.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/terminal-repair-strings.js) | Already split off. Provides `DEFAULT_TERMINAL_REPAIR_STRINGS`. Host can override (verify). |
| [src/runtime/todo-state-prompt.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/todo-state-prompt.js) | 124 lines. TodoState advisory block. Verify host-override surface. |

### Tier 3 — Inline prompt strings inside larger modules

| File | What | Should extract? |
|------|------|-----------------|
| [src/runtime/action-loop-action.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-action.js) (~8 prompt-ish lines in 2579) | budget block / repair messages — embedded in convergence emission code | Probably yes — but these are operational strings, not directive prose |
| [src/runtime/action-pattern-convergence.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-pattern-convergence.js) (~4 prompt-ish in 1770) | `requiredCorrection` strings inside state-machine output | Yes — should be in repair-strings file |
| [src/runtime/research-acceptance-evaluator.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/research-acceptance-evaluator.js) (~3) | gate-signal status messages | Yes, with terminal-repair-strings |
| [src/runtime/final-response-quality.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/final-response-quality.js) (~10) | quality-issue codes + advisory messages | Lower priority — these are status enums, not directives |
| [src/runtime/actions/read-url-action.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/actions/read-url-action.js) (~4) | error / status messages | Lower priority — per-action, naturally scoped |

## Specific leak points identified

### 1. Unconditional action-name directives (most dangerous)

**Fixed in commit `6dd00c00`** for `COMPACT_SYSTEM_LINES`. Five lines
referencing `web_search` / `read_url` unconditionally are now gated
on `hasAction("read_url") || hasAction("web_search")`.

**Remaining**: scan `BASE_SYSTEM_LINES` and
`planner-native-system-prompt.js` for similar patterns. The 17 action
refs in `planner-prompt.js` may already be gated via `loopState.X.active`
conditionals (which only fire when the matching state is active —
won't leak to Globe3-shape configs). Need line-by-line verification.

### 1a. Quantified leak inventory (2026-05-25 measurement)

Verify script `/tmp/verify-prompt-no-leak.mjs` + locked baseline at
[test/unit/planner-prompt-action-leak-inventory.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/planner-prompt-action-leak-inventory.test.js)
produced the following counts when host config places `web_search`
and `read_url` in `disabledActions`:

| Mode | `web_search` leaks | `read_url` leaks | Class breakdown |
|------|-------------------:|-----------------:|-----------------|
| Compact (`compactSystemPrompt: true`) | **0** | 1 | C × 1 |
| Base (`compactSystemPrompt: false`) | **4** | 2 | B × 5, C × 1 |

Concrete leak sites (line numbers refer to the rendered prompt array
output from `buildSystemPromptLines`, not source file line numbers):

**Compact mode — read_url:**
- Line 7 (class C): `"Use final only when no tool, loaded skill, workspace, or read_url evidence workflow is needed."`

**Base mode — web_search:**
- Line 21 (class B): `"If loopState.actionPatternConvergence.readOnlyPlanningState.active=true, do not choose more web_search, todo_plan, todo_inspect, workspace_list, workspace_read, execute_skill_tool, or skill-setup planning loops..."`
- Line 27 (class B): `"If loopState.readUrlRecoverySignal.status is needs_alternate_source or source_blocked, do not retry the same non-retryable failed URL; read an alternate candidate, run refined web_search, or publish limited..."`
- Line 43 (class B): `"If your previous envelope was invalid or empty, the runtime surfaces loopState.plannerInvalidSignal as read-only repair facts. Return one corrected planner JSON envelope yourself; runtime will not synthesize web_search or any other fallback action."`
- Line 49 (class B): `"If loopState.readAttemptSignal is present (attemptCount, threshold), you have read \`attemptCount\` URLs this turn..."`

**Base mode — read_url:**
- Line 21 (class B): same as above — references `read_url` through `workspace_read`/`web_search` advisory list
- Line 53 (class C): `"Use final only when no tool, loaded skill workflow, virtual workspace drafting, read_url evidence, or readiness contract is needed."`

**Class definitions:**
- **A — Affirmative directive** (`"Use X for Y"`): would push lite-tier
  model toward emitting the action. Highest risk. **None remaining**
  after commit `6dd00c00`.
- **B — Conditional advisory** (`"If loopState.X.active=true, don't do Y"`):
  references the action name inside a runtime-state-gated advisory.
  Only fires when the state activates; harmless if the state never
  activates for the host's shape, but still leaks the action name to
  the model when the state DOES activate. Medium risk.
- **C — Informational reference** (`"use final only when no X evidence"`):
  mentions the action as a TYPE of evidence the model might have, not
  as a directive to use it. Low risk but still surfaces the action name.

**Phase 6 lint regex sketch** (per ADR-0035 Phase 6):
- Scan each file in `src/runtime/prompts/`.
- For every literal action name (`web_search`, `read_url`, `todo_*`,
  `workspace_*`), require either:
  - The file is a function-exporting module that takes `availableActions`
    and gates the line via `hasAction(name)`, OR
  - The line lives inside a conditional block whose predicate already
    gates on `loopState.X.active === true` AND the comment explicitly
    notes that activation gates further surfacing (class B exemption).
- Pure informational references (class C) need an explicit
  `// LEAK-CLASS-C` comment + audit doc cross-reference to be exempt;
  default behavior is to fail the lint.
- New file `test/unit/planner-prompt-action-leak-inventory.test.js`
  is the locked baseline; reduce the numbers in its assertions as
  each leak class collapses to zero.

### 2. Convergence-state directive prose

E.g. lines like *"If loopState.actionPatternConvergence.terminalCorrectionState.active=true, stop terminal retry loops; perform evidence/workspace recovery..."* — these reference action names
(`workspace_publish_candidate`, `todo_advance`) inside conditional
advisory text. The condition gates correctly (only fires when the
state is active), but the action names inside are still hardcoded.
If a host disables the action while the state is active, the prompt
still tells the model to use it.

**Recommendation**: extract per-state advisory text into
`src/runtime/prompts/convergence-advisory.js` with one function per
state. Functions take the state + available actions as input, render
only when relevant action is available.

### 3. Built-in tool descriptions

`buildNativeToolsSystemPrompt` (planner-native-system-prompt.js) lines
27-29 contain directive text referencing `web_search` / `read_url` /
`loopState.readUrlRecoverySignal`. Same pattern as #1 but for native
tool calling mode. Needs same gating.

### 4. Skill catalog presentation

`planner-prompt.js` builds the available actions and agent skill
catalog presentation. Currently uses host-configured surface
(post-filter), so no hardcoded skill names. But the surrounding
prose ("You have access to specialized skills...") references
specific bundled skill behaviors.

## Proposed extraction plan (ADR-0035 scope)

### Phase 1 — Inventory pass (this audit + complete grep)
- Status: this doc covers the major files; line-by-line action-ref
  audit in `planner-prompt.js` still pending.
- Deliverable: per-file "extractable prompt" line list.

### Phase 2 — Module restructure
- Create `src/runtime/prompts/` directory.
- Move `BASE_SYSTEM_LINES` → `prompts/planner-base-directives.js`.
- Move `COMPACT_SYSTEM_LINES` → `prompts/planner-compact-directives.js`.
- Move conditional push blocks (the `if (hasAction(...))` clusters
  inside `buildSystemPromptLines`) → one file per action group:
  `prompts/research-directives.js`, `prompts/workspace-directives.js`,
  `prompts/skill-directives.js`, `prompts/convergence-advisory.js`.
- Each file exports either an array or a function that takes
  `availableActions` / `runState` and returns the directive lines.

### Phase 3 — Host override API
- New `runtimeConfig.prompts` shape:
  ```js
  createRuntime({
    prompts: {
      basePlannerDirectives: ["..."],      // replaces BASE_SYSTEM_LINES
      compactPlannerDirectives: ["..."],   // replaces COMPACT_SYSTEM_LINES
      researchDirectives: false,           // disables the block entirely
      workspaceDirectives: (ctx) => ["..."] // function form for dynamic content
    }
  });
  ```
- Override paths must be documented in `agrun_docs/feature-toggles.md`
  with examples.

### Phase 4 — Migration + tests
- Update tests that snapshot prompt content (most do not — but
  `planner-prompt-disabled-actions.test.js` does).
- Add new regression test: every prompt directive referencing a
  specific action name MUST be gated on that action's availability.
  Failing this test => the directive leaks to hosts that disabled
  the action.

### Phase 5 — Globe3 case re-verify
- Re-run Globe3-shape config + lite-tier model + ERP short prompt.
- Expectation: AI sees NO mention of web_search / read_url anywhere
  in its prompt, picks `execute_skill_tool` for the ERP skill, run
  completes in <30 cycles.

## Open questions

1. **Compact vs base mode coverage** — should host override be
   per-mode or unified? Suggested: per-mode, since the modes have
   different lite-tier vs full-tier audiences.
2. **Override granularity** — do we expose "replace entire base"
   or per-directive override? Suggested: replace per file (e.g.
   `prompts.researchDirectives`), not per line. Cleaner contract.
3. **Backward compat** — current default behavior must remain
   identical when host does NOT pass `runtimeConfig.prompts`. Any
   prompt content change is a separate feature.
4. **Bundled docs** — should the `prompts/` directory be included
   in `dist/agrun_docs/` so hosts can see the defaults without
   reading dist/agrun.js? Suggested: yes, as part of dist:check.

## Risks

- **Test churn** — extracting prompts may break snapshot-based tests
  even if behavior is identical. Mitigate by running snapshot diff
  before/after each file move.
- **Bundle size** — `dist/agrun.js` is currently 3.4 MB; splitting
  prompts into more files won't change bundled size, only readability.
- **Host complexity** — adding override API requires hosts to
  understand the prompt structure they're overriding. Mitigate with
  doc examples for common cases (silent host, host with custom
  persona, host with restricted action set).

## Verdict

This audit confirms the user observation: agrun.js is NOT "just a
runtime" — it ships ~150 lines of opinionated prompt content that
leaks runtime decisions into customer experience. ADR-0035 (planned)
will extract and expose them as host-overridable defaults without
breaking the runtime architecture.

ADR-0034 closed the immediate Globe3 symptom. ADR-0035 should close
the structural reason engineers had to grep dist/agrun.js to diagnose.

## Follow-up findings (2026-05-26)

### Bug: `planner-native-system-prompt.js:36` — same SSOT violation as planner-prompt.js LINE 57

In session 2026-05-26, the `planner-prompt.js` LINE 57 was fixed to use
`DEFAULT_READ_ONLY_PLANNING_FORBIDDEN_ACTIONS.join(", ")` (the 9-item SSOT
constant from `action-pattern-convergence.js`). However, **`planner-native-system-prompt.js`
was NOT updated** and still has the OLD hardcoded 7-item list:

```js
// planner-native-system-prompt.js:36 — STILL BROKEN
"If loopState.actionPatternConvergence.readOnlyPlanningState.active=true, do not choose more web_search, todo_plan, todo_inspect, workspace_list, workspace_read, execute_skill_tool, or skill-setup planning loops..."
```

Missing from the native-tools mode list: `list_agent_skills`, `read_agent_skill`, `use_agent_skill`

These 3 actions ARE in `DEFAULT_READ_ONLY_PLANNING_FORBIDDEN_ACTIONS` but are NOT
in the native-tools readOnlyPlanning directive. When `readOnlyPlanningState.active=true`,
native-tools mode AI can still call `list_agent_skills` / `read_agent_skill` / `use_agent_skill`
in planning-loop patterns that the harness is trying to stop.

**Fix required (1 line):**
1. Add `import { DEFAULT_READ_ONLY_PLANNING_FORBIDDEN_ACTIONS } from "./action-pattern-convergence.js"` to native file
2. Change line 36 to use `${DEFAULT_READ_ONLY_PLANNING_FORBIDDEN_ACTIONS.join(", ")}` template literal

Track as pre-Phase-3 bug fix for ADR-0035 (AGRUN-262).

### ADR-0035 Phase 2 snapshot test design

Phase 2 requires `test/unit/prompt-snapshot.test.js` covering 5 representative
configs to serve as the safety net during Phase 3 extraction.

| Config name | `compactSystemPrompt` | Actions enabled | Purpose |
|-------------|----------------------|-----------------|---------|
| `default-full` | `false` | All built-ins | Base-mode full surface |
| `globe3-shape` | `true` | No web_search, no read_url | Host-restricted compact mode |
| `research-only` | `false` | web_search + read_url + finalize + final only | Research-only base mode |
| `workspace-shape` | `false` | workspace_write + workspace_publish_candidate + finalize | Workspace-only base mode |
| `skills-shape` | `true` | list_agent_skills + execute_skill_tool + finalize | Skills-only compact mode |

Test pattern: SHA-256 hash of `buildSystemPromptLines(actions, opts).join("\n")`.
After each Phase 3 section extraction, re-run all 5 configs — all hashes must remain identical.

### ADR-0035 Phase 3 extraction map

| Prompt content | Source location | Target `src/runtime/prompts/` file |
|----------------|----------------|--------------------------------------|
| `BASE_SYSTEM_LINES` array (38 lines) | `planner-prompt.js:35-73` | `planner-base-directives.js` — export `const lines = Object.freeze([...])` |
| `COMPACT_SYSTEM_LINES` array (31 lines) | `planner-prompt.js:75-106` | `planner-compact-directives.js` — export `const lines = Object.freeze([...])` |
| `list_agent_skills` + `execute_skill_tool` + `use_agent_skill` blocks | `planner-prompt.js:161-178` | `skill-directives.js` — export `function buildLines({ availableActions, compactSystemPrompt })` |
| `workspace_write` cluster (incl. `workspace_propose_patch`, `workspace_publish_candidate`) | `planner-prompt.js:190-218` | `workspace-directives.js` — export `function buildLines({ availableActions, compactSystemPrompt })` |
| base-mode research block (`read_url\|\|web_search`) | `planner-prompt.js:220-225` | `research-directives.js` — export `function buildLines({ availableActions, compactSystemPrompt })` |
| compact-mode research block | `planner-prompt.js:233-239` | merged into `research-directives.js` |
| convergence-state advisories (terminalRepair/invalidAction/readAttempt) | `planner-prompt.js:249-268` | `convergence-advisory.js` — export `function buildLines({ availableActions, compactSystemPrompt })` |
| native-tools mode inline directives | `planner-native-system-prompt.js:20-64` | `planner-native-directives.js` — export `function buildLines({ hasAction, standaloneActionNames })` |

Commit order for Phase 3:
1. Extract `BASE_SYSTEM_LINES` → snapshot test must pass
2. Extract `COMPACT_SYSTEM_LINES` → snapshot test must pass
3. Extract `skill-directives.js` → snapshot test must pass
4. Extract `workspace-directives.js` → snapshot test must pass
5. Extract `research-directives.js` → snapshot test must pass
6. Extract `convergence-advisory.js` → snapshot test must pass
7. Extract native-tools directives → snapshot test must pass

Each extraction is a separate commit (per ADR-0035 rollback policy: per-file granularity).

## Artifacts

- Globe3 ticket retrospective: [globe3-research-report-loop-enabled-anomaly-2026-05-25.md](./globe3-research-report-loop-enabled-anomaly-2026-05-25.md)
- ADR-0034 (invalid-action convergence): [../adr/0034-invalid-action-observation-surface.md](../adr/0034-invalid-action-observation-surface.md)
- ADR-0035: [../adr/0035-prompt-content-as-host-overridable-defaults.md](../adr/0035-prompt-content-as-host-overridable-defaults.md)
- AGRUN-262 (implementation ticket): task.md § AGRUN-262
- Commits referenced:
  - `f7fa2630` — ADR-0034 doc + baseline test
  - `6dd00c00` — planner-prompt web_search/read_url advisory gating
  - `052085f9` — ADR-0034 invalidActionConvergence implementation
  - `f6100301` — remove suggestedNextMoves hardcoded category list
  - (session 2026-05-26) — `planner-prompt.js:57` SSOT fix (uses DEFAULT_READ_ONLY_PLANNING_FORBIDDEN_ACTIONS)
  - `planner-native-system-prompt.js:36` SSOT fix PENDING (AGRUN-262 pre-Phase-3)

## Next step

Draft ADR-0035 "agrun.js prompt content as host-overridable
declarative defaults" and put the extraction work on the backlog.
The current Globe3 ticket is closed by ADR-0034; ADR-0035 is the
architectural follow-up that prevents the NEXT host from hitting the
same pattern.

## Phase 1 inventory — VERIFIED against current code (2026-06-04, AGRUN-262)

The 2026-05-25 "Phase 3 extraction map" line numbers above are STALE
(measured when `planner-prompt.js` was ~1361 lines; it is now 1476).
This section supersedes them. Verified line ranges and the exact
**push order** that byte-identical extraction MUST preserve.

### `src/runtime/planner-prompt.js` → `buildSystemPromptLines` (187-315)

| # | Source lines | Content | Class | Gate | Target file |
|---|---|---|---|---|---|
| 0 | `BASE_SYSTEM_LINES` 71-109 | 38-line base array. Line 93 is a TEMPLATE LITERAL interpolating `DEFAULT_READ_ONLY_PLANNING_FORBIDDEN_ACTIONS.join(", ")` — array is computed at module load, not a frozen literal. Contains class-B advisory action refs (web_search/read_url/todo_*/workspace_*) inside `If loopState.X.active` lines. | unconditional (base) | `!compact` selects | `planner-base-directives.js` |
| 0 | `COMPACT_SYSTEM_LINES` 111-142 | 31-line compact array. Line 124 references `read_url` (class C). | unconditional (compact) | `compact` selects | `planner-compact-directives.js` |
| 1 | 195 | `Current standalone-only actions for plan validation: ${standaloneActionNames}.` | dynamic | always | **STAYS INLINE** (glue, not a named override section) |
| 2 | 197-204 | `list_agent_skills` block (compact: 1 line; base: 2 lines) | action-gated | `hasAction("list_agent_skills")` | `skill-directives.js` |
| 3 | 206-210 | `execute_skill_tool` block (compact/base variant) | action-gated | `hasAction("execute_skill_tool")` | `skill-directives.js` |
| 4 | 212-214 | `use_agent_skill` line | action-gated | `!compact && hasAction("use_agent_skill")` | `skill-directives.js` |
| 5 | 226-229 | `workspace_write` (2 lines, ALL modes incl compact) | action-gated | `hasAction("workspace_write")` | `workspace-directives.js` |
| 6 | 230-233 | propose+apply patch (2 lines) | action-gated | `hasAction("workspace_propose_patch") && hasAction("workspace_apply_patch")` | `workspace-directives.js` |
| 7 | 234-241 | `workspace_publish_candidate` (2 lines) | action-gated | `hasAction("workspace_publish_candidate")` | `workspace-directives.js` |
| 8 | 242-244 | `workspace_review_candidate` (1 line) | action-gated | `hasAction("workspace_review_candidate")` | `workspace-directives.js` |
| 9 | 246-257 | `!compact` workspace_write cluster (4 lines + nested publish sub-cluster 251-256) | action-gated | `!compact && hasAction("workspace_write")` (nested `publish`) | `workspace-directives.js` |
| 10 | 259-264 | base research block (4 lines) | action-gated | `!compact && (hasAction("read_url") \|\| hasAction("web_search"))` | `research-directives.js` |
| 11 | 272-278 | compact research block (5 lines) | action-gated | `compact && (read_url\|\|web_search)` | `research-directives.js` |
| 12 | 280-282 | preferFinalize execute_skill_tool line | action+flag-gated | `!compact && preferFinalizeOnLastResult && hasAction("execute_skill_tool")` | **STAYS INLINE** (interleaved AFTER research; folding into skill-directives would reorder bytes) |
| 13 | 284-286 | `!compact` → `buildTodoAutoPlannerGuidance(actions)` (already its own module `todo-auto-planner-guidance.js`) | action-gated | `!compact` | `todo-directives.js` (thin wrapper over existing module) |
| 14 | 288-312 | signal/convergence advisory block. compact: 1 line (289). base: many (291-311) with **SPIKE_STRIP_OODAE_SIGNALS gates at 293/305-307** → builder MUST take spike flag as param. | mode-gated + spike-gated | `compact ? 1 line : base block` | `convergence-advisory.js` |

**Push order is sequential 0→14.** Skill content is interleaved (steps
2-4 then 12). Step 12 (preferFinalize) MUST remain at its position
after research (steps 10-11), so it stays inline rather than joining
skill-directives — confirmed by advisor review.

### `src/runtime/planner-native-system-prompt.js` → `buildNativeToolsSystemPrompt` (4-69)

One assembled array (18-68). Lines 21-42 + 61-66 are unconditional;
21-42 include UNCONDITIONAL web_search/read_url refs (28-30) — a
pre-existing leak the snapshot locks as-is (Phase 6 lint scope, NOT
Phase 3). Gated sub-blocks: `list_agent_skills` (43-45),
`workspace_write` cluster (46-60, with nested `workspace_publish_candidate`
52-53 and `workspace_review_candidate` 55-56). Line 37 already uses the
SSOT `DEFAULT_READ_ONLY_PLANNING_FORBIDDEN_ACTIONS` template (pre-Phase-3
fix, verified intact). Target: `planner-native-directives.js`.

### Phase 2 snapshot coverage (the gate)

`test/unit/prompt-snapshot.test.js` locks FULL rendered text for 7
`buildSystemPromptLines` configs (incl. `compact-full` for the compact
branches and `default-full-prefer-finalize-off` for step 12 OFF) + 5
`buildNativeToolsSystemPrompt` configs (incl. `native-workspace-no-publish`
for the nested publish/review sub-gate OFF). `ALL_ACTIONS` is an explicit
literal list so coverage cannot silently shrink. Registered in
`test/smoke.test.js` → runs under `npm test`.
