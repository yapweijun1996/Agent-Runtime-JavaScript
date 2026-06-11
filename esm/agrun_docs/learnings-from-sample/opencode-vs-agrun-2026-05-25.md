# Learnings From Sample — opencode v1.1.48 vs agrun (2026-05-25)

A controlled comparison study running the same long-form research task
(3000-word report on Harness Engineering) across opencode (sst.dev's
Bun+TypeScript agent CLI) and agrun (this project's browser-first
vanilla JS agent runtime) with the same model. Goal: identify what
agrun should adopt from opencode, what it should preserve, and where
the two systems' designs are complementary rather than competing.

This document anchors the 17 verified KB memos saved 2026-05-25
under `kb_recall "opencode agrun"`. It is the human-readable index.

## TL;DR

* Same model + same prompt + different runtime = very different output.
* The dominant factor is **model tier**: `gemini-3.1-flash-lite` +
  `variant=low` cannot deliver a 3000-word long-form report regardless
  of harness; `gemini-3.5-flash` + `variant=low` can.
* The second factor is **runtime enforcement**: agrun's readinessAudit
  (length / structure / source gates) produces target-aligned output
  (3246 / 3000 = 108%); opencode without a length gate overshoots
  (4765 / 3000 = 159%) and lets the model lie about its own word count.
* The third factor is **wiring details** (skill / AGENTS.md / MCP /
  hard rules). Wiring shifts results within ±300 words across 5 opencode
  configurations on the same model; tier shifts results by 4×.
* **Both systems are good with a strong model.** With flash-3.5 each
  delivered a substantive, useful report. Differentiator is
  TRUST/HONESTY (agrun wins: runtime-measured count, no model
  self-attestation, no Mandarin tail leak) vs VISUAL/STRUCTURAL
  EXPANSION (opencode wins: ASCII diagram, Abstract section, explicit
  4-system coverage).

The recommended adoption from opencode is the **typed event bus
projection over SSE** ([ADR-0036](../adr/0036-typed-event-bus-sse-projection.md)).
The recommended preservation in agrun is the **runtime-gated
readinessAudit** that opencode demonstrably lacks.

## Experiment matrix

Same prompt template: "Write a 3000-word English report on Harness
Engineering for AI agents. Sections: definition, core principles,
vs prompt engineering, real-system examples (Claude Code / opencode /
Codex / agrun), practical guidelines, common pitfalls. End with
WORD_COUNT: <n>."

All opencode runs invoked via headless `opencode serve --port 4097
--print-logs --log-level=DEBUG`, sessions created via
`POST /session`, prompts sent via `POST /session/{id}/prompt_async`,
events streamed via `GET /event` SSE. agrun runs via
`npm run test:live:node-3000` against the bundled long-form pipeline.

| # | Runtime | Model | Wiring | Actual words | Model-claimed | Tool calls | URLs | Time |
|---|---|---|---|---|---|---|---|---|
| oc1 | opencode | flash-lite | bare | 232 | — | skill+bash errors | 0 | 30s |
| oc2 | opencode | flash-lite | +skill | 1898 | — | 1 skill | 0 | 21s |
| oc3 | opencode | flash-lite | +grounding cfg (ignored) | 1456 | — | 1 skill | 0 | 30s |
| oc4 | opencode | flash-lite | +AGENTS.md bash curl recipes | 1284 | 1392 (+8%) | 14 bash + 1 skill | 4 | 41s |
| oc5 | opencode | flash-lite | +MCP research server | 1165 | 3042 (+161%) | 4 search + 0 read | 6 shallow | 19s |
| oc6 | opencode | flash-lite | +MCP + AGENTS.md hard rules | 1228 | 3012 (+145%) | 4 search + 8 read | 5 | 43s |
| oc7 | opencode | **flash-3.5** | +MCP + hard rules | **4765** | 3185 (−33%) | 10 search + 7 read | 5 | 1m44s |
| A1 | agrun | flash-lite | native pipeline | 819 | runtime: 819 | 17+ cycles, 3 read | 3 | 8.5min |
| A2 | agrun | **flash-3.5** | native pipeline (no debug) | 3209 | runtime: 3209 | 21 cycles, 3 read | 3 | ~50min (provider anomaly) |
| A2b | agrun | **flash-3.5** | native pipeline (+ AGRUN_DEBUG, replay) | **3246** | runtime: 3246 | 14 cycles, 5 read | 4 | **2m40s (normal)** |

Key numbers in bold are the headline results for each runtime with
the strong model.

## Five structural findings

### 0. Speed correction (provider variance dominates outliers)

The first agrun + flash-3.5 run (A2 in the matrix) took ~50 min
wall-clock; the DEBUG re-run (A2b) of the same setup took **2 min
40 sec**. Same model, same wiring, same prompt. Action wall time
(web_search + read_url + workspace_*) was ~8-10 sec in both runs.
The 18× difference was provider-side latency variance — silently
slow Gemini responses with no retry/timeout error logged. Per-cycle
times averaged 140 sec in the slow run vs 11 sec in the normal run.

The intrinsic agrun-vs-opencode speed ratio is **~1.5-2× slower**,
not 30×. Sources of the intrinsic slowdown:

1. Multiple LLM evaluators per cycle (planner +
   researchAcceptanceEvaluator + requirementRecoveryEvaluator +
   readinessAudit + terminalRepairState) vs opencode's one planner
   call per step.
2. Rolling-state prompt grows to ~30-40 KB by mid-run (loopState
   field bloat) vs opencode's ~5 KB.

When reading the figures elsewhere in this doc, treat **2-3 min** as
the typical agrun runtime for the 3000-word task, with 1.5-2× the
opencode wall-clock as the cost of agrun's gate architecture. The
50-min figure is a provider-side outlier, not a design property.

### 1. The bottleneck order is model > runtime enforcement > wiring details

Across the 9 runs, the variance pattern is:

* Same wiring on opencode (oc4 / oc5 / oc6 with flash-lite):
  ±300 words variance.
* Same model on opencode (oc1–oc6 with flash-lite): 232–1898 word
  range, never reaches 3000.
* Same opencode wiring (MCP + hard rules), upgraded model (oc6 →
  oc7): 1228 → 4765 words. **3.9×** in a single change.
* Same agrun pipeline, upgraded model (A1 → A2): 819 → 3246.
  **4.0×** in a single change.

Wiring optimization on a weak model is rounding error. Model upgrade
on either runtime moves the headline metric by a full order of
magnitude. The first thing to check when a long-form task underperforms
is model tier, not prompt or hard rules.

### 2. Harness is a multiplier, not a capability source

The 2×2 cell pattern:

|  | Weak harness (opencode, no length gate) | Strong harness (agrun, readinessAudit) |
|---|---|---|
| Weak model (flash-lite) | 1228 (silent under-deliver) | 819 (decision=limited, explicit) |
| Strong model (flash-3.5) | 4765 (overshoot 59%) | 3246 (precise 8% over target) |

Strong harness + weak model gracefully fails (explicit limited
publish with failingGates listed). Weak harness + strong model
overshoots silently. Only strong harness + strong model produces a
target-aligned, trustworthy deliverable.

### 3. Model self-reports are systematically wrong; runtime measurement is the only honest path

The WORD_COUNT field in opencode runs lied in different magnitudes
and directions:

| Model | Actual | Claimed | Lie ratio |
|---|---|---|---|
| flash-lite oc4 | 1284 | 1392 | +8% |
| flash-lite oc5 | 1165 | 3042 | +161% |
| flash-lite oc6 | 1228 | 3012 | +145% |
| flash-3.5 oc7 | 4765 | 3185 | −33% |

Weak model lies UPWARD to satisfy the "minimum 3000 words"
requirement. Strong model writes more than required and estimates
conservatively (lies DOWNWARD but with smaller magnitude). Either
direction, opencode has no runtime layer that re-counts the text it
received and verifies. Self-Verification block (which oc6 introduced
via AGENTS.md template) is filled in by the same model that produced
the body — same hand that lies.

agrun's runtime independently computes `observedLength` per cycle
([runtime-event-ledger.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/runtime-event-ledger.js))
and refuses to claim ready until the gate passes. agrun's A2 run
runtime-measured 3209 / actual 3246 = ~1% margin (caused only by
which counting heuristic we apply to Markdown).

### 4. The 3-layer wiring model (Schema / Nudge / Enforcement)

Validated across the 7 opencode wiring attempts:

* **Layer 1 — Schema**. MCP server with typed `web_search` and
  `read_url` tools. Provides clean cross-client portability. Necessary
  but not sufficient: weak model in oc5 (MCP only, no rules) used
  search 4× but never called read_url. Tools available ≠ tools used.
* **Layer 2 — Nudge**. AGENTS.md with HARD RULES section
  (numbered, enforced framing) or bash-curl tutorial recipes. Drives
  model behavior toward deeper tool use. oc4 (bash-curl tutorial) and
  oc6 (MCP + hard rules) both produced 4–8 read_url calls; oc5 (MCP
  alone) got 0.
* **Layer 3 — Enforcement**. Runtime gates that re-verify model
  output independently. Only agrun has this today
  ([src/runtime/readiness-audit.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/readiness-audit.js)
  and neighbors). opencode has no equivalent.

Production runtime needs all three. Layer 1 alone produces
decorative tools. Layer 1 + Layer 2 produces grounded research with
unreliable self-reporting. Layer 1 + Layer 2 + Layer 3 produces
target-aligned, trustworthy output.

### 5. Quality is multi-dimensional; agrun and opencode are complementary

oc7 (opencode + flash-3.5) and A2 (agrun + flash-3.5) both produce
publishable reports with different strengths:

| Dimension | oc7 opencode | A2 agrun |
|---|---|---|
| Words | 4765 | 3246 |
| Target alignment | 159% overshoot | 108% precise |
| Sections | Abstract + 7 numbered + Refs + Self-Verification | 6 numbered + Refs |
| Mandarin tail leak | yes (AP/HE/UP/Next Step) | none, clean English |
| References | 5 cited URLs | 4 cited URLs |
| Self-Verification block | yes (model self-attests) | none (runtime verifies) |
| WORD_COUNT honesty | model 3185, actual 4765 | runtime 3209, actual 3246 |
| Technical specificity | medium (Tool.define, MCP, doom_loop) | high (ESLint, Ruff, Firecracker, Pydantic, MMLU/GSM8k/SWE-bench) |
| Industry citation depth | partial (blog authors) | strong (DORA, Augment 6-metric framework verbatim) |
| 4-system explicit coverage | Claude Code + opencode + Codex + agrun | OpenAI + Codex + LangChain + Fowler |
| Visual aids | ASCII paradigm diagram | LaTeX equation `Agent = Model + Harness` |

oc7 reads like a survey paper (academic framing, 4-system
side-by-side, Abstract). agrun's A2 reads like an engineering blog
(named tools, real metric frameworks, clean assertions). Different
registers, both substantive.

## Side-by-side reports

Reports preserved as artifacts. Read them in parallel for the deepest
comparison:

* opencode flash-3.5: `/tmp/report-oc7_flash35_low.md` (4765 words)
* agrun flash-3.5: `/tmp/report-agrun_flash35_low.md` (3246 words,
  copy of `agrun_debug_runs/2026-05-26T00-58-17-665Z-report.md`)

Earlier flash-lite reports preserved for reference:

* `/tmp/report-oc4_AGENTS_bashcurl.md` (1284 words)
* `/tmp/report-oc5_MCP_norules.md` (1165 words)
* `/tmp/report-oc6_MCP_hardrules.md` (1228 words)

agrun full run trace: `agrun_debug_runs/2026-05-26T00-58-17-665Z.md`
(366KB) and matching `.jsonl` (126KB) with every cycle's
`cycleCount`, `planner_decision`, `candidateWords`, `gates`,
`qualityScore`, `failingGates`, `remainingGaps`.

## What agrun should adopt from opencode

These are the design lessons worth porting. Each links to the KB
memo with the detailed analysis.

1. **Typed event bus + SSE projection.**
   Drafted as
   [ADR-0036](../adr/0036-typed-event-bus-sse-projection.md). agrun's
   `runtime-event-ledger.js` already produces v1 typed events; what's
   missing is the cross-process subscription surface. opencode's
   `GET /event` SSE endpoint demonstrates that external observers can
   subscribe to a running agent loop with one `curl -N` command.
2. **Per-message JSON storage.** opencode persists every message
   under `~/.local/share/opencode/storage/message/ses_X/msg_Y.json`
   and every part under `storage/part/<msg>/<prt>.json`. This makes
   post-mortem replay trivial. agrun today writes
   `agrun_debug_runs/<timestamp>.{md,jsonl}` as a single pretty-printed
   blob, which is human-friendly but machine-hostile.
3. **Tool.define unified contract.** opencode's
   `packages/opencode/src/tool/tool.ts` `Tool.define(id, init)` wraps
   every tool with schema decode + InvalidArgumentsError formatting +
   tracing + output truncation in one place. agrun's actions
   distribute these concerns. A `defineAction` wrapper analogous to
   `Tool.define` would reduce boilerplate without losing agrun's
   tier/planner-readability projection.
4. **Subagent task with parentID lineage.** opencode's
   `TaskTool` spawns a real child session with `parentID`, resumable
   `task_id`, and explicit permission inheritance via
   `deriveSubagentSessionPermission`. agrun has no subagent today;
   if/when it adds one this is the reference design.
5. **Skill format (markdown with YAML frontmatter at a standard
   path).** opencode reads `.opencode/skill/<name>/SKILL.md` with
   `name:` and `description:` frontmatter. Verified portable: the
   same skill file format works in Claude Code and likely Cursor.
   Worth adopting in agrun for cross-tool skill sharing.

## What agrun should preserve (not learn from opencode)

These are agrun's actual advantages — do not regress them while
adopting opencode patterns.

1. **Model-decided termination is wrong for long-form.** opencode
   trusts the model to emit `step-finish`; this works for short
   coding loops but fails systematically on long-form
   (oc4 ends at 1284, oc5 at 1165, oc6 at 1228, oc7 at 4765 — none
   target-aligned). agrun's `readinessAudit` ([length-convergence
   guard](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/readiness-audit.js)) keeps the AI
   working until gates pass.
2. **Independent runtime measurement of length/structure/source.**
   The five model self-reports above lied by 8–161%. agrun's runtime
   counts the text it received; the model cannot lie to a Python
   `len(text.split())` running outside its context.
3. **Workspace mutation contract (read-before-mutate).** agrun's
   `workspace_write`, `workspace_replace`,
   `workspace_insert_after_section`, `workspace_propose_patch`,
   `workspace_apply_patch`, `workspace_publish_candidate` actions
   gate every mutation behind read-before-mutate and
   not-accumulating detection (cycle 11 of A1 fired
   `workspace_write_not_accumulating` exactly when the weak model
   was redundantly rewriting). opencode has no equivalent; it lets
   `bash` or `write` operate without structural guards.
4. **Invalid-action convergence ([ADR-0034](../adr/0034-invalid-action-observation-surface.md)).**
   When the planner emits a disabled action repeatedly, agrun
   surfaces a structured `invalidActionConvergence` observation
   rather than burning step budget silently. opencode has a
   `doom_loop: ask *` permission but it's a coarser human-in-loop
   gate.
5. **OODAE phase + cost ledger as first-class events.** agrun
   tracks `observe / orient / decide / act / evaluate` per cycle
   and a per-provider cost ledger. opencode has bus events but no
   phase classification or cost accounting; users can't ask "how
   much did this run cost" without extra tooling.

## Production decision matrix

For a user choosing which runtime to use today:

| Need | Recommendation |
|---|---|
| Precise word count + trustworthy metrics + clean English | agrun + strong model |
| Visual structure (ASCII/tables) + explicit system comparison + speed | opencode + MCP + AGENTS.md hard rules + strong model |
| Engineering doc with named tools and real industry citations | agrun |
| Academic-format survey with Abstract + References + Self-Verification | opencode |
| Production agent runtime where the output goes to users who will trust it | agrun (runtime-verified) |
| Short coding loop (`fix this bug, run tests`) | opencode (its sweet spot) |
| Quick prototype / one-shot research | opencode + strong model (1m vs 50m) |
| Any task with a weak model (`flash-lite`-tier) | Neither for long-form; both produce silent under-delivery or limited publish |

## Reusable artifacts

### opencode side
* `/tmp/opencode-3000-test/mcp-research/server.js` — minimal MCP
  server (~110 lines, `@modelcontextprotocol/sdk` v1.x) exposing
  `web_search` + `read_url` tools bound to user-supplied endpoints
  via environment variables. Reusable in any opencode / Claude Code /
  Cursor MCP client.
* `/tmp/opencode-3000-test/opencode.json` — project config with
  `mcp.research` declaration. Pattern for declaring local stdio MCP
  servers.
* `/tmp/opencode-3000-test/AGENTS.md` — hard-rules template proven
  to drive a weak model from 0 read_url calls (oc5) to 8 (oc6).
  Pattern: numbered rules + verify-before-cite + length minimum +
  Self-Verification template.

### opencode debugging recipe (verified)
```
opencode serve --port 4097 --print-logs --log-level=DEBUG 2> bus.log &
curl -N -sS http://127.0.0.1:4097/event > events.jsonl &
# create session
curl -X POST http://127.0.0.1:4097/session -d '{"title":"..."}'
# fire prompt
curl -X POST http://127.0.0.1:4097/session/{id}/prompt_async -d '{...}'
```
**Do not** use `opencode run --attach` (slow bootstrap, 5+ min stalls
under poor conditions). **Do not** pipe `opencode run` stdout through
`tail` without `-f` (Bun batches stdout when not a tty, output
appears only at process exit).

### agrun side
* `agrun_debug_runs/2026-05-26T00-58-17-665Z-report.md` (23KB,
  3246 words) — final_candidate.md from the A2 run, full text.
* `agrun_debug_runs/2026-05-26T00-58-17-665Z.md` (366KB) — full
  pretty-printed trace.
* `agrun_debug_runs/2026-05-26T00-58-17-665Z.jsonl` (126KB) —
  JSONL trace; one cycle per line for machine consumption.

## Known gaps and open questions

1. **Token cost not measured.** agrun runs ~50 min and uses ~21
   cycles × planner-prompt; opencode runs ~2 min with fewer cycles
   but writes more output. Dollar cost per 1000 trusted words has not
   been computed. This is the missing economic decision input.
2. **The `decision: "limited"` UI bug in agrun.** Both A1 (819
   words) and A2 (3246 words) marked decision=limited despite A2
   scoring qualityScore=100/100 with all gates passing. The "limited"
   label is contaminated by an orthogonal evaluator checking for
   identity/company verification (irrelevant to a harness engineering
   report). Production users see "limited" and assume failure. ADR
   needed to either decouple decision from those evaluators or upgrade
   the label set to differentiate "accepted with caveats" from "real
   gate failure".
3. **CLAUDE.md / AGENTS.md leak path.** opencode reads global config
   from `~/.config/opencode/` and project `AGENTS.md`. The author's
   global CLAUDE.md (AP/HE/UP/Next Step format) cascades into
   opencode-generated reports as a Mandarin tail. agrun's runtime
   doesn't read CLAUDE.md, so its reports are clean. For users
   sharing systems across multiple agent CLIs, this is a contamination
   path worth knowing about.
4. **opencode-side `verify_publish` MCP tool.** Hypothetical: write
   an MCP tool that does what agrun's readinessAudit does (independent
   word count, structure check, source-density check). Mount it on
   opencode. The hard rule "must call verify_publish before
   step-finish; if it returns INSUFFICIENT, expand" would replicate
   agrun's enforcement layer in opencode without modifying opencode
   source. This would be the cleanest way to backport agrun's
   long-form harness contributions to opencode. Not implemented.
5. **MCP `read_url` body verification.** Both opencode and agrun
   runs that cited references mostly used real URLs, but neither
   study did a byte-by-byte audit of "is this [N] citation's claim
   actually supported by the fetched URL's content". Hallucinated
   citations remain a residual risk. A `verify_citation` step would
   catch this.
6. **Strong model + agrun on a different prompt.** This study used
   the harness-engineering prompt. Other long-form tasks (legal brief,
   incident postmortem, design doc) may stress different agrun gates.
   The 100/100 score is for this one task with this one model.

## How to extend this study

* **Add a Codex / Claude Code arm.** Both are MCP-compatible. Wiring
  the same `mcp-research` server and AGENTS.md to Claude Code would
  produce a third data point on the wiring side. Worth comparing
  whether Claude Code's hooks system (which agrun lacks) produces
  different behavior on the same prompt.
* **Try `gemini-3-pro` and `gemini-2.5-pro`.** Above `flash-3.5`,
  hypothesis is diminishing returns but better citation honesty.
* **Try strong agrun + weak opencode comparison.** Hypothesis: agrun
  with flash-3.5 (`A2`, 3246 words, 100/100) beats opencode with
  flash-lite (`oc6`, 1228 words, 145% lie). Confirmed inline above.
* **Implement `verify_publish` MCP tool**. Test whether layer-3
  enforcement backported into opencode via MCP closes the
  Q-of-Failure gap.

## KB cross-references

This document indexes 17 verified memos saved in the KB. Use
`kb_recall "opencode agrun"` to surface them. The top-level index
memo (`#9 INDEX`) lists each one with a one-line summary.

| KB memo | Topic |
|---|---|
| 1 | opencode CLI observability recipe |
| 2 | opencode 3000-word baseline (no skill) |
| 3 | opencode WITH skill (8× improvement) |
| 4 | Agent loop / session.prompt differential |
| 5 | Typed event bus differential |
| 6 | Tool contract differential |
| 7 | Permission ruleset differential |
| 8 | Compaction gap |
| 9 | INDEX memo |
| 10 | agrun vs opencode 3000-word grounding A/B |
| 11 | opencode CAN do grounded via AGENTS.md curl |
| 12 | opencode + MCP: tools available ≠ used |
| 13 | opencode + MCP + hard rules (read_url 0→8) |
| 14 | 3 reports quality audit (flash-lite) |
| 15 | gemini-3.5-flash vastly outperforms flash-lite |
| 16 | agrun + flash-3.5 = qualityScore 100/100 |
| 17 | Full content audit (this document's source) |

## Author note

This study was performed 2026-05-25 to 2026-05-26 in a single
session, running real provider API calls against
`gemini-3.1-flash-lite` and `gemini-3.5-flash` with `variant=low`.
Total wall time across all 9 runs was approximately 3 hours. All
metrics are from real runs, not simulations.
