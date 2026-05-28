# AGRUN-274 Release/Export Audit — 2026-05-27

## Scope

Confirm Set A public exports are gone after AGRUN-274e and that follow-up
cleanup from AGRUN-274b-3 / AGRUN-274c leaves no release blocker.

Deleted Set A names:

- `echoSkill`
- `fallbackSkill`
- `memorySkill`
- `newsBriefSkill`
- `timeSkill`
- `webSearchSkill`

Provider adapters kept:

- `openaiBrowserSkill`
- `geminiBrowserSkill`

## Findings

| Surface | Result |
|---|---|
| `src/index.js` | No deleted Set A exports. Provider adapters remain exported. |
| `dist/agrun.js` | No deleted Set A exports. Provider adapters remain exported. |
| `package.json#main` | Points at `dist/agrun.js`, so the release entry inherits the clean dist export surface. |
| Remaining `.mjs` live tests | AGRUN-274b-3 migrated them to the supported dist/source import helper path. |
| Browser example runtime | AGRUN-274c guard confirms `examples/browser/src/runtime/agent.ts` has no deleted Set A references. |
| Current onboarding/API docs | Updated to describe provider adapters, runtime-owned actions, `customActions`, and `agentSkills` instead of deleted Set A imports. |

Allowed residual references:

- AGRUN-274h deleted `test/helpers/legacy-set-a-skills.js`; tests must not
  import it. `test/unit/no-legacy-set-a-helper-regrowth.test.js` enforces this.
- AGRUN-274i removed remaining active example/test wiring from Long Task Lab,
  HTML role loader, and `test/live-streaming-test.js`.
- ADRs, release notes, archives, and audits may mention Set A names as
  historical migration context.
- `fallbackSkill: null` in runtime config/OODAE debug projections is a
  compatibility/null field, not an importable skill or fallback behavior.

## Regression Guard

`test/unit/no-set-a-public-exports.test.js` imports both `src/index.js` and
`dist/agrun.js`, asserts the six deleted Set A names are absent, and asserts the
two provider adapter exports remain available.

## Verification

Required gate:

```bash
node test/unit/no-set-a-public-exports.test.js
npm test
npm run build
npm run dist:check
git diff --check
```

Release/export audit status: PASS. AGRUN-274 public export deletion has no
remaining live-test, browser-agent, or current-doc blocker.
