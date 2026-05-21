# Test Import Blocker - 2026-05-16

Command:
`node -e 'import("./src/index.js").then(m=>console.log(Object.keys(m)))'`

Result after adding the `src/package.json` ESM boundary: the typeless-package warning is gone, but the import still fails before exports with:

```txt
Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received protocol 'virtual:'
```

Cause: `src/index.js` reaches `src/runtime/agent-skills.js` and `src/runtime/agent-roles.js`, which statically import Rollup-only `virtual:agrun-agent-skills` / `virtual:agrun-agent-roles`.

Decision: not a sub-30-minute L1 fix. A real fix needs a source-import seam or generated bundled-skill/role module plus regression coverage. L1 stays provider-seam only; follow-up `AGRUN-TEST-IMPORT-SEAM` tracks replacing the fake action-loop fixture with real `createRuntime`.
