# Task History Archive — 2026-05-27

Archived from task.md during refactor on 2026-05-27.
Covers: "Next Milestone" handoff log + completed ticket details from Active Roadmap.

Structured records: [task.jsonl](https://github.com/yapweijun1996/agrun/blob/main/0_development/task.jsonl) (176 entries, 164 done)
Live evidence: [agrun_docs/live-tests/](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/live-tests/)
ADRs: [agrun_docs/adr/](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/adr/)
Audits: [agrun_docs/audits/](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/audits/)

---

## End-of-Work Handoff State (2026-05-27)

Full header note from task.md line 1 at time of archive:

Session closed after Tools & Action Logic Arc (2026-05-27) fully closed:
- All 8 tickets DONE (AGRUN-278/281/275/276/277/279/280/282/283/284/285)
- 3 advisor gap-fixes committed (commit `3ce28dd9d`):
  - AGRUN-282: publishWorkspaceEvent wired into all 7 mutation action fns
  - AGRUN-283: pattern field added to resolvePermissionRules
  - AGRUN-285: negative test added
- dist/ rebuilt. 1119 PASS 0 FAIL
- Next arc: AGRUN-286 RunState SSOT ADR (unblocks AGRUN-287 P1 HITL)

Prior session items:
- AGRUN-288 session compaction study DONE — agrun already has filterByThreadWindow; AGRUN-290 created for compactionPolicy hook; AGRUN-289b/c created as follow-ups
- AGRUN-289 handoff_to_skill shipped — ADR-0043, 9 unit tests, npm test EXIT 0
- openai-agents-js-0.11.5 deep study complete — AGRUN-286/287/288 created; review: `agrun_docs/learnings-from-sample/openai-agents-js-0.11.5-review-2026-05-27.md`
- Custom LLM Provider model name input bug fixed — React 18 stale closure root cause
- 4-theme architecture audit: `agrun_docs/audits/agrun-deep-study-wrong-patterns-2026-05-26.md`
- AGRUN-262 ticket created for ADR-0035 implementation

---

## Next Milestone (pre-2026-05-27) — Narrative Log

This section preserves the step-by-step handoff notes from task.md lines 47–2209.

### End-of-Work Handoff 2026-05-25 (AGRUN-246-L offline calibration)

Stop commit: `d3974dad2` (docs: calibrate AGRUN-246-L query diversification).

Verification at stop:
- node --check scripts/calibrate-agrun-246-l-query-diversification.mjs PASS
- npm run build PASS | npm run dist:check PASS | npm test PASS (exit 0)
- task.jsonl parse PASS (160 entries)

Production readiness: Core runtime contracts good for controlled use.
Weak model long research remains blocker: flash-lite Mandarin baseline 3/7 = 43% strict pass.

### AGRUN-246 Research Quality Series (paused 2026-05-25)

Status at archive:
- **AGRUN-246-K** (source-relevance recovery): REJECTED — 0/3 live pass, code reverted via git checkout, never entered history. Evidence: `agrun_docs/live-tests/agrun-246-k-verify-rejected-2026-05-25.md`
- **AGRUN-246-L** (search-phase query diversification): REJECTED after 2 live batches (v1: AI skipped field 4/5; v2: AI locked into narrow angles, score=0 worst trace). Code reverted. Evidence: `agrun_docs/live-tests/agrun-246-l-verify-rejected-2026-05-25.md`
- **AGRUN-246-N** (orthogonality lever): RESEARCH OPEN. Needs: embedding-distance based diversification, no fixed token taxonomy, ≥5 trace live gate.
- **Cross-model baseline**: PAUSED mid-session due to laptop battery. Partial data in `agrun_docs/audits/agrun-cross-model-baseline-paused-2026-05-25.md`. Resume entrypoints documented.
- **AGRUN-246-J** (workspace repair closeout): DONE. Final run `2026-05-24T23-59-12-542Z` passed all strict gates. Evidence: `agrun_docs/live-tests/agrun-246-j-source-structure-closeout-2026-05-25.md`
- **AGRUN-246-M** (wikipedia scorer permissiveness): DONE — `ddadfb7d6`. Evidence: `agrun_docs/audits/agrun-246-m-wikipedia-scorer-permissiveness-2026-05-25.md`

Lesson recorded (2026-05-25): Unit-mechanism PASS ≠ behavioral lift. For any future LLM-behavior change: (1) calibrate threshold at the right phase, (2) live-verify ≥3 canonical reruns BEFORE commit, (3) plan for rollback as normal outcome.

---

## Completed Ticket Details (Active Roadmap, 2026-05-26 — 2026-05-27)

All details below were removed from the Active Roadmap in task.md. Structured records in task.jsonl.

### Tools & Action Logic Arc (2026-05-27) — ALL DONE

Source: Deep research of opencode-main / claude-code-source-code-main / codex-main
Reference: `agrun_docs/learnings-from-sample/tools-amendment-improvement-plan-2026-05-27.md`

| Ticket | Status | Summary |
|---|---|---|
| AGRUN-278 | DONE 2026-05-27 | Extended fuzzy replacer: 4 new strategies (normalize_whitespace, escape_normalized, line_normalize_whitespace, block_anchor). 5 new unit tests. 1120 PASS. |
| AGRUN-281 | DONE 2026-05-27 | defineAction() internal factory — validation + freeze for bundled actions. 7 unit tests. |
| AGRUN-275 | DONE 2026-05-27 | Fix hardcoded skill name check — `capabilities.requiresPublishReadiness` flag. 10 new PASS. |
| AGRUN-276 | DONE 2026-05-27 | Global camelCase↔snake_case alias auto-normalization in action-args-validation.js. |
| AGRUN-277 | DONE 2026-05-27 | Tier-based default permission policy: tier-0 → allow, tier-1+ → ask. |
| AGRUN-279 | DONE 2026-05-27 | Read-before-write enforcement for workspace mutations via checkWorkspaceReadRequirement(). |
| AGRUN-280 | DONE 2026-05-27 | Workspace mutation mutex — Promise-chain lock for concurrent edits. |
| AGRUN-282 | DONE 2026-05-27 | Typed Bus event system for workspace mutations. Gap-fix: publishWorkspaceEvent wired into all 7 mutation fns (commit 3ce28dd9d). |
| AGRUN-283 | DONE 2026-05-27 | Declarative permission spec { permission, pattern, action }. Gap-fix: pattern field added (commit 3ce28dd9d). |
| AGRUN-284 | DONE 2026-05-27 | Per-turn diff tracking (TurnDiffTracker pattern). |
| AGRUN-285 | DONE 2026-05-27 | Codex-style 4-level unicode normalization for workspace_apply_patch. Gap-fix: negative test added (commit 3ce28dd9d). |

### openai-agents-js Study Arc (2026-05-27) — Completed Items

| Ticket | Status | Summary |
|---|---|---|
| AGRUN-289 | DONE 2026-05-27 | handoff_to_skill action MVP. ADR-0043. 9 unit tests. Files: handoff-to-skill-action.js, action-registry.js, action-loop-plan-actions.js. |
| AGRUN-288 | DONE 2026-05-27 | Session compaction study spike. Finding: openai-agents-js compaction is OpenAI-server-specific, not portable. agrun already has filterByThreadWindow client-side. Gap: compaction not pluggable → AGRUN-290 created. Spike doc: agrun_docs/learnings-from-sample/compaction-study-2026-05-27.md |

### AGRUN-269 Unify Skill Loaders — Completed Sub-Tasks (2026-05-26 — 2026-05-27)

| Sub-Task | Status | Summary |
|---|---|---|
| AGRUN-270 | DONE | defineSkill(spec) + defineAction(spec) helpers. 10 new PASS. |
| AGRUN-271 | DONE | createRuntime({ customActions: [...] }) plumbing. 4 unit tests. |
| AGRUN-272 | DONE | Dogfood: examples/host-plugins/current-time-action.js with defineAction. |
| AGRUN-273 | DONE | JSDoc @deprecated on 6 Set A exports in src/index.js. |
| AGRUN-274a | DONE | Remove dead canHandle from gemini/openai-browser-skill.js. |
| AGRUN-274a FU | DONE | Fix router.js to mirror skill-probe.js isProviderAdapter skip. |
| AGRUN-274b-1 | DONE | test/helpers/legacy-set-a-skills.js — 23 test files migrated. |
| AGRUN-274b-2 | DONE | news-brief/web-search NO-OP stubs in helper. 13 test files migrated. |
| AGRUN-274d-1 | DONE | legacySkillLoop.mode gate in run-loop.js (warn/throw/silent). |
| AGRUN-274d-2 | DONE | 7 test files declare legacySkillLoop explicitly. |
| AGRUN-274d-3 | DONE | Default mode flipped to "throw". "warn" removed. |
| AGRUN-274e regrowth | DONE | test/unit/no-fire-and-forget-test-async.test.js — 188 files scanned. |
| AGRUN-274d-4 | DONE | run-skill-loop.js / router.js / skill-probe.js / cycle-outcome.js / skill-hooks.js DELETED. 1109 PASS. |
| AGRUN-274e | DONE | Major version bump 0.2.0 → 1.0.0. 6 Set A skill source files deleted. CHANGELOG.md written. |

Lesson (build-artifact-skew): AGRUN-274a's "1103 PASS" was false-green — dist/ not rebuilt with src. Future deletion-stage commits MUST git add dist/ alongside src.

### Long Task Lab (2026-05-26) — DONE

| Ticket | Status | Summary |
|---|---|---|
| AGRUN-268 | DONE 2026-05-26 | Mobile responsive + PWA + Wake Lock hardening. P1-P5 all landed. 320/375/1280px verified. |
| AGRUN-267 | DONE 2026-05-26 | Default provider does not override stale web_search/read_url settings. resolveEffectiveEndpoints() helper. |

### Bug Fixes Shipped (2026-05-26) — DONE

| Ticket | Status | Summary |
|---|---|---|
| AGRUN-256 (old) | DONE 2026-05-26 | workspace_publish_candidate mode gate for non-long_research hosts. |
| AGRUN-264 | DONE 2026-05-26 | researchReportLoop.enabled:false — sourceMinimum:null fix. Pattern B documented in feature-toggles.md. Regression test: globe3-tool-loop-deficit-regression.test.js. Shipped with AGRUN-263. |
| AGRUN-263 | DONE 2026-05-26 | read_only_planning blind to tool results — runtimeConfig.productiveProgressDimensions knob. recentToolFingerprints dedup. Shipped with AGRUN-264. |
| AGRUN-255 (old) | DONE 2026-05-26 | spawn_subagent child-tool approval gap — Option C: tools:[...] as pre-approval contract. 7 new unit tests. Live e2e 38s success. |
| AGRUN-254 | DONE 2026-05-26 | spawn_subagent orchestrator/worker delegation. ADR-0037. 9+4 unit tests. Live e2e success. |

### AGRUN-265 Audit (2026-05-26) — Audit Complete, 2 Doc Items Remain Open

Audit of *.enabled:false opt-out flags: 1 RISKY (AGRUN-264, already fixed), 10 CLEAN, 0 new tickets.
Pattern B (producer-side gate before state assignment) is the canonical safe shape.
Pattern A (unconditional createXState() at init) is the AGRUN-264 trap.

Open doc items (carried into active roadmap):
- [ ] Document Pattern B in agrun_docs/feature-toggles.md
- [ ] Update snapshot-vs-planner request body distinction note

---

## Current Critical Findings (All Done — Archived)

All findings in the table at task.md lines 2185–2209 are marked Done.
See task.jsonl entries with status=completed_with_hbr for structured records.

Key findings archived:
- OODAE-CYCLE-INSPECTOR (Done) — OODAE cycle ledger added to Inspector/support bundle
- LLM-FINALIZER-SOURCE-WINDOW-COMPARE (Done) — read_url textStart/textLength window
- AGRUN-214m (Done ✅) — 3-topic Chrome E2E COMPLETE 2026-05-19
- AI-FIRST-RESEARCH-FINALIZE (Done) — finalReadiness AI-first contract
- DEEP-RESEARCH-WRITER-EVIDENCE-DISCIPLINE (Done) — read_url failure ≠ evidence
- All remaining findings: see task.jsonl + agrun_docs/audits/

---

## Recently Completed Table (pre-archive task.md, lines 3104–4250)

Covers AGRUN-106 through AGRUN-253 and the "Recently Completed" section.
All entries are in task.jsonl with status=completed_with_hbr.
Evidence docs preserved in agrun_docs/live-tests/ and agrun_docs/audits/.

Key milestones:
- AGRUN-247 Config lifecycle + permission metadata (2026-05-24)
- AGRUN-248 A-E: Workspace candidate lifecycle, action output envelope, event ledger, planner repair, RunState projections (2026-05-24 — 2026-05-25)
- AGRUN-249 Long-form expansion + structure-repair signal harness (2026-05-24)
- AGRUN-250 Terminal churn/performance cleanup (2026-05-24)
- AGRUN-251 Late-budget workspace protocol guard (2026-05-24)
- AGRUN-252 Todo publish readiness churn guard (2026-05-24)
- AGRUN-253 Mandarin CJK structure repair + search-saturation signal (2026-05-24)
- AGRUN-246-J Source+structure closeout (2026-05-25)
- AGRUN-246-M Wikipedia scorer permissiveness (2026-05-25)

Full long-task-lab history: task-board-done-tickets-2026-05-23.md
Earlier history: task-board-archive-2026-04-25.md
