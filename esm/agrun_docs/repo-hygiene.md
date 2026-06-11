# Repo Hygiene — Generated Artifacts and Reference Material

Policy for the large non-source directories in `0_development/`, so cleanup
decisions don't have to be re-derived each time. Audit origin: codebase review
2026-06-10 (2.2 GB `study-sources/`, 219 MB `agrun_debug_runs/`).

## Directory policy

| Directory | Git status | Policy |
|---|---|---|
| `study-sources/` | **Tracked by design** | External reference repos for harness study. The convention (commit as plain files, strip nested `.git`, never gitignore) is documented in [`study-sources/README.md`](https://github.com/yapweijun1996/agrun/blob/main/0_development/study-sources/README.md) — that file is the SSOT; do not gitignore this tree. |
| `agrun_debug_runs/` | Gitignored, local-only | Live-run debug traces (may contain real prompts/model output — never commit). Retention: keep any trace referenced by an **open** `task.jsonl` item (e.g. an active F-series investigation); everything else is safe to delete once the investigation that produced it is closed. |
| `output/` | Tracked | Evidence screenshots referenced by docs and the task board. Only add files that a doc or task entry actually cites. |
| `tmp/` | Gitignored (new files) | Scratch space — do not commit new files here. Two pre-existing tracked files stay because they are cited as evidence (`tmp/inspector-llm-trace-window-live.png` by `agrun_docs/live-tests/inspector-llm-trace-window-2026-05-10.md`, `tmp/workspace-publish-live-qa.mjs` by `task.jsonl`). New evidence belongs in `output/` or `agrun_docs/live-tests/`, not `tmp/`. |

## One-off cleanups applied (2026-06-10)

- `AGENTS_old.md` deleted — stale duplicate of `AGENTS.md`, referenced nowhere.
- `tmp/` added to `.gitignore` so future scratch files can't be committed by
  accident (the two tracked evidence files above are unaffected — gitignore
  only applies to untracked files).

## Rule of thumb

A file belongs in git only if something tracked points at it (source, doc,
task entry) or it *is* the pointer (README/index). Generated run artifacts are
local-only; reference material is tracked only under the documented
`study-sources/` convention.
