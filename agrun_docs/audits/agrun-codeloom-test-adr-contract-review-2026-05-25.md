# AGRUN-CODELOOM-TEST-ADR-CONTRACT-REVIEW - Current Review

Date: 2026-05-25

## Scope

Close the stale `task.jsonl` todo for the two Codeloom-surfaced files from
2026-05-17:

- `src/runtime/before-finalize-veto-detail.js`
- `src/runtime/improvement-reflection.js`

## Findings

### before-finalize-veto-detail

Decision: already moved to test support.

Current evidence:
- `src/runtime/before-finalize-veto-detail.js` is absent.
- `test/helpers/before-finalize-veto-detail.mjs` exists and exports
  `buildBeforeFinalizeVetoStepDetail()`.
- `test/unit/todo-autopilot.test.js` imports the helper through a dynamic
  `path.resolve()` ESM import.
- `agrun_docs/adr/0010-todo-state.md` documents the helper path and why the
  event-shape tests avoid importing the full action-loop graph.

### improvement-reflection

Decision: keep in `src/runtime/`.

Current evidence:
- `src/runtime/improvement-reflection.js` exports the standing AGRUN-210 Phase C
  reflection contract: `REFLECTION_RULE_IDS`, rule functions, `normalizeDiff()`,
  and `composeReflection()`.
- `test/unit/improvement-reflection.test.js`,
  `test/unit/improvement-fixtures.test.js`, and
  `test/unit/improvement-long-running.test.js` import it through dynamic ESM
  paths and verify the contract.
- `agrun_docs/adr/0011-improvement-harness.md` lists it as the Phase C module
  and explicitly rejects parser-coupled reflection.

## Verification

- `test ! -e src/runtime/before-finalize-veto-detail.js`
- `test -e test/helpers/before-finalize-veto-detail.mjs`
- `rg` over source, tests, docs, build, package, and examples for basenames,
  exported symbols, ADR references, and smoke requires.
- Focused tests:
  - `node test/unit/todo-autopilot.test.js`
  - `node test/unit/improvement-reflection.test.js`
  - `node test/unit/improvement-fixtures.test.js`
  - `node test/unit/improvement-long-running.test.js`

## HBR

No code deletion or movement is needed in this slice; the product decision was
already implemented and archived, while `task.jsonl` still showed the item as
todo. Codeloom remains a structural signal only: dynamic `path.resolve()` ESM
imports can make active test/ADR contract files look unused, so local `rg`,
source reads, tests, and ADRs are the authority for this class of review.
