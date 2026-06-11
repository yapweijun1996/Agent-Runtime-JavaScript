# AGRUN-TEST-IMPORT-SEAM - Source Import Seam

Date: 2026-05-25

## Scope

Close the stale source-import blocker so Node tests can import
`src/index.js` directly and exercise real `createRuntime` without the
Rollup/Vite `virtual:` module loader.

## Change

- `src/runtime/agent-skills.js` now imports `./agent-skills-bundle.js`
  instead of `virtual:agrun-agent-skills`.
- `src/runtime/agent-roles.js` now imports `./agent-roles-bundle.js`
  instead of `virtual:agrun-agent-roles`.
- The generated source fallback modules snapshot `skills/` and `roles/`
  metadata for direct Node source imports and Vite source-based examples.
- `npm run build:lib` regenerates the source fallback modules before Rollup.
- Rollup plugins still intercept those source fallback imports during
  browser/dist builds and emit the existing bundled skill/role modules.
- `test/unit/mock-provider-plan-loop.test.js` now imports `src/index.js`,
  creates a real runtime, and runs the offline search/plan convergence fixture
  through real `runtime.run()` instead of manually applying action effects.

## Verification

- `node -e 'import("./src/index.js").then(...)'` succeeds without
  `--import ./test/helpers/virtual-stubs-loader.mjs`.
- Source import exposes `createRuntime`, 5 bundled skills, and 5 bundled roles.
- `node test/unit/mock-provider-plan-loop.test.js` passes and activates
  `read_only_planning_active` by cycle 4 through real runtime steps.
- `npm run build:lib` passes and generated `dist/agrun.js` keeps bundled
  skills/roles working without including the Node source fallback modules.

## HBR

This closes the Node source-import blocker and removes the fake action-effect
path from the mock-provider plan-loop test. The source fallback files are
generated snapshots, so edits to `skills/` or `roles/` must regenerate them;
`npm run build:lib` now does that automatically. Dist/browser builds keep the
Rollup plugin path as the bundled-runtime SSOT.
