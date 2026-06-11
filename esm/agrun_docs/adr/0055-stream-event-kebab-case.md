# ADR: One kebab-case event vocabulary across step and stream surfaces

- Status: ACCEPTED (2026-06-10)
- Ticket: AGRUN-EVENT-NAMING-UNIFY

## Context

- agrun exposed two event taxonomies for the same concepts: `pushStep`
  (and the event ledger's `mode: "step"`) used kebab-case
  (`action-executed`), while `streamEmitter.emit` (`mode: "stream"`,
  `onStreamEvent`) used snake_case (`action_executed`,
  `provider_text_delta`, …). The same executed action surfaced under two
  spellings depending on which observer a host wired — a recurring trap for
  observability code (live-observe harness, Inspector, host dashboards),
  flagged again in the 2026-06-10 codebase review.
- Provenance is already carried by the ledger event `mode` field
  (`"step"` vs `"stream"`); encoding it a second time in the spelling is
  redundant and inconsistent.
- Affected contracts/docs: `onStreamEvent` (public-runtime-api.md),
  `subscribeEvents` ledger consumers, live-observe-harness.md, the browser
  Inspector (`oodae-packet-ledger.ts`), `.trace.v1.json` files persisted by
  CLI runs, and IndexedDB-persisted session messages from pre-rename runs.

## Decision

- All runtime event types use **kebab-case**, on both surfaces. Renamed
  stream types: `provider-stream-start`, `provider-text-delta`,
  `provider-stream-finish`, `provider-stream-error`, `action-executing`,
  `action-executed`, `action-error`, `tool-input-delta`, `tool-result`;
  unknown-type fallback `provider-stream-event`.
- The event `mode` field is the only discriminator between a step event and
  its stream twin. Writers emit kebab-case only — no dual emission.
- `classifyEvent` is now mode-aware: `mode: "stream"` events classify as
  `visibility: "debug"`, `phase: null` explicitly. This preserves prior
  behavior (snake_case names contained no `-` so they matched no
  visibility/phase rule and fell through to debug/null) and prevents stream
  twins from double-appearing in agent/user visibility filters next to
  their canonical step records.
- **Readers of persisted artifacts accept both spellings** (old sessions in
  IndexedDB, external `.trace.v1.json` files): `session-message-store.js`
  delta matcher and the Inspector's provider matchers/labels keep
  snake_case aliases. This is versioned-data tolerance, not dual naming.
- Out of scope (different taxonomies, names overlap by coincidence):
  result-envelope `kind` values (`action_error`, `action_execute_error`,
  `tool_result` in `productiveWhitelist`), cost-ledger `callKind`
  (`provider_stream`), and internal convergence trigger tokens
  (`planner_invalid_action`, `planner_repair_failed`). The
  `action_executed` trigger token was renamed to `action-executed` because
  it is literally derived from the event.

## Alternatives

1. Keep two taxonomies, document the convention (kebab=step, snake=stream).
   Rejected: provenance already lives in `mode`; every new host pays the
   same discovery cost; SSOT principle says one name per concept.
2. Emit both spellings during a deprecation window. Rejected: doubles event
   volume, pushes the breaking change to an undefined later date, and agrun
   is pre-npm-publish — all known hosts live in this repo.

## Consequences

- Pros: one greppable vocabulary; `onStreamEvent`/`subscribeEvents`
  consumers no longer need both spellings; classifier intent is explicit
  rather than a naming accident.
- Cons: BREAKING for any external host matching `action_executed` /
  `provider_text_delta` on the live stream. Migration: match kebab-case,
  or match both during transition (as `test/live/observer.mjs` already did).
- Risks: pre-rename persisted traces/sessions rendered by post-rename
  readers — mitigated by reader aliases (kept under test:
  `session-message-store.test.js` records one legacy-spelled delta).

## Rollback

- Revert the renames in `provider-stream-events.js` (normalizeType +
  `provider-text-delta` emit), `provider.js`, `action-loop-action.js`,
  `invalid-action-convergence.js`, and the mode-aware early return in
  `runtime-event-classifier.js`; revert doc/test updates. Reader aliases in
  the Inspector and session-message-store are tolerant of both spellings,
  so they need no rollback.
