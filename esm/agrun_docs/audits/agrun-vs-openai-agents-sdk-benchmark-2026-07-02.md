# agrun vs OpenAI Agents SDK — live Node.js benchmark (2026-07-02)

Follow-up to the same-day architecture comparison (todos/plan tracking, state
management, performance — see KB memory `94ea12fa-cc39-4221-976f-48adccf2fd7d`,
which itself cross-checks the 2026-06-07 cross-project synthesis). That review
was code-reading + docs research; this is the live-API measurement it called for.

Benchmark tool: [examples/agent-sdk-benchmark/](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/agent-sdk-benchmark/)
(reusable — `npm run test:live:agent-sdk-benchmark` from repo root, or
`npm run bench` inside the folder). Raw results:
`examples/agent-sdk-benchmark/bench-results.2026-07-02T06-16-39-281Z.json`
(gitignored local artifact — numbers below are the durable record).

## Methodology

Both sides: same OpenAI model (`gpt-5-mini`, agrun's existing live-test default),
same two prompts, same deterministic in-process tool (`lookup_order` — fixed
120ms synthetic delay, no network) defined once in `shared-tools.mjs` and
wrapped per-SDK, so the only variable is SDK/runtime overhead. 5 iterations per
runtime per tier.

- **minimal** — `Reply with exactly: pong`, no tools registered.
- **agentic** — one prompt requiring 2 `lookup_order` calls before answering.

agrun ran its built `dist/agrun.js` (what actually ships), not raw `src/`.

## Results

| Tier | Runtime | Wall-clock mean | Wall-clock median | Tool calls | Total tokens (mean) |
|---|---|---|---|---|---|
| minimal | agrun | 4439ms | 4886ms | 0 | 5465 |
| minimal | openai-agents-sdk | 1719ms | 1833ms | 0 | 101 |
| agentic | agrun | 15633ms | 15845ms | 2 | 7520 |
| agentic | openai-agents-sdk | 7195ms | 6732ms | 2 | 1236 |

agrun was ~2.6x slower (minimal) and ~2.2x slower (agentic) wall-clock, and used
~54x (minimal) / ~6x (agentic) more tokens per turn than the OpenAI Agents SDK,
for behaviorally equivalent tasks against the identical model.

## Root cause (verified, not just inferred from the totals)

Token usage breaks down almost entirely on the **input/prompt** side:

| Configuration | Input tokens (minimal, no-tool turn) |
|---|---|
| OpenAI Agents SDK, `tools: []` | 33 |
| agrun, default (`agentSkills: []`, no `disabledActions`) | 5130 |
| agrun, all 27 built-in actions explicitly disabled | 2335 |

Disabling every built-in action (`web_search`, `read_url`, `repo_rg`, the
`workspace_*` family, the `todo_*` family, etc. — see `src/runtime/actions/`)
cuts input tokens by ~54%, confirming most of the gap is agrun's **flat,
always-listed action registry**: the planner prompt enumerates the full built-in
catalog regardless of `actionPolicy`, even for a task that needs zero tools.

The remaining ~2300 input tokens (present even with everything disabled) is
fixed OODAE planner-envelope scaffolding — guidance/format instructions that
apparently don't shrink with the action count. This is a second, separate cost
from the registry-listing one above.

This is not a new discovery in the abstract — it directly confirms and
quantifies a gap already on record from the 2026-06-07 cross-project synthesis:
*"No dynamic tool filtering — flat always-available registry."* What's new here
is a real measured number: **~2800 tokens/turn from the registry alone, ~2300
tokens/turn fixed overhead beneath that, on every single turn regardless of
task complexity.**

## Interpretation

- OpenAI Agents SDK's `tools: []`-by-default posture is the harder-to-beat
  comparison point precisely because it starts from nothing — you pay only for
  what you register. agrun's batteries-included default (every built-in action
  always described to the model) is a deliberate discoverability tradeoff, but
  this benchmark puts a real cost on it: ~53 tokens per pong reply becomes
  ~5400.
- The gap narrows proportionally on the agentic tier (6x vs 54x) because both
  sides' token counts grow with the actual work done, but the fixed overhead is
  still paid once per turn on the agrun side regardless of task size.
- Wall-clock gap (2.2-2.6x) is plausibly downstream of the token gap (more
  input tokens to process before the model can respond) rather than a separate
  runtime-loop inefficiency — this benchmark cannot fully separate "OpenAI API
  processing time for a bigger prompt" from "agrun's own dispatch overhead"
  without server-side timing instrumentation, which is out of scope here.

## Caveats

- N=5 per cell, single run, ordinary network conditions — good enough to see a
  2-54x gap clearly, not precise enough for a "4439ms ± Xms" confidence
  interval. Re-run with `--iterations 20` for a tighter estimate if this number
  needs to go in front of stakeholders.
- Both tiers use a synthetic zero-network tool by design (see the benchmark
  README) — this isolates SDK overhead but says nothing about real tool
  (web search, file I/O) latency, which would dominate in production and
  shrink the *relative* gap somewhat, though not the fixed per-turn tax.
- `gpt-5-mini` reasoning-token behavior (`outputTokenDetails.reasoningTokens`)
  may itself respond to prompt complexity — a longer agrun prompt could be
  inducing more model-side reasoning, not just more tokens to read. Not
  separated out here.

## Exact prompt breakdown (captured from the real HTTP request body)

The aggregate numbers above and the disabled-actions probe explain *how much*
but not precisely *what*. To get precise evidence rather than inferring from
totals, `globalThis.fetch` was monkey-patched to capture the literal JSON body
agrun sent to `api.openai.com` for the minimal-tier ("Reply with exactly:
pong") turn, both with agrun's default config and with all 27 built-ins
disabled. Two messages are sent: a `developer` message (system/contract
instructions) and a `user` message (request + live loop state).

| Configuration | developer msg chars | user msg chars | total chars |
|---|---|---|---|
| default | 16222 | 8398 | 24620 |
| all built-ins disabled | 7620 | 3627 | 11247 |

Breaking the **default** request down by section (all sizes from the actual
captured body, not estimated):

- **Action catalog described TWICE, in two different forms**: once as a
  `name: description` list in the user message's "Available actions:" block
  (4641 chars / 26 actions), and again as a `name args={...}` example-args
  list inside the developer message's "Valid envelopes" block (part of a
  5018-char section). Same 26 actions, two different renderings, both sent on
  every turn regardless of whether any of them apply.
- **"Loop state" JSON blob**: 3515 chars, 34 top-level keys
  (`actionFailureSignal`, `actionPatternConvergence`, `terminalRepairState`,
  `researchReportLoop`, `researchAcceptanceEvaluator`,
  `requirementRecoveryEvaluator`, `invalidActionConvergence`, `toolContext`,
  etc.) — on a fresh trivial turn essentially every field is `null`, `false`,
  `[]`, `0`, or an "idle"/"tracking" status. The nested objects
  (`researchReportLoop`, `researchAcceptanceEvaluator`,
  `requirementRecoveryEvaluator`) each carry 10-15 sub-fields of their own,
  all at rest — the schema is fully spelled out even when nothing is
  happening.
- **Planner-contract instructions** (the bulk of the remaining developer
  message) cover terminal-repair recovery rules, workspace patch/replace/
  normalize_headings repair rules, the research-report-loop contract, and
  todo-state sync rules — a full page of conditional "if
  `loopState.X.active=true`, do Y" instructions for subsystems that are
  irrelevant to a one-word reply and never engage.
- **Minor, pure waste**: the literal prompt text `"Reply with exactly: pong"`
  is repeated verbatim 3 times in the developer message alone (as "Current
  goal", "Current topic", and "Active query").

Source: [`src/runtime/planner-prompt.js`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner-prompt.js)
`buildPlannerSystemPrompt` / `buildSystemPromptLines` (pulls in
`prompts/planner-base-directives.js` or `planner-compact-directives.js`
depending on mode, `workspace-directives.js`, `research-directives.js`,
`todo-directives.js`, `convergence-advisory.js`, `buildEnvelopeLines`,
`buildGuidanceLines`) and `buildPlannerPrompt` (builds the `loopState` object
from ~15 different signal-summarizer calls, `actionDescriptions`,
`historyBlock`).

### File-level attribution (corrected — first pass measured the wrong mode)

`gpt-5-mini` runs through `selectPlannerSystemPromptProfile`'s default path,
which selects **compact** mode (`planner-compact-directives.js` +
`convergence-advisory.js`'s `compactSystemPrompt:true` branch), not the base
variant. Measuring the base-mode files first gave a wrong (much larger)
number for the "unconditional" bucket — corrected by measuring the actual
functions with the actual options used at runtime. Reconciled to 96.2% of the
24620-char total:

| Source | Chars | % of total | Gated on `hasAction(...)`? |
|---|---:|---:|---|
| `prompts/planner-compact-directives.js` | 5940 | 24.1% | **No — unconditional** |
| "Available actions" description list | 4641 | 18.9% | Scales with registered actions (26/26 by default) |
| `prompts/workspace-directives.js` | 3460 | 14.1% | Yes, but `workspace_*` all registered by default |
| Loop-state JSON (34 keys) | 3515 | 14.3% | N/A — live state, mostly idle on simple turns |
| "Action args examples" line | 3202 | 13.0% | Scales with registered actions |
| Fixed envelope format templates | 1816 | 7.4% | Partially (JSON contract baseline) |
| `prompts/research-directives.js` | 770 | 3.1% | Yes, but `web_search`/`read_url` registered by default |
| `prompts/convergence-advisory.js` (compact) | 157 | 0.6% | **No — unconditional** |
| `prompts/skill-directives.js` | 178 | 0.7% | Yes, but skill actions registered by default |
| `prompts/todo-directives.js` | 0 | 0% | Fully suppressed in compact mode |

**Two distinct root causes, not one:**

1. **~25% is structurally unconditional** (`planner-compact-directives.js` +
   `convergence-advisory.js`) — these two files never check
   `hasAction(...)`, unlike their siblings (`workspace-directives.js`,
   `research-directives.js`, `skill-directives.js`), so they describe
   terminal-repair/convergence/workspace-patch recovery rules on every turn
   regardless of whether those subsystems could possibly engage. This is a
   genuine gating gap — architecturally inconsistent with the files that do
   it correctly.
2. **~49%** (available-actions list + args-examples + workspace-directives +
   research-directives combined) *is* correctly gated in code on
   `hasAction(...)` — but the gate is always open in practice, because
   nothing upstream of the prompt builder ever narrows `availableActions`
   down to what a given task actually needs. agrun registers all 26
   built-ins unconditionally by default with no per-request scoping. This is
   the original "no dynamic tool filtering" finding — now confirmed as the
   *larger* of the two contributors, not the smaller action-catalog-dedup
   angle explored first.

Root cause (2) is the higher-leverage fix: narrowing `availableActions` for
a given request (e.g. a host declaring "this is a simple Q&A session, no
workspace/research/skills needed") would silently shrink categories 2, 3, 5,
and 7 in the table above (a combined ~49%) without touching any gating logic,
since the `hasAction()` checks already do the right thing once the input
list is actually smaller.

**Why OpenAI Agents SDK doesn't pay this cost**: `new Agent({tools: []})` has
no equivalent concept — no loop-state object, no envelope contract, no
action catalog to describe (because there are no actions), no repeated
context blocks. Its default is empty; you pay only for what you explicitly
register. agrun's OODAE loop is one unified state machine handling every mode
(plain Q&A, tool use, multi-step planning, workspace drafting, research,
skill execution) through one always-fully-described contract — there is
currently no "mode" concept that prunes the prompt down to only what a given
turn's registered actions and active subsystems actually need. This is a
broader finding than the original "no dynamic tool filtering" gap: it is not
just the action catalog that's always-on, the orchestration *bookkeeping*
(loop state, convergence trackers, idle nested objects) is too.

Wall-clock: a larger prompt costs more provider-side prefill time before
generation can start, which plausibly explains a real share of the 2.2-2.6x
latency gap — this benchmark doesn't have server-side timing to attribute the
split precisely, but the token-count gap and the latency gap point the same
direction.

## Suggested follow-up (not done in this pass)

1. Dynamic/lazy tool filtering for agrun's planner prompt — only describe
   built-in actions that are actually `allow`ed/registered for this run,
   instead of the full catalog every turn. Directly addresses the ~2800
   token/turn registry cost measured above.
2. De-duplicate the action catalog — it is currently rendered twice (user
   message "Available actions" list + developer message "Action args
   examples" list) for no apparent reason; collapsing to one rendering is a
   smaller, lower-risk win than full dynamic filtering and could ship first.
3. Omit or compact "at rest" loop-state fields — the 3515-char/34-key
   `loopState` object is mostly `null`/`false`/`[]`/idle on a fresh or simple
   turn; a `JSON.stringify` that drops `null`/default fields (or a
   coarser "nothing active" summary) would shrink it substantially without
   losing signal on turns where those subsystems are actually engaged.
4. Investigate the ~2300-token fixed OODAE envelope floor beyond the two
   items above — is all of the terminal-repair/workspace-patch/research-loop
   directive text necessary on every turn, or can some of it be conditionally
   included only when the relevant subsystem is active for that run?
5. If this comparison needs to be authoritative (e.g. for an ADR), re-run with
   higher iteration counts and add server-timing instrumentation to separate
   "OpenAI processing a bigger prompt" from "agrun's own loop overhead."
