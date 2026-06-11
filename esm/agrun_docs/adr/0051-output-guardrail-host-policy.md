# ADR: Host-defined output guardrails (move publish/quality POLICY out of the runtime) (AGRUN-297)

Status: **Accepted — 2026-06-04. Slice 1 implemented** (host guardrail hook + config
plumbing). The fact-bundle consolidation (collapsing `explainTerminalRepairPublishArgs`
+ `requirementRecoveryEvaluator` + `researchAcceptanceEvaluator` into one SSOT object)
is deferred to a later slice — see Consequences.

## Implementation status (slice 1, this commit)

- `runtimeConfig.outputGuardrails: [{ name, execute }]` + `runtimeConfig.candidateQuality`
  now normalized in `config.js` (`normalizeOutputGuardrails` preserves `execute` by
  reference; `normalizeCandidateQuality` keeps `structureIssueSeverity`). **This also
  closes a gap from the AGRUN-297 severity PR**: `candidateQuality` was read in
  `candidate-quality-signal.js` but `normalizeRuntimeConfig` had stripped it, so the host
  override never reached production — now it does.
- Host guardrails run in `executeWorkspacePublishCandidateAction` (virtual-workspace-actions.js)
  as the LAST check after all built-in gates pass, before terminalizing. A `{block:true}`
  returns the existing `virtual_workspace_publish_blocked` non-terminal result (reason →
  AI's next cycle); a throwing guardrail is recorded (`output-guardrail-error` step) and
  treated as non-blocking; zero guardrails = unchanged behavior. Guardrails remain
  authoritative during `publishLoopEscape`: the escape valve can bypass stale
  protocol/readiness repair loops, but it cannot bypass host publish policy.
- Tests: `test/unit/workspace-actions.test.js` (block / pass / throw / none),
  `test/unit/runtime-config-lifecycle.test.js` (normalization preserves both fields).
- NOT yet done: the fact-bundle SSOT consolidation; the built-in sensors are still the
  inline gate (the host guardrail runs *in addition*, after them). Deferred deliberately
  to keep slice 1 additive and zero-regression.

## Context

- Investigating gemini-3.1-flash-lite long-research output quality surfaced a design
  question: *does the runtime hardcode quality rules?* Audit verdict (KB
  `agrun.runtime` item `candidate-quality-signal.js audit`, 2026-06-04):
  `candidate-quality-signal.js` is the legitimate **sensor** pattern — the runtime
  computes deterministic FACTS and exposes them as read-only `candidateQualitySignal`;
  the AI self-reviews and decides; the runtime never rewrites content and does not
  hard-block (empirically: a `status=blocked` candidate still published via the
  ADR-0048 escape valve). The one runtime **opinion** was the BLOCKING severity of
  cosmetic section-numbering issues — already made host-configurable in the AGRUN-297
  fix (`runtimeConfig.candidateQuality.structureIssueSeverity`).
- Two structural problems remain (found via Codeloom + KB):
  1. **Sprawl / no SSOT for "is this publishable?"** The judgment is spread across
     `candidate-quality-signal.js` (facts), `terminal-repair-state.js`
     `explainTerminalRepairPublishArgs` (~2569-line publish-arg validator),
     `action-loop-action.js` `maybeBlockTerminalRepairAction` (enforcement), plus
     `requirementRecoveryEvaluator` and `researchAcceptanceEvaluator`. Several modules
     each answer "publishable?" with overlapping logic.
  2. **The remaining policy still lives in the runtime.** Even after the severity
     config, the *set* of what blocks publish and *how* is runtime-owned. For a
     general-purpose harness library, output-acceptance policy belongs to the host.
- Prior art (KB, ADR-0030 draft 2026-05-16): a host publish hook
  (`onExhaustedBudgetPublish`) was **rejected as "externalizing push-mode"** — but that
  hook would have **authored / decided the terminal publish** on the AI's behalf. A
  *validation-only* guardrail (host vetoes; AI still authors) is a different thing; this
  ADR must keep that distinction explicit so it does not re-tread the rejection.
- Sample study (`sample project for study logic/openai-agents-js-0.11.5/packages/agents-core/src/guardrail.ts` + `runner/guardrails.ts`):
  the OpenAI Agents SDK solves exactly this with **mechanism/policy separation**:
  - `defineOutputGuardrail({ name, execute })` — the **host** writes `execute`.
  - `execute(args) -> GuardrailFunctionOutput { tripwireTriggered, outputInfo }`.
  - The runner runs all guardrails in parallel after final output; any
    `tripwireTriggered` → `OutputGuardrailTripwireTriggered` (halts the run).
  - The SDK holds **zero opinion** about what is valid output.
- Comparison (KB `opencode-vs-agrun`): opencode/codex have **no** output-structure gate
  at all (confirmed: opencode `src` has zero `quality`/`publish_candidate`/`guardrail`
  hits) — they trust the model / human review. agrun's gate is a differentiator and must
  NOT be deleted; the goal is to move its POLICY to the host, not remove the layer.

## Decision

Introduce an agrun-native **output guardrail** API modeled on the OpenAI Agents SDK
shape, adapted to agrun's iterative OODAE loop.

1. **Host registers guardrails** via runtime config:
   `runtimeConfig.outputGuardrails: [ { name, execute } ]` where
   `execute({ candidate, candidateQualitySignal, runState, finalReadiness }) ->
   { block: boolean, reason?: string, info?: any }`.
   (Mirrors `defineOutputGuardrail` / `GuardrailFunctionOutput`; `block` = the SDK's
   `tripwireTriggered`.)
2. **Runtime provides the mechanism, not the policy:**
   - Consolidate the publish-readiness FACTS into one bundle (the existing
     `candidateQualitySignal`, extended to carry the terminal-repair/recovery facts) —
     a single SSOT fact object, fixing the sprawl. The runtime computes facts only.
   - At the `workspace_publish_candidate` boundary (after
     `buildAndStoreCandidateQualitySignal`, before terminalizing), run the host
     guardrails over the fact bundle.
3. **Block ≠ halt (the key adaptation).** Unlike the SDK (one-shot, tripwire throws and
   halts), agrun loops: a guardrail `block` does **not** throw and does **not** author a
   fix. It surfaces `reason` as an observation to the AI's next OODAE cycle — exactly how
   `candidateQualitySignal` already reaches the planner. The AI repairs and re-publishes.
   This keeps the guardrail **validation-only**, which is what distinguishes it from the
   ADR-0030-rejected `onExhaustedBudgetPublish` (that authored the terminal publish =
   push-mode). The guardrail never writes content, never picks the candidate, never fills
   `remainingGaps`.
4. **Built-in sensors become the DEFAULT guardrail.** The current structure/citation/
   length checks ship as a default `outputGuardrail` whose policy is the
   `candidateQuality` config (severity map from the AGRUN-297 fix). Hosts can append,
   replace, or relax guardrails. With zero host guardrails configured, behavior is
   unchanged (the default = today's checks) → no regression.
5. **Escape valve cannot bypass host policy.** ADR-0048's budget-exhaustion publish path is
   orthogonal: it decides *terminate vs loop forever*, not *what is acceptable*. The escape
   valve may skip stale built-in protocol/readiness gates when hard-veto conditions prove
   the model is looping, but host output guardrails still run as the final publish policy.
   A blocking guardrail returns `output_guardrail_blocked` instead of shipping the artifact.

## Alternatives

1. **Delete the sensors (be like opencode/codex).** Rejected: regresses to "trust the
   model" — the model's word count "lied" (KB) and duplicate-heading output would ship
   silently. The gate is a differentiator.
2. **Keep all policy in the runtime, just expand the severity config.** Rejected as the
   end state: it leaves the runtime owning output-acceptance policy for every host; the
   AGRUN-297 severity config is a stopgap, not the architecture.
3. **Copy the SDK halt-on-tripwire semantics.** Rejected: agrun is an iterative loop;
   halting on block would abort the AI's self-repair. Block must become a re-plan signal.
4. **A host hook that decides/authors the publish (the ADR-0030 `onExhaustedBudgetPublish`
   shape).** Rejected again, for the same reason: that externalizes push-mode. This ADR's
   guardrail is validation-only and never authors — that is the whole point.

## Consequences

- Pros: output-acceptance policy moves to the host (no-hardcode / AI-first); the four
  sprawled publish-readiness sites collapse behind one fact bundle + one guardrail
  interface (SSOT); the design is grounded in a shipped reference (OpenAI Agents SDK);
  default behavior unchanged when no host guardrails are set.
- Cons / risk: consolidating `explainTerminalRepairPublishArgs` +
  `requirementRecoveryEvaluator` + `researchAcceptanceEvaluator` facts into one bundle is
  non-trivial refactor surface; must be staged so the terminal-repair validator behavior
  at the block boundary is preserved exactly (regression risk concentrated there).
- This ADR does NOT make weak models good editors by itself. It gives hosts an
  authoritative validation layer: if a model cannot repair a blocked candidate before
  budget exhaustion, a host guardrail can stop publish rather than labeling the artifact
  successful.

## Verification (planned — for the eventual implementation PR)

- Unit: default guardrail reproduces today's blocking/advisory codes; a host guardrail
  returning `{block:true,reason}` surfaces the reason as an observation and does NOT
  terminalize; with zero host guardrails, signal output is byte-identical to today.
- No-regress: existing `candidate-quality-signal.test.js`, `terminal-repair-state.test.js`,
  publish-protocol tests stay green.
- Gates: `npm run check` (build + dist:check + smoke) EXIT 0.
- Live: gemini-lite 3000-word run with a host guardrail that downgrades structure to
  advisory publishes without the structure block; with a strict host guardrail, the AI
  receives the block reason and re-publishes — multi-sample (lite is flaky).

## Rollback

- Remove the `outputGuardrails` config plumbing and the publish-boundary invocation; the
  default guardrail collapses back into the inline `candidateQualitySignal` checks. No
  data migration. Until implemented, this ADR is design-only and carries no runtime risk.
