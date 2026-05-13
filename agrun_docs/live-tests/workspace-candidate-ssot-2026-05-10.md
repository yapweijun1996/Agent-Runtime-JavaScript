# Workspace Candidate SSOT Fix — 2026-05-10

## Issue

`workspace_finalize_candidate(path)` accepted free-form workspace filenames, but
the virtual workspace quality state still treated `final_candidate.md` as the
only final candidate path.

Bad result:
- AI could write and finalize `answer.md`.
- The action looked valid.
- Later quality/readiness/debug views reported `final_candidate.md` missing or
  zero-length.
- The finalizer prompt could omit the selected candidate when workspace prompt
  projection kept only a limited window of files.

## Fix

- `workspace.quality.finalCandidatePath` is now the SSOT for selected final
  candidate path.
- `refreshWorkspaceQuality()` and `evaluateWorkspaceQuality()` evaluate the
  selected path, not a hardcoded `final_candidate.md`.
- `buildVirtualWorkspacePromptBlock()` always includes the selected final
  candidate when it has content, even if other workspace files are omitted by
  `maxFiles`.
- Readiness Packet reads the selected final candidate path from workspace
  quality.

## Harness Logic

Runtime still does not judge whether the answer is good enough. It only keeps
the AI-selected artifact path, stats, and content consistent so AI and Inspector
look at the same draft.

## Verification

Passed:

```bash
node test/unit/virtual-workspace.test.js
node test/unit/workspace-actions.test.js
npx tsx examples/browser/test/inspector-debug-report.smoke.ts
npm test
npm run build
npm run dist:check
git diff --check
```

Build warnings observed:
- Existing Rollup `this` rewrite warnings from dependencies.
- Existing Vite large chunk warning.

## HBR

This fixes candidate artifact consistency. It does not force the model to write
a better report, and it does not add runtime-owned length/source sufficiency
gates.
