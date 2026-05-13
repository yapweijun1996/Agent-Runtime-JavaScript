# Workspace Readiness + Plan-Args SSOT — 2026-05-11

Follow-up to `workspace-publish-real-gemini-2026-05-10.md`. That session ended with
the long-research run still terminating at `continuation_required` with
`final_candidate=missing`. Two structural fixes landed in this session:

1. Plan-args fallback SSOT (Phase 1).
2. Workspace readiness facts surfaced into the planner prompt (Phase 2).

This live-test doc records what was deterministically verified and what still
requires a manual real-Gemini long-form run.

## Phase 1 — Plan-args fallback SSOT

**Change**: extracted the duplicated alias chain (toolArgs / tool_args /
toolArguments / tool_arguments + their *Json variants + arg_-prefixed flat
fields) into `src/runtime/plan-args-fallback.js`. Both call sites
(`normalizePlanActionArgs` in `planner-tools.js`, `readActionArgs` in
`action-loop-utils.js`) now import the same `readPlanActionFallbackArgs` +
`mergeMissingArgs` helpers. Removed the "For Gemini" hardcode in the
plan-tool description text — capability registry (`toolArgsJsonRequired`)
is now the single SSOT, the description is provider-neutral.

**Determinism verified**:
- New unit suite `test/unit/plan-args-fallback.test.js` (13 PASS) covers every
  alias key, JSON parse failure, empty-object rejection, flat-arg collection
  with `arg_` prefix stripping, reserved-key exclusion, non-object inputs,
  non-mutating merge, null/undefined back-fill.
- Existing related suites stay green: `planner-tools-decision.test.js` (13
  PASS), `action-plan-args-validation.test.js` (5 PASS),
  `action-args-alias.test.js` (5 PASS).
- Full `npm test` exits 0.
- `npm run build` rebuilds `dist/agrun.js` and the browser example.
- In-browser fetch of the served modules confirms:
  - `plan-args-fallback.js` ships `readPlanActionFallbackArgs` +
    `mergeMissingArgs`.
  - `planner-tools.js` and `action-loop-utils.js` import the SSOT (both have
    the symbol after build).
  - Neither file contains `For Gemini` anywhere.

## Phase 2 — Workspace readiness facts in planner prompt

**Change**: `buildVirtualWorkspacePromptBlock` in `src/runtime/virtual-workspace.js`
now appends three new fact lines to its existing advisory state block:

```
final_candidate_status=<missing|empty|drafted|ready>
final_candidate_chars=<int>
final_candidate_cjkChars=<int>
final_candidate_words=<int>
cycles_used=<int>          # optional, only when caller passes it
cycles_max=<int>           # optional, only when caller passes it
```

`cycles_used` / `cycles_max` are wired from `runState.cycleCount` /
`runState.maxSteps` in `planner-prompt.js`. The trailing prose was rewritten
to:

> Facts above are read-only observations. AI owns the next move:
> workspace_read/list to review, web_search/read_url for evidence,
> workspace_write/replace to improve, workspace_finalize_candidate when
> ready, workspace_publish_candidate to send the selected candidate
> verbatim, or finalize with limitations if you judge evidence is exhausted.

Every line is fact-only. Runtime never says "you should publish",
"recommend", or any imperative push. The unit test asserts those exact
absences.

**`final_candidate_status` derivation** (no decisions, just classification):
- `missing` — no file at the candidate path.
- `empty` — file exists, content is empty.
- `drafted` — file has content but `quality.finalCandidateReady !== true`.
- `ready` — file has content AND `workspace_finalize_candidate` was called.

**Determinism verified**:
- New unit suite `test/unit/virtual-workspace-readiness-prompt.test.js`
  (8 PASS) covers all four status values, cycles fields appearing /
  omitted, char/word/cjk surfacing, and the fact-only invariant
  (regex assertions against `you should`, `must publish`, `recommend`).
- `english-codebase.test.js` invariant respected: CJK fixture uses
  `String.fromCharCode(0x4E2D, 0x6587, ...)` so source stays ASCII.
- Existing `virtual-workspace.test.js` (28 PASS) and
  `workspace-actions.test.js` (8 PASS) still green.
- In-browser fetch of `/@fs/.../virtual-workspace.js` and `/@fs/.../dist/agrun.js`
  confirms `final_candidate_status=`, `cycles_used=`,
  `read-only observations`, and `readFinalCandidateStatus` are all present
  in the bytes the browser will load.
- Dev server (`vite --port=3000`) starts clean, UI loads, console-error log
  is empty.

## What was NOT verified in this session

The full 80-step real-Gemini deep-research e2e from
`workspace-publish-real-gemini-2026-05-10.md` was **not** re-run. A real
long-research call against Gemini takes many minutes wall-time per run and
is non-deterministic; queueing it inside this session would have consumed
the budget without giving a stable signal.

The structural changes that the previous session's HBR pointed at are now
in the runtime the browser loads. Whether they actually shorten the
"draft.md exists but final_candidate.md missing" gap is the next live
question.

## Update — Real Gemini e2e via Chrome MCP (2026-05-11, after first version of this doc)

Ran the live e2e at the user's request via `mcp__chrome-devtools` against
the same prompt:

> 用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告

Setup:
- `npm run build` (Phase 1 + Phase 2 in dist + browser bundle).
- Vite dev server on `:3000`, Gemini provider, model
  `gemini-3.1-flash-lite-preview` (browser default), `maxSteps=80`.
- New chat (no prior history).
- Send + wait for terminal state.

**Real result — runtime hard-rejected the publish call:**

| Field | Value |
|---|---|
| `cycleCount` | **53** (out of 80) |
| `status` | `failed` |
| `terminalizedBy` | `null` (uncaught throw, not a normal terminator) |
| `finalAnswerSource` | `null` |
| Error code | `ACTION_EXECUTE_ERROR` |
| Error skill | `workspace_publish_candidate` |
| Error cause | "workspace_publish_candidate requires workspace_read after workspace_finalize_candidate for final_candidate.md. Read the candidate textStats, compare them against the user's concrete requirements yourself, revise if needed, sync any active TodoState, and publish again." |
| TodoState | i-1 制定研究大纲 still `active`; i-2..i-5 still `pending` |

Inspector evidence captured at
`agrun_docs/live-tests/workspace-readiness-real-e2e-2026-05-11.jpeg`.

**Root cause — push-mode site missed in the previous review:**

[`src/runtime/actions/virtual-workspace-actions.js:301-325`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/actions/virtual-workspace-actions.js#L301)
contains four hardcoded runtime throws on `workspace_publish_candidate`:

1. `if (!text)` — empty content (legitimate I/O guard).
2. `if (!publishProtocol.finalizedAfterLatestWrite)` — throws if AI did
   not call `workspace_finalize_candidate` after the last write.
3. `if (!publishProtocol.readAfterFinalize)` — throws if AI did not call
   `workspace_read` after `workspace_finalize_candidate`. **This is the
   one that fired in the e2e above.**
4. `if (!readinessCheck.ok)` — throws on `inspectPublishReadiness` veto.

Throws #2, #3, #4 are runtime making AI decisions FOR the AI:
"you must call action X before action Y in this exact sequence". When AI
violates the protocol, runtime kills the entire run — 53 cycles of real
work erased — instead of letting AI observe the gap and recover.

Per CLAUDE.md ("no hardcode, no hardcode, no hardcode" / AI-first), this
is the same anti-pattern that the previous push-mode deletion sprint
(commits `703d2feb0` quality gate veto, `fd360d559` planner guardrails,
`0734f5752` AGRUN-214o P4+P5) was eliminating. These four throws were
overlooked.

**What the structural changes from this session DID achieve:**

- Phase 1 SSOT shipped: no `invalid_url` repeats from earlier
  `toolArgsJson`/`args:{}` mismatch. AI's `read_url` and `web_search`
  calls executed with non-empty args throughout.
- Phase 2 readiness facts shipped to the prompt block (verified earlier
  via `/@fs/.../virtual-workspace.js` byte fetch). The AI did reach
  workspace `final_candidate.md` ready state in this run — that is a
  measurable improvement over the 2026-05-10 run which never got there.

**What blocked the actual goal:**

The AI's call sequence was close to correct but did not match the rigid
write → finalize → read → publish protocol the runtime enforces. The
runtime threw on the `read after finalize` guard, killing the run. AI
never got the chance to recover.

## Recommended fix (next session)

Delete throws #2, #3, #4 in
[`virtual-workspace-actions.js:301-325`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/actions/virtual-workspace-actions.js#L301).
Replace with read-only fields in the workspace prompt block (Phase 2
already established the pattern). For example:

```
publish_protocol_state=finalized_after_write:yes, read_after_finalize:no
```

Then AI can decide on the next planner cycle to call `workspace_read`
first, or argue with explicit limitations why direct publish is OK. The
runtime stays a fact reporter, not a sequence enforcer.

Throw #1 (empty content) stays — that is a legitimate I/O guard, not a
behavioral push.

## Re-confirmed pass criteria (still valid for the next rerun after the fix)

- `terminalizedBy === "workspace_publish_candidate"` (not `null` /
  `ACTION_EXECUTE_ERROR`).
- `final_candidate_chars >= 2500` (or `<` with explicit
  `finalReadiness.decision="limited"` + Limitations section).
- Published text matches `final_candidate.md` byte-for-byte (no finalizer
  rewrite).
- TodoState i-5 marked `completed`.

## Update — Real Gemini e2e AFTER push-mode deletion (2026-05-11, same session)

Implemented the recommended fix per user's pick of Option 1:

- Promoted `inspectWorkspacePublishProtocol` to `src/runtime/virtual-workspace.js`
  as an exported SSOT helper.
- Refactored
  [`executeWorkspacePublishCandidateAction`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/actions/virtual-workspace-actions.js#L302):
  throws #2/#3/#4 are gone. When prereqs are unmet the action now returns
  `control:"continue"` with `kind:"virtual_workspace_publish_blocked"` +
  a `message` field explaining what is missing — AI sees the message as
  its next observation and decides recovery, runtime never kills the run.
  Throw #1 (empty content) stays — that is a legitimate I/O guard.
- Workspace prompt block in `virtual-workspace.js` now also surfaces
  `publish_protocol_state=finalized_after_write:yes|no, read_after_finalize:yes|no`
  alongside the readiness facts from earlier in this session.
- New unit assertions added to
  `test/unit/virtual-workspace-readiness-prompt.test.js`; existing
  `workspace-actions.test.js` already used `assertPublishBlocked` matching
  the new shape.
- Full `npm test` exits 0 (everything green).

**Real Gemini e2e — same prompt, same model, fresh chat:**

| Field | Before (53-cycle fail) | After (this run) |
|---|---|---|
| `runStatus` | `failed` | **`completed`** |
| `finalAnswerSource` | `null` | **`workspace_publish_candidate`** |
| `terminalizedBy` | `null` (uncaught throw) | **`workspace_publish_candidate`** |
| `cycleCount` | 53 / 80 | **13 / 80** |
| `error` | `ACTION_EXECUTE_ERROR` | `null` |
| Last activity | `Run failed` | **`Completed Workspace Publish Candidate`** |
| Activity count | ~20 (then died) | 37 (full pipeline) |
| Published chars | n/a (never published) | 899 chars / 503 cjk_chars |

Inspector evidence at
`agrun_docs/live-tests/workspace-readiness-real-e2e-after-2026-05-11.jpeg`.

**Pass criteria check:**

- ✅ `terminalizedBy === "workspace_publish_candidate"`.
- ✅ Published text rendered in chat UI matches the deep-research-writer
  workspace candidate path (no finalizer rewrite).
- ⚠️ `final_candidate_chars` 899 / 503 cjk_chars vs requested 3000 字.
  Length is short — but **this is no longer a runtime failure**, it is
  an AI quality call that the model was free to make. The skill text
  encourages `finalReadiness.decision="limited"` with a Limitations
  section in this case; the rendered report did include a "挑战与治理"
  section but did not declare an explicit Limitations / `requestedLength`
  block. That is now the next AI-quality follow-up, not a runtime bug.

## Update — Bug A fix: TodoState audit preserved at terminal (2026-05-11)

User reviewed Run #4 inspector and pointed out a real runtime mismatch:
TodoState shows `4/5 done` in inspector, activity log shows AI ran
todo_plan / todo_advance / todo_run_next, but querying chat-store
session-level `todoState` returns `null`. The two timelines did not
"tally" — runtime was destroying the audit snapshot at terminal.

**Root cause** (inspected, not guessed):
- `src/runtime/todo-state-finalize-sync.js:44` did
  `runState.todoState = null` at terminal, "to avoid steering the next
  turn".
- `handle.js:345` mirrors `runState.todoState` back onto
  `activeThread.todoState`. Null in -> null out.
- Chat-store session-level `todoState` therefore appeared null even
  though AI had built and partially completed a real Todo plan.
- The "do not steer the next turn" intent is correct, but the
  implementation conflated state ownership (what runtime knows) with
  prompt projection (what the planner sees) — destroying state to
  prevent prompt rendering.

**Fix shape — annotate, do not destroy:**
- [`todo-state-finalize-sync.js`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/todo-state-finalize-sync.js):
  `observeTodoStateOnTerminal` now sets
  `runState.todoState = { ...prev, terminatedAt, terminatedBy }`.
  Items keep their honest status (no false completion). The audit
  snapshot survives in `activeThread.todoState`.
- [`run-state-thread.js`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/run-state-thread.js):
  `isTerminalTodoState` now also returns `true` when
  `todoState.terminatedAt != null`. Next-turn hydration nulls
  `runState.todoState` (clean slate, no steering).
- [`todo-state.js`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/todo-state.js):
  `summarizeTodoStateForPrompt` short-circuits to `null` when
  `terminatedAt != null` (defensive at the central render site).
- [`planner-prompt.js`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner-prompt.js):
  `hasPromptTodoState` excludes terminated todoStates from the
  long-run-state classification (defensive at the projection profile).
- `buildTodoStateBlockForCycle` reuses `summarizeTodoStateForPrompt`
  so the third render site is automatically gated (no edit needed).

**Tests**:
- [`test/unit/todo-state-finalize-sync.test.js`](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/todo-state-finalize-sync.test.js)
  inverted: now asserts `runState.todoState` is preserved with
  `terminatedAt`+`terminatedBy` annotations, items keep their honest
  status, and the legacy `todoTerminalObservation` audit fields stay
  intact.
- New [`test/unit/todo-state-terminated-projection.test.js`](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/todo-state-terminated-projection.test.js)
  covers the end-to-end flow: pre-annotation render, post-annotation
  short-circuit at all three gates, plus the next-turn hydration
  decision (mirror of `isTerminalTodoState` contract).
- [`test/unit/thread-hydration.test.js`](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/thread-hydration.test.js)
  extended with two new assertions: `terminatedAt` triggers reset on
  hydration; an active plan WITHOUT `terminatedAt` still carries over
  (regression guard).
- [`test/concerns/planner.test.js`](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/concerns/planner.test.js)
  publish-candidate assertion updated from "todoState === null" to
  "todoState preserved with terminatedBy === workspace_publish_candidate".

**Real Gemini e2e proof (post-fix, fresh chat, lite model):**

| Field | Pre-fix (Run #4) | Post-fix (this) |
|---|---|---|
| `chat-store.session.todoState` | **`null`** ❌ audit lost | **5 items preserved with honest status** ✅ |
| → has `terminatedAt` | n/a | **yes** ✅ |
| → has `terminatedBy` | n/a | **`workspace_publish_candidate`** ✅ |
| → items honest? | n/a | i-1/2/3 done, i-4 active, i-5 pending — **AI's actual progress** ✅ |
| `runtime-store.threads[].todoState` | null | **preserved** ✅ |
| `lastRun.todoTerminalObservation` | preserved (status/source/counts) | **still preserved** ✅ unchanged |
| `terminalizedBy` | `workspace_publish_candidate` | `workspace_publish_candidate` ✅ |
| `runStatus` | `completed` | `completed` ✅ |

Inspector evidence at
`agrun_docs/live-tests/todo-state-audit-preserved-2026-05-11.jpeg`.

**Two-layer audit now visible**:

1. `lastRun.todoTerminalObservation` — runtime's "what happened at
   terminal" snapshot (counts, source, status). Pre-existing.
2. `activeThread.todoState` — AI's actual TodoState with `terminatedAt`
   annotation. NEW: now preserved at session level so chat-store /
   support-bundle / external debug tools can audit AI's plan progress
   without spelunking through `lastRun.todoTerminalObservation`.

**No push-mode introduced**:
- Items keep their honest status; runtime never marks unfinished items
  as done.
- Annotation fields are pure observation — no decision.
- The "next turn not steered" responsibility moved from state-destruction
  to prompt-projection gates (correct separation).

## Update — Honest baseline AFTER hardcode revert (2026-05-11, Run #4)

Real Gemini e2e on the same prompt with the AI-first runtime
(plan-args SSOT + readiness facts + publish push-mode deletion;
**no** hardcoded user-request signals):

| Field | Value |
|---|---|
| `runStatus` | `completed` |
| `finalAnswerSource` | `workspace_publish_candidate` |
| `terminalizedBy` | `workspace_publish_candidate` |
| `cycleCount` | 33 / 80 |
| `error` | `null` |
| `activeSkillName` | **`null`** (AI did not load any skill) |
| `lastReadSkill` | **`null`** (AI did not even read a skill) |
| Workspace files | 4: `evidence.json`, `draft.md`, `critique.md`, `final_candidate.md` |
| `final_candidate_chars` | 2035 |
| `final_candidate_cjkChars` | **1327 (44% of requested 3000)** |
| Operations | 16 (7 reads + 5 writes/replaces of draft.md, then final_candidate write+finalize+read) |

Inspector evidence at
`agrun_docs/live-tests/workspace-readiness-real-e2e-honest-baseline-2026-05-11.jpeg`.

**Four-run comparison on the exact same prompt + lite model
(`gemini-3.1-flash-lite-preview`):**

| Run | Runtime state | cycles | activeSkill | files | chars / cjk_chars | % of req | Notes |
|---|---|---|---|---|---|---|---|
| #1 | Throws + push-mode bug | 53 (failed) | n/a | n/a | 0 / 0 | 0% | runtime crash; published nothing |
| #2 | After throws→blocked refactor | 13 | none | 1 (draft only) | 899 / 503 | 17% | one-shot draft, AI skipped 5 of 6 Todo phases |
| #3 | + hardcoded user-request signals (REVERTED) | 41 | long-web-research | 3 | 3195 / 2127 | 71% | bought with hardcode; disowned |
| #4 (this) | Honest baseline post-revert | 33 | **none** | **4** | 2035 / 1327 | **44%** | proper artifacts, real iteration |

**Key honest observations from Run #4:**

1. **2.6x cjk_char improvement over Run #2** without any new hardcode.
   The publish-push-mode deletion alone gives AI room to iterate (7
   reads of draft.md, multiple writes — AI is watching its own
   progress and revising), and that lifts delivery from 17% to 44%.
2. AI made the right artifacts (`evidence.json` -> `draft.md` ->
   `critique.md` -> `final_candidate.md`) WITHOUT loading any skill.
   The deep-research-writer pattern is structural enough that the AI
   reproduced it from the planner prompt's general workspace guidance.
3. AI still did not declare `finalReadiness` and still did not
   `read_agent_skill` / `use_agent_skill` — same gap as Run #2 / #3,
   but no longer a runtime failure, just an AI quality gap.
4. 44% delivery is honest. It is what the lite model + the AI-first
   runtime actually produces on this exact prompt. Run #3's 71% was
   bought with hardcode and is no longer claimed.

**True next-step shape (still no runtime intent parsing)**:

- Skill workflow: tighten `deep-research-writer` SKILL.md Phase G text
  to ask AI to compare requested vs observed length BEFORE publishing.
  This is AI-level (skill is AI's tool), not runtime push.
- Model baseline: rerun the same prompt against `gemini-2.5-pro` (non
  lite) on the same runtime, see if a stronger model closes the
  44% -> 100% gap on its own.
- Default-model selection: hosts should be allowed to default complex
  research prompts to a non-lite model when the user prompt looks
  complex; that decision belongs in the host UI, not the runtime.

The 44% baseline is the number to beat with AI-first follow-ups
(skill text + model selection). Beating it with runtime hardcode is
forbidden.

## Update — REVERTED: user-request signals were a hardcode violation (2026-05-11)

**Important correction**: the "user-request signals" fix described
below in the next section was **reverted** in the same session because
the user (correctly) pointed out it was hardcoded AI work in runtime.

`parseRequestedLength` and `findRelevantSkillMatch` were both runtime
doing semantic interpretation of the user's prompt:
- The regex `\d+ <unit>` is a hardcoded interpretation of how users
  express length requirements. Different users phrase it differently
  ("about three thousand characters", "around 3k", "long enough to be
  thorough"). A regex that bakes in one phrasing is the same shape as
  the deleted English-only research-trigger regexes from prior sprints.
- The skill ranker is runtime deciding which tool fits the user's
  request — that is the planner's job. AI is supposed to look at the
  catalog (already exposed via `list_agent_skills`) and choose.

The user prompt sits at the top of every planner prompt under
`User request: ...`, verbatim. The workspace prompt block already
shows `final_candidate_chars=N`, `final_candidate_cjkChars=N`, and
`final_candidate_words=N`. AI has both pieces. **The comparison is AI's
work**, not runtime's.

**What was reverted (2026-05-11)**:
- Deleted `src/runtime/user-request-signals.js`.
- Deleted `test/unit/user-request-signals.test.js`.
- Removed the `userRequestSignals` option + the
  `user_requested_length` / `relevant_skill_match` lines from
  `buildVirtualWorkspacePromptBlock` in `src/runtime/virtual-workspace.js`.
- Removed the `parseUserRequestSignals` import + call in
  `src/runtime/planner-prompt.js`.
- Updated `test/unit/virtual-workspace-readiness-prompt.test.js` to
  assert the **absence** of `user_requested_length` /
  `relevant_skill_match` so future contributors do not re-introduce
  the same hardcode.
- Removed the smoke runner registration of the deleted unit test.

`npm test` exits 0 after the revert; build is clean. The Run #3 e2e
result described below (71% delivery, AI activated long-web-research,
revised at cycle 27) was REAL, but it was bought with hardcode and is
therefore disowned. The next AI-first run on the same prompt will
likely regress to ~17%-30% delivery on lite models, and that regression
must be accepted honestly rather than masked by runtime intent parsing.

**True root cause restated (after the revert)**:
AI saw both the user's requested length (verbatim in the prompt) AND
the workspace observed-length facts. AI did not compare them. That is
an AI quality / model strength gap. The honest next steps are model
selection (`gemini-2.5-pro` baseline) and skill workflow tightening
(SKILL.md text encouraging AI to compare requested vs observed before
publishing) — NOT runtime intent parsing.

The notes below remain in this file as **a record of what was
attempted and why it was wrong**, not as a description of current
runtime behavior.

## (Reverted) Update — User-request signals (length + relevant skill) (2026-05-11)

After the publish-push deletion landed, the next live e2e exposed a
deeper failure: AI delivered only **17%** (503 cjk_chars vs 3000 字)
because it never read or activated any skill, never made `outline.md` /
`evidence.json` / `critique.md`, jumped from a one-shot `draft.md` to
publish in 13 cycles. Inspector forensics showed:

- `agentSkillContext.activeSkill = null` — AI listed catalog but did not
  `read_agent_skill` / `use_agent_skill`.
- `isLongResearchRun = false` (because no active skill in
  `LONG_RESEARCH_SKILL_IDS`).
- → `isResearchPublishReadinessRequired = false` →
  `inspectPublishReadiness` returned `{ok: true}` early without checking
  length / requirementsAssessment.
- → AI never declared `finalReadiness`; runtime had nothing to compare
  observed length against.

The runtime was honest about the FACTS it knew (workspace-side stats),
but it never surfaced **what the user asked for** as a fact alongside.
AI saw `final_candidate_cjkChars=503` with no anchor, so "ship it" was
a defensible local choice.

**Fix (AI-first observation, no push)**:

New module `src/runtime/user-request-signals.js` exports:

- `parseRequestedLength(prompt)` — language-neutral regex parse for
  `\d+ <unit>` with units = `cjk_chars` (字, 个字), `chars` (字符,
  characters), `words`, `tokens`. Returns `null` when no concrete length
  is in the prompt. Single-digit values rejected (avoid year/ordinal
  false positives).
- `findRelevantSkillMatch({ manifests, prompt, activeSkillName,
  lastReadSkillName })` — minimal token-overlap ranker (inline copy of
  the production ranker logic, no virtual: imports) returns the
  top-scoring catalog manifest plus whether AI has loaded it.
- `parseUserRequestSignals(options)` — bundles both.

The workspace prompt block now appends two new fact lines (only when
the parsed signal is present):

```
user_requested_length=3000 cjk_chars
relevant_skill_match=long-web-research (loaded:no, score:48)
```

These are pure facts. No imperative. AI compares
`user_requested_length=3000 cjk_chars` to `final_candidate_cjkChars=503`
itself and decides whether to revise, expand, or publish with explicit
`finalReadiness.decision="limited"`. Same pattern for the skill match —
runtime states the ranking, AI decides whether to load.

Wired through `planner-prompt.js` so every cycle ships these facts.
Source CJK invariant kept: regex literals use
`new RegExp("\\u5B57", "u")` so source stays ASCII; the test fixture
uses `String.fromCharCode(0x5B57, ...)`.

**Real Gemini e2e — same prompt, same model, fresh chat:**

| Field | Before signals | After signals |
|---|---|---|
| `cycleCount` | 13 / 80 | **41 / 80** (3.2x) |
| `activeSkillName` | `null` | **`long-web-research`** ✅ |
| `lastReadSkill` | `null` | **`long-web-research`** ✅ |
| Workspace files | 1 (draft.md only) | **3** (outline.md, draft.md, final_candidate.md) |
| `final_candidate_chars` | 899 | **3195** ✅ |
| `final_candidate_cjkChars` | 503 (17% of req) | **2127 (71% of req)** ✅ 4.2x |
| Workspace operations | 3 (write→finalize→read) | **10** including a `c27#replace@final_candidate.md` (revision after seeing the gap) |
| `terminalizedBy` | `workspace_publish_candidate` | `workspace_publish_candidate` ✅ |
| `runStatus` | `completed` | `completed` ✅ |

Inspector evidence at
`agrun_docs/live-tests/workspace-readiness-real-e2e-after-signals-2026-05-11.jpeg`.

**Critical observation — AI actually used the signals:**

Workspace operation timeline:
```
c9  write@outline.md
c11 write@draft.md
c13 read@draft.md
c14 write@draft.md             (revision)
c16 write@final_candidate.md
c20 finalize_candidate
c22 read@final_candidate.md
c27 replace@final_candidate.md (REVISION after seeing the length gap)
c29 finalize_candidate
c31 read@final_candidate.md
(publish)
```

c27 is the proof: AI saw the readiness facts, chose to expand rather
than ship-as-is. Before the signals, the same model never reached this
behavior in any prior run.

**Remaining gap (not a runtime bug)**:

71% of requested length is still not 100%. Two contributing factors:

1. AI did not declare `finalReadiness.requirementsAssessment` in the
   publish call (`researchFinalizeContract` is `null`), so the publish
   readiness audit never compared `requestedLength` to `observedLength`.
   This would have either prompted further revision OR forced an
   honest `decision="limited"` declaration with the gap stated.
2. Lite model (`gemini-3.1-flash-lite-preview`) plateaus at ~2100
   cjk_chars in this domain even with the signals visible.

**Layer A is the next AI-first work** — the publish readiness audit
should look at `user_requested_length` from prompt parsing as a default
when AI omits `finalReadiness.requirementsAssessment.requestedLength`,
so AI can no longer publish with no comparison even if it skips the
self-audit. Still no push — just a stronger blocked observation when
the gap is large.

**Layer B is a model selection question** — testing the same prompt
with `gemini-2.5-pro` would baseline what a non-lite model produces
under the same signals.

**HBR retained**: small-model gap. `gemini-3.1-flash-lite-preview` is a
lite model and produced ~17% of the requested length on its first try.
Before this fix, that gap was masked by the runtime crash. Now that
runtime publishes whatever the AI decided to publish, the small-model
length gap surfaces honestly. Two valid next moves (NOT now, just for
record):

1. Encourage AI to revise/expand before publish via stronger SKILL.md
   wording in deep-research-writer Phase G (still no runtime push).
2. Test the same prompt with `gemini-2.5-pro` to baseline what a
   non-lite model produces with the same harness.

Either is a future PR. The 2026-05-11 PG goal — "let
`workspace_publish_candidate` actually publish without runtime
killing the run" — is achieved.

## Manual rerun procedure (next step)

1. `npm run build` (already done in this session — produced
   `dist/agrun.js` 7.8 MB, `dist/example/assets/index-De6pMLkr.js`).
2. Confirm `.env.local` has `BROWSER_DEV_AUTOSEED_KEYS=true` and a real
   `GEMINI_API_KEY`.
3. Start the browser example: `npm --prefix examples/browser run dev` or
   re-use the `agrun-browser` Claude Preview launch config.
4. Open `http://localhost:3000`, pick the Gemini provider in Settings,
   confirm `maxSteps=80`, ensure `deep-research-writer` is in the active
   skill catalog.
5. Send the same prompt as 2026-05-10:

   > 用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告

6. Let the run terminate (or hit `maxSteps`).
7. In the inspector:
   - Open the Payload tab and inspect any planner prompt sent after
     the AI created `draft.md`. The "Virtual workspace advisory state"
     block must now include `final_candidate_status=<missing|empty|drafted>`
     and `cycles_used=<N>` / `cycles_max=80`. **If those lines are
     missing, Phase 2 wiring failed and this is the bug to fix.**
   - Read `terminalizedBy` in the result panel. Goal:
     `workspace_publish_candidate`.
   - Read the published text. Goal: `>= 2500 chars` and equal byte-for-byte
     to `final_candidate.md` (no finalizer rewrite).

## Pass criteria for the manual rerun

- `terminalizedBy === "workspace_publish_candidate"`
- Published text length matches `final_candidate.md` length exactly.
- `final_candidate_chars >= 2500` (≈ 3000 字 target with reasonable
  allowance; evidence-thin reports below this should ship as
  `finalReadiness.decision=limited` with an explicit Limitations section).
- `readUrlOk >= 5` successful reads in inspector.

## Anti-criteria — DO NOT do these if the rerun fails

- Do not add a runtime auto-publish trigger ("if final_candidate_chars >
  X then publish"). That re-introduces push-mode and kills AI-first.
- Do not strengthen the prompt wording to "you should publish now". The
  fact-only contract is the whole point of Phase 2; pushing AI via prose
  is the same problem in a different file.
- If the AI still loops, the real next step is the previous review's
  Option 2: split SKILL.md Phase G into G1 Publish path / G2 Finalize
  fallback so the publish signal is no longer buried in
  finalize-centric guidance.

## Files touched this session

- new: `src/runtime/plan-args-fallback.js`
- modified: `src/runtime/planner-tools.js` (use SSOT, drop "For Gemini"
  wording)
- modified: `src/runtime/action-loop-utils.js` (use SSOT)
- modified: `src/runtime/virtual-workspace.js` (readiness summary)
- modified: `src/runtime/planner-prompt.js` (pass cyclesUsed/cyclesMax)
- new: `test/unit/plan-args-fallback.test.js`
- new: `test/unit/virtual-workspace-readiness-prompt.test.js`
- modified: `test/smoke.test.js` (wire new units)
- rebuilt: `dist/agrun.js`, `dist/example/*`, `examples/browser/dist/*`
