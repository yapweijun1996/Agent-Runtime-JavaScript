# Codeloom index scope recovery — 2026-05-16

## Goal

Recover local Codeloom MCP health for the agrun workspace by narrowing the
indexed file set without changing agrun runtime behavior.

## Baseline failure

- `codex mcp get codeloom` showed Codeloom configured at
  `http://127.0.0.1:6650/mcp`.
- Current Codex session exposed no native `mcp__codeloom` tools:
  `list_mcp_resources=[]`, `list_mcp_resource_templates=[]`.
- `curl http://127.0.0.1:6650/health` timed out.
- Direct `/mcp` initialize timed out.
- Docker health state was `unhealthy` with a failing streak above 300 and
  repeated `Health check exceeded timeout (5s)`.
- `docker stats --no-stream codeloom` showed about `7.118GiB / 7.654GiB`
  memory and `3845` PIDs.
- Logs showed repeated auto-reindex runs for agrun around
  `23166 files / 192k nodes`.

## Root cause

Codeloom was configured with `WORKSPACE_DIR=/Users/yapweijun/Documents/GitHub`
and the agrun repo had no `.codeloomignore`. The repo contains a large
reference corpus under `sample project for study logic/` with about 48,400
files. That corpus is not agrun runtime source, but it was eligible for
Codeloom indexing and watcher work.

## Change

Added project-level `.codeloomignore` to exclude:

- `sample project for study logic/`
- `output/`
- `tmp/`
- `agrun_debug_runs/`
- `.claude/`

Approximate focused file count after excluding `sample project for study logic/`
and generated/debug directories: about `9,962` files instead of `58,431`
non-`node_modules`/non-`dist` files.

## Verification

Completed after Codeloom restart/reindex:

- `/health` returned immediately with `status:"ok"`.
- Direct `/mcp` initialize returned a valid session instead of timing out.
- Docker health returned `Up ... (healthy)`.
- Container resource pressure dropped from about `7.118GiB / 7.654GiB`,
  `3845` PIDs to about `687MiB / 7.654GiB`, `19` PIDs.
- First `index_repo` applied the new walker scope but left stale pre-existing
  sample-corpus nodes/errors in the DB. HBR captured: Codeloom `index_repo`
  alone did not purge old out-of-scope graph rows.
- Clean recovery used Codeloom `delete_repo({ name:"agrun" })` to remove only
  the stale graph data, then `index_repo({ path:"/workspace/agrun/0_development",
  repo_name:"agrun" })` to rebuild.
- Clean rebuild result: `filesTotal=564`, `filesIndexed=564`,
  `filesFailed=0`, `filesWithSyntaxErrors=2`, `nodesInserted=6036`,
  `edgesInserted=15544`, `total_ms=1832`.
- Final `get_status(repo:"agrun")`: `root_path_status:"ok"`,
  `auto_reindex_status:"ok"`, `nodes_count=6036`, `edges_count=15544`,
  `errors_count=2`.
- Final `search_code(repo:"agrun", query:"workspace_publish_candidate")`
  returned current runtime files under `src/runtime/...`, confirming graph
  queries work again.

## HBR

At baseline, Codeloom MCP was not usable for code graph queries from this
session. After backend recovery, direct MCP calls work, but the current Codex
session still has `list_mcp_resources=[]`; native `mcp__codeloom` tool exposure
may require a new Codex session even though the backend itself is healthy.
