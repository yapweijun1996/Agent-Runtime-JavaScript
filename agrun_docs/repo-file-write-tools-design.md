# Repo/File Write Tools Design

AGRUN-214j read-only repo tools are intentionally separate from future write
tools. Browser production must not gain filesystem mutation by default.

## Status

Design only. No runtime write action is exposed in this slice.

## Proposed Actions

- `repo_preview_patch`
  - Input: `{ path, find, replace }` or unified diff text.
  - Output: sanitized patch preview, affected path, changed line estimate.
  - Tier: `1` or `2` depending on host policy.
  - No file mutation.
- `repo_apply_patch`
  - Input: approved patch token or exact patch payload.
  - Output: apply status and changed file summaries.
  - Tier: `2`.
  - Must be `actionPolicy: "ask"` or stronger in production.

## Safety Contract

- Disabled unless the host injects a write adapter.
- Uses the same `rootDir`, `allowPaths`, and `denyPaths` policy as
  `repoFileTools`.
- Default denylist includes `.env*`, secret/credential files, private keys, and
  SSH identity filenames.
- Planner must preview before apply.
- Apply must require approval and must bind approval to the exact patch digest.
- Runtime/debug output must not include secret-like file contents or raw
  provider payloads.
- Browser hosts should prefer virtual workspace drafting; real writes belong to
  trusted Node/server hosts only.

## Harness

```text
planner -> repo_rg/repo_read_file -> workspace draft patch intent
        -> repo_preview_patch -> approval prompt with patch summary
        -> approved repo_apply_patch -> changed-file summary
```

The approval boundary is the mutation boundary. A denied approval leaves the
repo unchanged and the agent must answer with the preview and next manual step.
