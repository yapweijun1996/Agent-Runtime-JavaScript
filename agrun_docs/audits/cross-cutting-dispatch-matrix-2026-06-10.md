# Cross-Cutting Mechanism × Dispatch Path Coverage Matrix — Audit 2026-06-10

## 30-second read: why this table exists

**一句话**：agrun 执行一个动作有**好几道门**（单动作执行、plan 批量执行、子 agent、审批续跑…）。一个安全机制（超时、预算、checkpoint…）很容易只装在**其中一道门**上，另几道门就裸奔——这张表就是确保每个安全机制都在**每一道门**上都装好了。

**打个比方——一栋楼有两个入口**。你在正门派了保安查证件，却忘了侧门也得派人。结果坏人从侧门大摇大摆走进来——证件检查"装了"，但只装了一半。

| | 没有这张表 | 有这张表 |
|---|---|---|
| 加一个新安全机制 | 装在正门（单动作路径），以为搞定了 | 对着表逐行核对：正门✅ 侧门✅ 子 agent✅ |
| 结果 | 侧门（plan 路径）静默裸奔，上线后才炸 | 每道门都查证件，上线前就堵住 |

**为什么非要一张表**：一天之内连续出了**两个一模一样的 bug**——`onCheckpoint` 只接了 `runtime.run` 忘了 `session.run`；超时只装了单动作路径忘了 plan 路径。同一类错误第二次出现，就不该再修第三个单点，而要把"所有机制 × 所有门"画成一张全景图，一次看全哪里漏了。**横轴 = 几道门（dispatch path），纵轴 = 几个安全机制（cross-cutting mechanism），每个格子 = 这道门上这个机制装了没有。** 空格子就是下一个 bug。

> 给未来加新功能的工程师：动了"动作怎么跑"或"run 选项怎么传"的代码，就回到本文 §5 的清单，对着每一道门核一遍——别假设"正门装了侧门自然就有"。

---

**Trigger:** Two same-class bugs in one day: (1) `onCheckpoint`/`resumeState` were wired into `runtime.run` but silently dropped by `session.run` (fixed `7a70eb94c`); (2) the single-step action timeout race existed on the single-action path but not the plan-mode parallel path (fixed `8278340c2`). Pattern: **a capability wired into one dispatch path is silently absent from the others.** This audit maps every cross-cutting mechanism against every dispatch path so the whole class is visible at once.

**Method:** 3 parallel exploration agents (execution-site census / per-action mechanism matrix / run-option threading matrix), every load-bearing claim then fact-checked by direct code read. Cells below marked ✅/❌ were verified by grep + read of the cited line; agent claims that failed fact-check are corrected here (notably the "approval missing in plan" risk rating).

---

## 1. Dispatch path inventory

| Path | Entry | Action execute() site |
|---|---|---|
| Single action (decision `action`) | `action-loop-session-loop.js` → `executeAction` | `action-loop-action.js:413` via `executeActionWithTimeout` |
| Plan batch (decision `plan`, parallel) | `action-loop-plan.js executePlan` → `runPlanActions` | `action-loop-plan-actions.js` via `executeActionWithTimeout` (since `8278340c2`) |
| Approval resume | `approval.js` (spread posture) → re-enters `executeAction` | single-action path (inherits its protections) |
| Subagent child | `spawn-subagent-capability.js` → nested `runLoop` | both paths inside the child loop |
| todo-autopilot | emits decisions only; executes via the two main paths (`applyTodoRunNextToRunState` is a sync pure mutation) | n/a |

## 2. Run-option threading × entry point (verified)

| Option/hook | runtime.run | session.run | approval resume | subagent child |
|---|---|---|---|---|
| onStep/onToken/onStreamEvent | ✅ | ✅ | ✅ (spread) | 🔒 stripped by design (event isolation, ADR-0037) |
| onPlannerDecision/onToolResult/onInvalidPlannerOutput/onBeforeFinalize | ✅ | ✅ | ✅ | 🔒 stripped by design |
| **onCheckpoint** | ✅ | ✅ (`7a70eb94c`) | ✅ | **❌→✅ FIXED this audit** — was leaked via spread; child envelopes would overwrite the parent's checkpoint in host storage |
| **resumeState** | ✅ | ✅ (`7a70eb94c`) | ✅ | **❌→✅ FIXED this audit** — was leaked; a resumed parent's worker would start from the parent's checkpointed runState (run-loop spreads options → `action-loop.js:7` converts resumeState→runState) |
| signal / abort | ✅ | ✅ | ✅ | ✅ callerAbortSignal inherited (parent stop cancels child) |
| plannerDirectives / plannerDirectivesMode | ✅ | ✅ | ✅ | ✅ inherited by design (host planner guidance applies to the worker; consistent with the inherited `runtimeConfig.plannerDirectives`) — triage comment added in the 2026-06-10 re-scan |
| maxSteps/maxCostUsd/runDeadlineMs/costPricing/historyCompaction | ✅ (runtimeConfig) | ✅ | ✅ | ✅ child runtimeConfig (maxSteps clamped) |

**Re-scan (2026-06-10, commit `d9fd4f598`):** cross-checked every current loop run-option (8 hooks + `disabledActions` + `resumeState` + `plannerDirectives`/`plannerDirectivesMode`) + `callerAbortSignal` against the subagent strip-list / `CHILD_PARENT_STATE_BLANKLIST`. **Blanklist is complete** — `resumeState`/`onCheckpoint` were the only real leaks (both fixed earlier this session). The one un-triaged pair (`plannerDirectives`/`plannerDirectivesMode`) is correct-to-inherit and now carries an explicit comment.

**Structural lesson (verbatim from `approval.js`):** an explicit allowlist of options is a maintenance trap — approval-resume switched to *spread + override* after dropping three new options in a row. `spawn-subagent` deliberately keeps spread + **blanklist**, which means **every new run option added to the loop MUST be triaged against `CHILD_PARENT_STATE_BLANKLIST` and the hook strip list** (this audit's two leaks were exactly the first new options added after that blanklist was written). Added to checklist §5.

## 3. Per-action mechanism × dispatch path (verified by grep over all three plan files)

| Mechanism | Single path | Plan path | Verdict |
|---|---|---|---|
| Single-step timeout race | ✅ `action-loop-action.js:413` | ✅ since `8278340c2` | parity |
| Approval gating (actionPolicy/tier) | ✅ runtime gate → pendingApproval | 🔒 **by design**: `validatePlan` rejects non-allow actions with structured feedback `action_policy_not_allow_in_plan` telling the planner to emit the gated action standalone (`action-loop-plan-validation.js:10`) | designed asymmetry, planner-recoverable — NOT a gap (agent's HIGH rating corrected) |
| Skill policy (deny/ask) | ✅ early+late in `execute-skill-tool-action.js` | ✅ at validation (`evaluateSkillPolicyForPlanAction`) | parity (different stage) |
| Args validation + alias rewrite | ✅ | ✅ | parity |
| Action-pattern convergence + terminal repair refresh | ✅ | ✅ (`refreshPlanActionPattern`) | parity — but see runtimeConfig note below |
| ↳ terminal-repair `runtimeConfig` (thresholds + allowedActions/requiredRepair) | ✅ `action-loop-action.js` | ✅ since AGRUN-460 (also preRequest + onResponse hooks) | parity — was a silent sub-gap: only the single-action door threaded `runtimeConfig` into `refreshTerminalRepairState`, so host-overridden `terminalRepair.thresholds.*` defaulted on the plan + both hook doors (`terminal-repair-runtimeconfig-parity.test.js`) |
| pendingApproval reset | ✅ | ✅ | parity |
| Execution error boundary (throw → recoverable observation) | ✅ `executeAction` try/catch → recordRecoverableActionError | ✅ since AGRUN-460-C3 (`executePlan` try/catch → `plan_execution_error`, AbortError re-thrown) | parity — plan path previously had no boundary; a post-execution throw escaped the non-awaited `try { return runActionLoop() }` in run-loop.js and rejected `runtime.run()` mid-mutation (`plan-execution-error-boundary.test.js`) |
| **Result envelope normalization** (`normalizeActionResultEnvelope`) | ✅ `action-loop-action.js:470` | ❌ raw `execution.rawResult` flows downstream | **GAP P2** — plan results skip the envelope SSOT; malformed control/kind pass unchecked |
| **Guardrail refresh** (`refreshActionGuardrail`) | ✅ success+error | ❌ zero hits | **GAP P2** — guardrail counters frozen during plan batches |
| **Repeat-action block** (`maybeBlockActionPatternRepeat`) | ✅ preflight | ❌ zero hits | **GAP P3** — duplicate-fingerprint actions can run in one batch (convergence still refreshes after, so cross-cycle repeats are caught) |
| **Session budget progress** (`markSessionProgress`/`markSessionFingerprintProgress`) | ✅ | ❌ zero hits | **GAP P2** — plan-heavy runs invisible to the no-progress counter |
| **Structured tool evidence** (`recordStructuredToolEvidence`) | ✅ | ❌ zero hits (toolContext history is recorded, evidence path is not) | **GAP P3** |
| **Closed-namespace gate** (ADR-0057 `deferredNamespaces`, AGRUN-565) | ✅ `action-loop-session-loop.js` beside the disabled-check, via shared `resolveClosedNamespaceForAction` | ✅ `action-loop-plan-validation.js` beside `isActionAvailable`, SAME predicate + code `action_namespace_closed` + word-for-word hint, before the policy hook | parity by construction (one shared module, `action-namespace-gate.js`) — see 2026-07-02 entry below for the subagent + prompt doors |

### 3b. Session-context preparation door (a THIRD door class)

`prepareProviderSessionContext` (`src/session/compaction.js`) runs **before** the runLoop and is the SSOT for LLM compaction. It has no `session.pushStep` — it returns structured data and the **two callers** translate it to `onStep`. So any compaction-side diagnostic is a two-door mechanism here too:

| Mechanism | Tool-loop door (`handle.js`) | Approval-resume door (`approval-resume.js`) | Verdict |
|---|---|---|---|
| `compaction-completed` step + cost accounting (from `compactionUsage`) + hidden-turn persistence (from `compactionTurn`) | ✅ `handle.js:~152` | ✅ since AGRUN-474 (`approval-resume.js` forwards `compactionUsage`/`compactionTurn` on all 3 compaction-running bags; the tool-loop door got these free via its full spread) | parity — was a silent asymmetry: an approval-resume compaction was un-accounted, un-persisted, and invisible (`compaction-approval-door-parity.test.js`) |
| **`compaction-failed` step** (from `compactionError`) | ✅ since AGRUN-461 (`handle.js`, symmetric with completed) | ✅ since AGRUN-461 (`approval-resume.js` forwards `compactionError` on all 3 compaction-running bags) | parity — catch was previously empty; an LLM/write failure was swallowed → unexplained `PROMPT_BUDGET_EXCEEDED` (`compaction-failure-surfaced.test.js`). AbortError re-thrown so cancellation still propagates. |

### 3c. Returned-result secret redaction (every echo surface is a door) — AGRUN-523

The runtime echoes host input back on several result surfaces; **each is a door that must scrub provider secrets.** AGRUN-515 closed `result.input` + `result.normalizedInput` but only ever whole-object secret-checked COMPLETED turns, so the **blocked/approval turn** stayed open: `createResumeRequest` snapshots the live provider request (apiKey included) into the resume token, which rides back on BOTH `result.output.pendingApproval.resumeToken.request.apiKey` AND `result.runState.pendingApproval.resumeToken.request.apiKey` (the latter cloned from the former) — plus a nested copy under `turnControl.pendingApproval…`.

| Returned surface | Redactor | Status |
|---|---|---|
| `result.input` / `result.normalizedInput` (completed + blocked) | `redactSecretFields` in `result.js` | ✅ AGRUN-515 |
| `result.output.pendingApproval.resumeToken` + `result.runState.pendingApproval.resumeToken` (blocked/approval) | `redactSecretFields` on the WHOLE token in `handlePolicyBlock` **before** the approval signer signs (sig covers redacted bytes → sign/verify still validates) | ✅ AGRUN-523 |

**Single chokepoint covers all paths:** `createPendingApproval` has exactly one caller (`handlePolicyBlock`), and both block sites in `action-loop-session-loop.js` (policy-hook + skill-policy) funnel through it — so single-action AND plan paths AND both run doors inherit the redaction for free. **Contract change:** the token no longer carries a usable key, so `restoreApprovalRequest` no longer falls back to the token's apiKey (it would be the literal `[redacted]`) — resume now REQUIRES the host to re-supply the credential via `overrides.apiKey` (the reference `examples/browser` approval-controller already does). `redactSecretFields` preserves nullish values so a server-auth `apiKey:null` stays null rather than becoming a fabricated `[redacted]`. Tests: `approval-result-secret-redaction.test.js` (both doors + resume re-supply + signer roundtrip); `research-flows.test.js`/`read-url.test.js` resume sites updated to re-supply.

## 4. Host-supplied code with no timeout (census)

The action-level race covers `tool.func` and custom `execute()` (they run inside it). Still unraced:

| Site | Risk | Note |
|---|---|---|
| output guardrail `guardrail.execute` (`virtual-workspace-actions.js:1642`) | a hung host guardrail hangs publish | precedent exists: `global-memory.js:286` already races its hooks |
| `onPlannerDecision` (`action-loop-session-loop.js`) / `onInvalidPlannerOutput` (`planner.js`) / `onCheckpoint` (sync call, but a returned hanging promise is not awaited — only a thrown error is caught) | host hook hangs block the loop outside action scope | host-owned code hanging is arguably the host's bug; runtime-side races are defense-in-depth → **GAP P3 (decide posture)** |

## 5. Standing checklist (add to every review touching run options or action dispatch)

1. New run option/hook? → wire **runtime.run AND session.run (handle.js builds its own bag)**; triage against `spawn-subagent` `CHILD_PARENT_STATE_BLANKLIST` + hook strip list; approval-resume inherits via spread automatically.
2. New per-action mechanism? → wire **single path AND plan path** (`action-loop-action.js` + `action-loop-plan-actions.js`/`-validation.js`); add a test on each path.
3. New host-callable code (hook/guardrail/tool)? → decide raced-or-not explicitly and write it down.
4. New session-context / compaction diagnostic? → it has NO `session.pushStep`; return it as structured data and wire BOTH session-prep doors (`handle.js` tool-loop + `approval-resume.js`). Re-throw `AbortError` so caller cancellation is never masked. (§3b)
5. New result surface that ECHOES host input (anything reachable from the returned `result`)? → run it through `redactSecretFields` and whole-object secret-check it on **completed AND blocked/approval** turns. The resume token is signed, so redact **before** signing. (§3c, AGRUN-523)

## 6. Disposition

- **Fixed in this audit:** subagent `onCheckpoint` + `resumeState` leak (`spawn-subagent-capability.js` strip list + blanklist; regression test 10b in `test/unit/spawn-subagent-capability.test.js`).
- **Fixed same-day (follow-up commits):**
  - Plan-path **envelope normalization + guardrail refresh (success AND failure) + session-budget progress marking** — `refreshActionGuardrail` moved to `action-guardrail-controller.js` and `markActionProgress` to `session-budget.js` as the shared homes; wired into `executePlanAction`/`applyActionSuccess`; `test/unit/plan-action-parity.test.js`.
  - **Host-hook timeout posture (§4) decided + implemented:** defense-in-depth, following the `global-memory.js` precedent. New `src/runtime/host-hook-timeout.js` races every awaited loop-scope host hook (`onPlannerDecision`, `onToolResult` both paths, `onInvalidPlannerOutput`, `onBeforeFinalize`) against `hostHookTimeoutMs` (new `createRuntime` config, default 10s); a hung hook degrades to "ignored". §4 risk table correction: `guardrail.execute` is now backstopped by the per-action race (it runs inside the publish action's `execute()`), and the non-awaited `onCheckpoint` cannot block by construction. `test/unit/host-hook-timeout.test.js`.
  - **Plan-path repeat-block + structured tool evidence** (last P3 row, `AGRUN-PLAN-REPEAT-EVIDENCE`): `recordStructuredToolEvidence` + `isHostCustomEvidenceAction` extracted to shared `action-evidence.js`; the plan path now records evidence for host custom evidence actions (gated by `evidencePolicy`), not just `execute_skill_tool`. `maybeBlockActionPatternRepeat` wired into `validatePlan` as a read-only preflight (sequential, race-free) — a plan containing a known-looping action is rejected with the block reason as planner feedback (code `action_pattern_blocked_in_plan`). Honest scope: the single path also refreshes the convergence ladder on a preflight block; the plan preflight does not mutate state at gate time because the executed-action convergence refresh (shipped above) already advances the ladder across cycles. Tests: `plan-action-parity.test.js` (evidence cases) + `plan-validation-recovery.test.js` (repeat-block case).
- **Fixed later (AGRUN-523):** blocked/approval-turn provider-secret leak on `result.output.pendingApproval` + `result.runState.pendingApproval` resume tokens — redact the whole token in `handlePolicyBlock` before signing; resume now requires host re-supply. §3c.
- **Matrix status:** all §3 per-action mechanism rows now at parity (single ⟷ plan); all §4 awaited host hooks raced. No open rows remain.
- **Explicitly NOT bugs:** approval-in-plan rejection (designed, planner-recoverable feedback); subagent per-event hook stripping (designed event isolation); error paths skipping the loop (no resume expected).

## 2026-06-12 — the rule is now CI-enforced (AGRUN-465)

`test/unit/dispatch-parity.test.js` turns the §2 standing checklist's run-option half into an executable invariant. It DERIVES the run-option key set from the SSOT itself (`default-run-options.js` `HOOK_KEYS` + `pickRunOptions`) — never from a list inside the test — then asserts every key is (a) forwarded in `runtime.run`'s runLoop bag, (b) forwarded in `session.run`'s bag (`session/handle.js`), and (c) at least *mentioned* (strip/override/inherit triage) in `spawn-subagent-capability.js`. Adding a new run option without wiring all three doors fails the suite with the missing door named. Boundary renames are declared in the test's `DOOR_KEY_ALIASES` (`abortSignal → callerAbortSignal`).

Writing the test immediately caught two live gaps (fixed in the same PR, each pinned by a behavioral case):
- **`session.run` dropped `onStreamEvent`** — runtime.run forwarded it; the session bag never did, so a session host's stream listener silently never fired. Now forwarded with the same abort wrapping as `onToken`.
- **`runtime.run` ignored `abortSignal`** — session.run resolved it to `callerAbortSignal` + abort-wrapped its hooks; runtime.run dropped the option entirely, so `runtime.run(input, { abortSignal })` was uncancellable. Now resolved through the new shared `readAbortSignal` SSOT in `abort-signal.js` (extracted from handle.js's local copy — fix shape "extract shared, import on both paths") with the same hook-wrapping set; `onCheckpoint` stays deliberately UNwrapped on both doors (crash-recovery persistence must fire while an abort unwinds).

The per-action mechanism half of the checklist (single ⟷ plan door) remains covered by the dedicated parity tests listed above (`plan-action-parity`, `terminal-repair-runtimeconfig-parity`, `compaction-approval-door-parity`).

## 2026-06-15 — AGRUN-517 `memoryExtractionPolicy` is single-door (decision recorded)

New host-callable hook `memoryExtractionPolicy` (gates the per-turn memory-extraction LLM call). Triaged against the doors per the standing checklist:
- **Door scope: SINGLE.** Memory extraction is a `session.run`-only mechanism — `runtime.run` never extracts (grep: no `extractMemoryEntries`/`extractSessionMemory*` under `src/runtime/`). So there is **no `runtime.run` parity to wire**. Both *session* entry points were covered: the option is threaded in `createSession` AND `openSession` (`runtime.js`), and read once in `createSessionHandle`; the policy is evaluated inside `applyTurnMemorySideEffects`, which both the sync and async (queue) extraction paths share — one implementation, both extraction paths.
- **Raced-or-not: NOT separately timeout-raced (deliberate).** The policy runs in the exact position of the extraction call it gates (awaited post-result on the sync path; inside the durable queue on the async path), and the gated extraction LLM call itself is not per-call raced there either — racing only the predicate would be inconsistent. Correctness is protected by **fail-open**: a throwing policy still extracts and the error surfaces in `getMemoryState().errors` (label `memory-policy`). A host that needs slow/async policy logic owns that latency, same posture as the §4 P3 host-hook decision.
- Not a run-option (it is a `createRuntime` capability like `asyncMemoryExtraction`), so the `dispatch-parity.test.js` run-option invariant does not apply; the single-door contract is pinned behaviorally by `test/unit/memory-extraction-policy.test.js`.

## 2026-07-02 — ADR-0057 Phase 1 `deferredNamespaces` closed-namespace gate (AGRUN-565)

New cross-cutting availability mechanism: `createRuntime({ deferredNamespaces: ["workspace"] })` closes a declared action namespace until the AI calls `open_action_namespace`. Triaged against every door per the standing checklist:

- **Both per-action doors wired via ONE shared predicate** (`src/runtime/action-namespace-gate.js` `resolveClosedNamespaceForAction`, the "extract shared, import on both paths" fix shape): single-action door in `action-loop-session-loop.js` (beside the disabled-action check; recoverable `action-namespace-closed` step + `action_namespace_closed` actionHistory observation, loop continues) and plan-batch door in `action-loop-plan-validation.js` (beside `isActionAvailable`, BEFORE the `runPreToolCall` policy hook — availability precedes permission; same code + word-for-word hint). One test per door in `test/unit/action-namespace-dispatch.test.js`.
- **Door reachability (verified)**: in envelope mode the planner-repair layer (`planner-repair.js normalizeActionName`) resolves names against the already-narrowed catalog, so closed emissions are intercepted upstream as `unknown_action_name` planner-invalid cycles (pre-existing treatment of every surface-hidden action). The door gates are the LIVE protection for decision sources that skip that normalization: **native-tools mode** (`parseToolCallDecision`/`normalizePlanToolActions` do no name-check — without the gates a closed action would execute), todo-autopilot synthesized decisions, approval-resume re-entry.
- **Not a run option** — a `createRuntime` capability like `memoryExtractionPolicy` (2026-06-15 entry), so the `dispatch-parity.test.js` run-option invariant does not apply; `runtime.run` and `session.run` both read the same normalized `resolvedConfig.runtimeConfig`, so both entry points inherit it by construction.
- **Subagent (third door) triage**: `deferredNamespaces` is DELIBERATELY inherited by the child via the `childRuntimeConfig` parent-config spread (host capability config, not parent run-state — comment recorded in `spawn-subagent-capability.js`). The parent's OPEN state (`runState.actionNamespaceContext`) does NOT leak: it rides `runState`, which `CHILD_PARENT_STATE_BLANKLIST` already blanks, so children start with all deferred namespaces closed — fresh discovery per ADR-0057 §4.
- **Prompt door**: the per-cycle catalog subtraction lives in `selectPlannerActions` (`planner-action-surface.js`), below the terminal-repair allowlist early-return; `planner-prompt.js` renders the one-line closed-namespace hint. §5 state-driven auto-open (terminal-repair contracts naming namespace members; evidence-convergence runs for `workspace`) is inside the shared predicate, so doors + prompt can never disagree.
