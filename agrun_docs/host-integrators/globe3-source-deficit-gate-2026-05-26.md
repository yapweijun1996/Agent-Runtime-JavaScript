# Reply to Globe3 — `terminalRepairState.activeDeficits:['source']` despite `researchReportLoop:{enabled:false}` (AGRUN-264)

Subject: Re: New failure mode — terminalRepairState.activeDeficits:['source'] despite researchReportLoop:{enabled:false} (job e0f52c12) + your Debug Log follow-up

---

Two of your emails just landed; combining the reply because the second one (cycle-7 finalize evidence) materially sharpens the answer to the first.

Thanks for the early-send — you're right, this is a **third independent trigger path**, not in-scope for AGRUN-256 (workspace_publish_candidate gate, shipped) or AGRUN-263 (`read_only_planning` blind spot, open). Different module, different opt-out semantics, different fix shape. Tracking as **AGRUN-264**.

## Up front: your "one-fix-three-bugs" hypothesis — short answer is NO

Your reasoning was honest and worth taking seriously, so let us walk through why it doesn't hold, with a discriminator you can verify against the code.

**The two gates read different state.** `sourceMinimum.passed` is computed from `readSources.length` (the count of `read_url` artifacts) at [src/runtime/research-report-loop.js:121](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/research-report-loop.js#L121), not from `toolHistory`. `readSources` is populated only by successful `read_url` actions. A successful `execute_skill_tool` does not increment it.

Therefore:

- **After AGRUN-263 lands alone** (adds `tool_result` to productive dimensions): `read_only_planning_state` would clear because `execute_skill_tool` success becomes productive progress — but `sourceMinimum.passed` is still `false` (from the `createResearchReportLoopState()` default, OR from `0 < 3` if evaluation ever runs), so the terminal-repair source-deficit branch still fires. **Same `forbiddenDecisions:['finalize']` loop, reached through a different cycle path.**
- **After AGRUN-264 lands alone** (`enabled:false` actually disables source deficit): terminal-repair source-deficit correctly defers — but your planner's natural sequence `list_agent_skills → use_agent_skill → execute_skill_tool` is exactly 3 read-only-planning-classified actions, which trips `read_only_planning_state` activation at `TRANSITIONAL_ONLY_THRESHOLD=3`. **Same loop, different gate.**

The two gates are not in the same code path. They share no load-bearing predicate. **You need both fixes shipped to fully clear job e0f52c12's failure shape.**

This is the part we have to be explicit about because reading the two emails together, it would be reasonable to assume either fix unblocks you. It doesn't.

## Your cycle-7 finalize evidence strengthens — doesn't change — the AGRUN-264 diagnosis

The Debug Log timeline is exactly the failure shape AGRUN-264 predicts:

| Cycle | Event | What it proves |
|---|---|---|
| 6 | `execute_skill_tool` returns HTTP 200 with real ERP data | Tool data is sufficient — host did its job |
| 7 | Planner emits `finalize` with reason "tool output … provided the necessary aggregated sales invoice line data" | **Flash-Lite is competent here.** The model understood the data was enough and tried the right next move. |
| 7 (continued) | Framework rejects the finalize → terminal_repair source-deficit activates | This is where the bug bites. `runState.researchReportLoop.sourceMinimum.passed === false` (from the `createResearchReportLoopState()` default that `refreshResearchReportLoopGate` never overwrites because `enabled:false`). Terminal-repair builds `forbiddenDecisions:['finalize',...]` from `activeDeficits:['source']`. |
| 9 | Prompt prefix switches to `Focused research phase contract: research_phase_contract_focused` | Path 3 trigger — see "Open question on Path 3" below |
| 16+ | Prompt prefix becomes `Focused terminal repair contract: terminal_repair_hard_veto_focused` | Repeat-ignored-count threshold from `READ_ONLY_PLANNING_HARD_VETO_THRESHOLD=3` (we suspect — needs JSONL to confirm escalation source) |
| 17-20 | 6× finalize hard_veto → host circuit breaker | Cap reached |

Two things this rules out:

1. **"Flash-Lite ignored a hint."** Cycle 7's planner reason is grounded and correct. The model selected finalize for the right reason. The bug is in the framework's `enabled:false` semantics, not in the planner.
2. **"Maybe the planner hallucinated finalize from memory."** Cycle 7's reason quote ties the finalize choice to a specific cycle-6 tool output. Concrete causal chain.

This is the cleanest evidence we have for "the harness rejected a substantively-correct finalize." Thank you for pulling the planner reason verbatim — it's exactly the kind of report that lets us close the diagnostic loop without speculation.

## Direct answer: this is a regression in semantics, not by-design

You read the docs correctly. `researchReportLoop: { enabled: false }` was supposed to mean "no long-research gating." Six+ call sites in the runtime honor this contract by checking `loop.enabled === true` before applying long-research-specific behavior. The bug is that the **terminal-repair source-deficit block** is not one of those call sites, and the **initial state** that `createResearchReportLoopState()` ships with already trips the deficit.

## Call-chain trace (so you can verify against your JSONL)

We traced the path from `loop.enabled = false` config to `terminalRepairState.activeDeficits:['source']` in your job e0f52c12. Four moving parts:

**1. `createResearchReportLoopState()` poisons the default state.** [src/runtime/research-report-loop.js:62](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/research-report-loop.js#L62) initializes `runState.researchReportLoop.sourceMinimum` with:

```js
{
  minReadSources: 3,
  minRelevantSources: 2,
  passed: false,        // ← default false, not "no constraint declared"
  readSources: 0,
  relevantSources: 0
}
```

The intent was probably "this gets populated on first evaluation," but `passed: false` is the wrong sentinel — it should be `null` ("not evaluated, not applicable") or the whole `sourceMinimum` object should be `null` until populated.

**2. `refreshResearchReportLoopGate()` correctly honors `enabled:false` — and that's why the default state is never overwritten.** [src/runtime/research-report-loop.js:195-198](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/research-report-loop.js#L195):

```js
export function refreshResearchReportLoopGate(runState, configValue, context = {}) {
  if (!runState || typeof runState !== "object") return null;
  const config = normalizeResearchReportLoopConfig(configValue);
  if (config.enabled === false) return null;   // ← early return for ERP hosts
  ...
  const evaluation = evaluateResearchReportLoop(runState, config, context);
  ...
}
```

When `enabled:false`, this function returns `null` immediately. `evaluateResearchReportLoop` never runs. `runState.researchReportLoop.sourceMinimum` keeps its default `{ passed: false, minReadSources: 3, ... }` from step 1.

**3. `readSourceMinimum(runState)` returns the default state without checking `loop.enabled`.** [src/runtime/action-pattern-progress.js:227](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-pattern-progress.js#L227):

```js
export function readSourceMinimum(runState) {
  const packet = readAcceptancePacket(runState);
  if (packet && packet.evidence && packet.evidence.sourceMinimum) {
    return packet.evidence.sourceMinimum;
  }
  const loop = runState && runState.researchReportLoop && typeof runState.researchReportLoop === "object"
    ? runState.researchReportLoop
    : {};
  return loop.sourceMinimum && typeof loop.sourceMinimum === "object" ? loop.sourceMinimum : null;
  //     ↑ NO loop.enabled CHECK
}
```

This returns the poisoned default. The consumer can't tell whether `sourceMinimum.passed:false` means "we evaluated and it failed" or "we never evaluated because long-research is off."

**4. `terminal-repair-state.js` fires the source deficit from the poisoned default.** [src/runtime/terminal-repair-state.js:441-456](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/terminal-repair-state.js#L441):

```js
if (sourceMinimum && sourceMinimum.passed !== true) {
  const readSourceDeficit = Math.max(readNumber(sourceMinimum.minReadSources) - readNumber(sourceMinimum.readSources), 0);
  // = max(3 - 0, 0) = 3
  const relevantSourceDeficit = Math.max(readNumber(sourceMinimum.minRelevantSources) - readNumber(sourceMinimum.relevantSources), 0);
  // = max(2 - 0, 0) = 2
  if (readSourceDeficit > 0 || relevantSourceDeficit > 0) {
    deficits.push("source");                  // ← fires for every ERP host
    observableDeficits.source = { ... };
  }
}
```

The block has no `loop.enabled` check. Once the deficit goes into `activeDeficits`, `buildForbiddenDecisions()` (same file, ~line 155) adds `'finalize'` to forbidden decisions; `buildAllowedActions()` returns `['web_search', 'read_url', 'workspace_publish_candidate']` — all three of which are either in your `disabledActions` or gated by AGRUN-256 in non-long-research hosts. The planner is left with no legal terminal move. Hard_veto loop until circuit breaker / maxSteps.

That matches your job e0f52c12's cycle 17-20 dump exactly: `observableDeficits.source.successfulReadUrlCount: 0`, `readSourceDeficit: 3`, `relevantSourceDeficit: 2`, `forbiddenDecisions: ['ready', 'finalize', ...]`, `allowedActions: ['web_search', 'read_url', 'workspace_publish_candidate']`.

## On `researchCoverageGuard` and `citationCoverageGuard`

For completeness: you correctly disabled `researchCoverageGuard:{enabled:false}` and `citationCoverageGuard:{enabled:false}`. Those are **separate gates** living in their own modules ([src/runtime/research-coverage-guard.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/research-coverage-guard.js), [src/runtime/citation-source-coverage.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/citation-source-coverage.js)) and they correctly defer when disabled. They are not the source of this failure. The bug is specifically in the `researchReportLoop` initial-state / `sourceMinimum` path.

## Direct answers to your four questions

**Q1: Should `researchReportLoop:{enabled:false}` disable `terminalRepairState.observableDeficits.source`?**
**Yes, it should — and it currently doesn't because of the default-state poisoning + the missing `loop.enabled` check in `readSourceMinimum` and the terminal-repair source-deficit branch.** This is a regression in semantics, not by-design.

**Q2: AGRUN ticket / commit?**
Filed as **AGRUN-264** ([task.md](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/host-integrators/task.md), [task.jsonl](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/host-integrators/task.jsonl)). Fix not yet implemented — we want your JSONL first (see below) so the regression test mirrors your actual cycle 17-20 state exactly. We will not bundle this with AGRUN-256 (already shipped) or AGRUN-263 (open, different module).

**Q3: Recommended config for ERP-only hosts?**
**Honest answer: there is no clean knob today** that fully disables this. `researchReportLoop:{enabled:false}` should be sufficient — it isn't, because of the bug above. Two workarounds we don't recommend:

- (a) `researchReportLoop: { enabled: false, minReadSources: 0, minRelevantSources: 0 }`. This neutralizes the defaults via `normalizePositiveInteger` semantics — `readPositiveInteger(0) || DEFAULT_MIN_READ_SOURCES` will still return `DEFAULT_MIN_READ_SOURCES = 3` ([src/runtime/research-report-loop.js:57](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/research-report-loop.js#L57)), so this **does not work**. Listing it explicitly so you don't try it.
- (b) Host-side patch to nullify `runState.researchReportLoop.sourceMinimum` on each `onStep`. This works but it's the "extending disabledActions" anti-pattern from the other direction — host pokes runtime internal state to defeat a check, and the same bug fires next time you upgrade. **Do not ship this.**

The right fix is detector-side. We will ship it under AGRUN-264 once we have your JSONL.

**Q4: Host diagnostics gap (snapshot.runState.terminalRepairState empty while planner sees `activeDeficits:['source']`).**
Acknowledged closed by your follow-up — you verified `snapshot.runState.terminalRepairState` is intentionally a stripped view and that `loopState.terminalRepairState` in the planner request body is the complete state. Good catch on your side, and good harness-level pattern: when two views of "the same" state disagree, one of them is the canonical surface and we should document which. We'll add a note to `agrun_docs/feature-toggles.md` (or the inspector/diagnostics doc — whichever you prefer) making this explicit so the next host doesn't have to rediscover. **No further action required from you on Q4.**

## Open question on Path 3 (`research_phase_contract_focused` activation at cycle 9)

Your "one-fix-three-bugs" hope was that Path 3 shares the same `["workspace","source"]` whitelist. We are not yet sure it does, and we don't want to promise a fix without tracing it.

The gate that admits this prompt block is [src/runtime/planner-prompt.js:939-944](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner-prompt.js#L939) `isLongResearchPromptState(runState, researchReportLoop, searchResults)`. It returns true when any of:

```js
runState.researchActivation === "long_research"
||  isPromptResearchReportLoopActive(researchReportLoop)
||  selectedSkill === "long-web-research" || selectedSkill === "deep-research-writer"
```

For your config, our static read says none of these should hold. **So the fact that you observe the prompt prefix at cycle 9 means one of the following:**

1. `isPromptResearchReportLoopActive` returns true via a sub-condition we haven't traced (`loop.status !== "idle"`, `loop.acceptancePacket` populated, `loop.gateSignal` populated, `loop.evidenceGaps` populated, or `loop.recentSearches` populated — see [planner-prompt.js:971-986](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner-prompt.js#L971)). The first two SHOULD stay default for `enabled:false`, but a stale acceptancePacket from a thread-carried prior turn is the kind of thing that needs JSONL to rule out.
2. `runState.researchActivation` got set by something we haven't found (thread sync from a prior turn? research-thread-sync.js:133 writes it, so a multi-turn session carrying a research thread could explain it).
3. Your log dumps all candidate prompt-block strings (including non-active ones); the prefix is in the log but not actually injected into the planner request.

The right next step is to confirm against your JSONL which sub-condition activated. We are **not** scoping Path 3 into AGRUN-264 yet — could fold in if the JSONL shows shared root cause with the `sourceMinimum` default-state poisoning, could spawn AGRUN-265 if it's a different surface entirely. Promising too much before the trace is the AGRUN-256 mistake (we'd be the ones doing the "claim covers all three" thing now).

## What we'd like from you

Please send the JSONL you offered — 10 cycles × ~40KB, full `loopState.*` from your planner request body. The diagnostics we need to close are now narrower than before (Q4 is off the list); specifically:

1. **`runState.researchReportLoop.sourceMinimum`** at cycle 1 (before any planner activity) vs. cycle 17-20 (when the deficit fired). Confirms whether the failing state is the `createResearchReportLoopState()` default (our static-read prediction) or a stale evaluation from a prior turn that didn't get cleared.
2. **`runState.researchReportLoop.enabled` / `.status` / `.acceptancePacket` / `.gateSignal` / `.evidenceGaps` / `.recentSearches`** at cycle 1, 7 (first finalize attempt), and 9 (Path 3 prompt switch). Identifies which sub-condition activated Path 3.
3. **`runState.researchActivation`** at the same cycles, and **`runState.selectedSkill`** / **`runState.lastReadSkill`**. Identifies whether something set researchActivation to `"long_research"` despite your config.
4. **The cycle-7 planner request body in full** (the one where Flash-Lite emitted finalize with the quoted reason). The presence of `terminalRepairState.active === true` in that body's `loopState` is the load-bearing fact for AGRUN-264; if it's not active until cycle 8, the activation trigger is different from what our static read predicts and we need to revisit.

Email reply is fine — or paste a Gist link, whichever is easier.

## Honest caveats (HBR)

- **Static-read only.** We have not reproduced your failing job in the test suite. The unit test that lands with the AGRUN-264 fix should mirror your cycle 17-20 dump exactly, which is why the JSONL matters.
- **The AGRUN-264 fix touches a load-bearing predicate.** The right shape — modeled on AGRUN-256 — is a single `isLongResearchHarnessActive(runState)` helper that every `sourceMinimum` consumer honors. The helper already exists privately in [src/runtime/action-loop-action.js:1418](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-action.js#L1418); we need to export it (or a sibling) and have terminal-repair, plan-validation, and final-contract all use it. More files than a one-line guard, but a one-line guard would ship a half-fix that the next consumer reintroduces.
- **`createResearchReportLoopState()` default is independently wrong.** Even after the consumer helper lands, `sourceMinimum: { passed: false, minReadSources: 3, ... }` as a default is semantically misleading — `passed: false` should mean "evaluated and failed," not "never evaluated." We will change the default to `null` (or sentinel `{ passed: null }`) in the same patch as belt-and-braces defense.
- **AGRUN-263 and AGRUN-264 must ship together to unblock your job.** AGRUN-256 (already shipped, in the bundle you're waiting for) is independent — you can pick that up without waiting for the other two. But AGRUN-263 alone, or AGRUN-264 alone, will leave you with the same finalize-veto loop reached through a different gate. We will deliver them as two commits in one drop so you don't have to mentally track which version closes which gate.
- **Three Globe3 failures in one week is a pattern, not coincidence.** AGRUN-256, AGRUN-263, AGRUN-264 share a shape: opt-out flags whose `enabled:false` semantics is only partially implemented because the default-state or one downstream consumer doesn't honor the same predicate as the producer. After AGRUN-264 lands we will audit every `*Gate.enabled` / `*Loop.enabled` / `*Guard.enabled` flag for the same shape. Globe3 finding three of these in one week before we ran that audit is exactly why we want host-integrator feedback rather than just internal testing.

## Globe3 posture acknowledged

Your "no host-side workaround until we confirm direction" is correct and we appreciate it. The repeated lesson from this week is "every host-side band-aid opens a new runtime-side trigger path" — workarounds that paper over `enabled:false` semantics defeat the long-term contract Globe3 and other tool-loop hosts deserve.

The verbatim planner reason quote at cycle 7, the explicit "we are not adding any host-side workaround until you confirm direction" posture, and your self-resolution of Q4 by reading two state surfaces and naming the discrepancy yourself — all three are the kind of host-integrator collaboration that closes bugs in one round instead of five. Thank you.

— agrun.js team

(Ticket: AGRUN-264 — `researchReportLoop.enabled:false` does not disable terminal-repair source deficit; default-state poisoning + missing consumer guard.)
