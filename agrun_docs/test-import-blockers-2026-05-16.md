# Test Import Blocker - 2026-05-16

Status: resolved on 2026-05-25 by `AGRUN-TEST-IMPORT-SEAM`.

Command:
`node -e 'import("./src/index.js").then(m=>console.log(Object.keys(m)))'`

Original result after adding the `src/package.json` ESM boundary: the typeless-package warning is gone, but the import still fails before exports with:

```txt
Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received protocol 'virtual:'
```

Cause: `src/index.js` reaches `src/runtime/agent-skills.js` and `src/runtime/agent-roles.js`, which statically import Rollup-only `virtual:agrun-agent-skills` / `virtual:agrun-agent-roles`.

Decision at the time: not a sub-30-minute L1 fix. A real fix needed a
source-import seam or generated bundled-skill/role module plus regression
coverage. L1 stayed provider-seam only; follow-up `AGRUN-TEST-IMPORT-SEAM`
tracked replacing the fake action-loop fixture with real `createRuntime`.

Resolution on 2026-05-25:
- `src/runtime/agent-skills.js` and `src/runtime/agent-roles.js` now import
  Node-safe source fallback modules instead of Rollup-only `virtual:`
  specifiers.
- Rollup plugins still intercept those fallback module imports during
  dist/browser builds and emit the same bundled skill/role metadata.
- `node -e 'import("./src/index.js").then(...)'` now succeeds without a custom
  loader.
- `test/unit/mock-provider-plan-loop.test.js` now calls real `createRuntime`
  from source and no longer uses `applyOfflineActionEffect()`.
