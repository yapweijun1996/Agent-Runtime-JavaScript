# AGRUN-248-B — Action Output Schema + Result Envelope SSOT Design

Date: 2026-05-24
Status: IMPLEMENTED; 2026-05-25 carry-over cleanup complete

Builds on:
- `agrun_docs/audits/sample-study-runtime-reverse-audit-2026-05-24.md` §3
- `agrun_docs/audits/agrun-248-a-workspace-candidate-lifecycle.md` (predecessor slice)
- MCP-KB `production-agent-harness-for-agrun-js` (618e5f0b) kbcid `agrun.runtime`

## 1. Project Goal restated

agrun.js is a browser-first general harness agent runtime. Runtime owns
**execution control, state, policy, events, evidence**; AI owns **planning,
quality judgment, final content**. AGRUN-248-B turns the action-result side of
that contract from informal `{ control, output:{ kind, ... } }` into a
**schema-driven SSOT envelope**, so Inspector / planner / observation pipelines
all read the same shape — no action-specific fallback parsers, no thrown
terminal failures for protocol bugs.

Naming note: existing browser-side
`examples/browser/src/runtime/oodae-packet-ledger.ts buildActionResultEnvelopes()`
(2026-05-10, KB item `5c2a4092-fe90-478f-af7c-a6b8767e35f4`) is a **projection
over runtime steps**, not the runtime contract. AGRUN-248-B adds the
**runtime-side normalized envelope** that the browser projection should then
read directly, removing the current ad-hoc fallbacks.

## 2. Current state (verified by source read 2026-05-24)

| Surface | File | Observation |
|---|---|---|
| Input schema | `action-registry.js:259-293` `cloneArgsSchema` + `action-args-validation.js` | Already SSOT — every action declares `argsSchema`. Validator returns recoverable observation, no throw. |
| Output contract | All `src/runtime/actions/*.js` | Each action returns `{ control, output:{ kind, ... }, summary }` ad-hoc. No `outputSchema` field on the action descriptor. |
| Common fields used downstream | `output.kind`, sometimes `output.ok`, `output.status`, `output.reason`, `output.count`, `output.items.length` | Not enforced; names drift. |
| Success path | `action-loop-action.js:364-610` | `action.execute(...)` → ad-hoc `actionExecutedDetail` extracts `query`/`resultCount` only for `web_search`. `handleActionResult` passes `output` raw. |
| Execute throw | `action-loop-action.js:611-660` `recordRecoverableActionError` | Writes `runState.observation = { actionName, kind:"error", message, stage }`. **No structured `output` envelope** flows. Guardrail refresher fakes one. |
| Guardrail block | `action-guardrail-controller.js:95-107` `createActionGuardrailSyntheticResult` | Returns `{ control:"continue", output:{ kind:"action_guardrail_block", ok:false, reason, status:"blocked" }, summary }`. The only place currently producing a structured non-success envelope. |
| Browser projection | `examples/browser/src/runtime/oodae-packet-ledger.ts:775-805` `buildActionResultEnvelope` | Reads from `step.detail` with multi-layer fallback: `detail.kind || detail.resultKind || 'n/a'`. Status inferred by `readActionEnvelopeStatus(type, detail)`. |

## 3. Decisions (user-confirmed 2026-05-24)

1. **Body validation scope: envelope only.** v1 schema enforces top-level
   envelope shape and `kind` string match against `outputSchema.kind`. The
   `body` object (= current `output` payload) is passed through unchanged.
   Body-shape validation is deferred to v2 if needed.
2. **Execute throw → envelope.** `catch` path produces a standard
   `createExecuteErrorEnvelope()` and flows through the same downstream as
   success. The hand-written `runState.observation = {kind:"error"}` in
   `recordRecoverableActionError` is replaced by an envelope-derived
   observation, eliminating the dual-path divergence.
3. **One PR, full migration.** Envelope landing and all ~25 built-in actions
   are converted in the same change. Strict mode is on from PR-1; there is no
   tolerant transition window. `assertActionOutputContract(actions)` enforces
   that every action either declares `outputSchema:{...}` or explicitly waives
   with `outputSchema: null` (the same contract style as
   `assertPlannerActionArgsContract`).

## 4. SSOT envelope shape (v1)

```js
{
  resultEnvelopeVersion: "v1",
  actionName: "web_search",
  control: "continue" | "stop",
  status:  "success" | "blocked" | "protocol_error",
  ok:      true | false,          // derived: status === "success"
  kind:    "web_search_result",   // must equal outputSchema.kind
  summary: "web_search(\"x\") -> 5 result(s)",
  reason:  null | "no_progress_block" | "envelope_missing_kind"
         | "envelope_kind_mismatch" | "envelope_control_mismatch"
         | "execute_threw" | ...,
  metrics: {
    resultCount: 5 | null,
    durationMs: 312
  },
  body: { /* original action output, untouched */ }
}
```

Rules:
- `body` is **opaque to runtime/Inspector**. All current planner-prompt,
  workspace-lifecycle, research, and inspector body-field accesses keep
  reading `envelope.body.<field>` (= old `actionResult.output.<field>`).
- `ok` is derived from `status` and not settable by actions.
- `metrics.resultCount` and `metrics.durationMs` replace the current
  `web_search`-specific extraction in `action-loop-action.js:393-394`.
- `kind` is **mandatory and validated**: envelope normalizer rejects any
  result whose body lacks `kind` or whose `kind` does not match
  `outputSchema.kind`.

## 5. Action metadata extension

```js
// added to each built-in action descriptor
outputSchema: {
  kind: "web_search_result",
  controls: ["continue"],           // permitted control values for this action
  metrics: { resultCount: "items.length" }   // declarative metric map (optional)
}
// or explicit waiver:
outputSchema: null
```

- `metrics` is a tiny key→path mapping. Normalizer reads it; actions don't
  push metrics themselves. If unset, `metrics.resultCount = null`.
- `assertActionOutputContract(actions)` runs at `createActionRegistry()`
  time, refuses to construct the registry if any action lacks
  `outputSchema` or `null` waiver.

## 6. New / changed files

| Path | Change | Purpose |
|---|---|---|
| `src/runtime/action-result-envelope.js` | new | `normalizeActionResultEnvelope({action, rawResult, durationMs})`; `createExecuteErrorEnvelope({action, error, durationMs})`; `createGuardrailBlockEnvelope({action, decision, durationMs})`; protocol-error helper. Pure functions, no runState. |
| `src/runtime/action-output-contract.js` | new | `assertActionOutputContract(actions)`. Style mirrors `action-args-validation.js`. |
| `src/runtime/action-registry.js` | edit | Wire `assertActionOutputContract`; expose `outputSchema` on planner/public projections (planner already sees `argsSchema`, so reading `outputSchema` keeps symmetry). |
| `src/runtime/actions/*.js` | edit (~25 files) | Each action descriptor gains `outputSchema:{kind, controls, metrics?}` (or `outputSchema:null` for `ask_clarification`-style waivers). No action body changes. |
| `src/runtime/action-loop-action.js` | edit | After `action.execute(...)`, call `normalizeActionResultEnvelope`. Replace inline `readActionQuery` / `readActionResultCount` with envelope fields. In `catch`, build `createExecuteErrorEnvelope` and route through the same downstream. Remove handwritten `runState.observation = {kind:"error"}` in `recordRecoverableActionError`; observation is derived from envelope. |
| `src/runtime/action-loop-action-result.js` | edit | `recordObservation` accepts envelope, stores `envelope.body` as the observation `output` (back-compat). |
| `src/runtime/action-guardrail-controller.js` | edit | `createActionGuardrailSyntheticResult` returns a v1 envelope directly. |
| `examples/browser/src/runtime/oodae-packet-ledger.ts` | edit | `buildActionResultEnvelope` reads `step.detail.envelope.*` (or the new flat fields it ships). Remove fallback chains for `kind`/`resultKind`/per-action `query`/`resultCount`. |
| `test/unit/action-result-envelope.test.js` | new | Success/continue, success/stop, invalid kind → protocol_error, control mismatch → protocol_error, missing kind, execute throw, guardrail block, approval-required (policy-blocked). |
| `test/unit/action-output-contract.test.js` | new | Every built-in action declares `outputSchema` (or explicit `null`). |

## 7. Acceptance (matches audit §3)

- [ ] Every built-in action has `outputSchema` or `outputSchema: null` (contract test enforces).
- [ ] Six envelope unit cases pass: success, continue, invalid args (already covered by `validateActionArgs`; envelope path is success), approval required, policy block, action execute error.
- [ ] Inspector `buildActionResultEnvelope` has zero `web_search`-specific fallback; row content is byte-identical to current output for an unchanged run.
- [ ] `npm test` / `npm run build` / `npm run dist:check` green.
- [ ] `npm run test:live:node-debug` baseline run: `recentActions` rows expose `resultEnvelopeVersion:"v1"` and no entry has `status:"protocol_error"`.

## 8. Out of scope (explicit)

- Per-action **body** schema validation. (v2 if needed.)
- Streaming sub-events from inside an action (`onStreamEvent`). That is
  AGRUN-248-C event ledger work.
- Planner-side repair contract for invalid envelopes. That is AGRUN-248-D.
- Changes to `argsSchema` / input validation.
- Any answer-quality, content-judgment, source-count, or length logic.

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| One-PR migration breaks runtime if an action's existing `output.kind` does not match a new declared `outputSchema.kind`. | Migration step: extract the **current** `kind` literal from each action source, declare it verbatim in the descriptor. Unit test enforces match by running each action against a recorded fixture. |
| Browser Inspector reads currently fall back on multiple field names; switching readers may hide pre-existing nulls. | Pre-change: capture a snapshot of a node-debug live run's `actionResultEnvelopes`; post-change: diff and require zero non-trivial diffs (only the new `resultEnvelopeVersion` field appears). |
| `recordRecoverableActionError` removal could change how the planner sees execute errors (different observation key). | Keep the observation’s public shape (`{ actionName, kind, message, stage }`) constant; derive it from envelope inside `recordObservation` so planner prompt input is unchanged. |
| `outputSchema.kind` literal becomes its own SSOT that can drift from action body. | The body MUST set the same `kind` literal — normalizer rejects mismatch. This is the protocol-error case in the test matrix. |

## 10. HBR (after design freeze, before code)

- No code changed. The decisions in §3 are user-confirmed but unvalidated by
  a real PR.
- Body opacity (v1) intentionally leaves per-action body schema drift
  uncaught. If a future Inspector view wants to depend on, e.g.,
  `body.items[*].url`, we accept that AI-first body remains free-form and
  Inspector must still parse defensively for body fields.
- AGRUN-246-J long-form quality is **not addressed** by this slice. Action
  envelopes are visibility/contract work, not content work.

## 11. 2026-05-25 carry-over cleanup

The original implementation shipped the v1 envelope path but left one
follow-up in `recordRecoverableActionError`: validation/preflight/execute
recoverable errors still handwrote `runState.observation`. That is now closed.

Implementation:
- `recordRecoverableActionError` builds a protocol-error envelope for
  validation/preflight failures and receives the existing
  `createExecuteErrorEnvelope()` result for execute throws.
- `envelopeToObservation(resultEnvelope)` is the only projection used for the
  AI-visible recoverable error observation.
- `envelopeToObservation` preserves `body.errorStage`, so validation,
  preflight, and execute remain visible as mechanical stages without a custom
  observation path.
- The repeated execute-failure summary is merged into the envelope summary
  before projection, so the planner still sees the stronger "failed again"
  recovery signal.

Verification:
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/action-result-envelope.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/recoverable-action-error-observation.test.js`
- `npm test`
- `npm run build`
- `npm run dist:check`
- `git diff --check`
- `task.jsonl` parse

HBR:
- No live browser/gateway QA was run for this cleanup because it is a
  mechanical projection refactor and does not change provider behavior or UI
  rendering.
