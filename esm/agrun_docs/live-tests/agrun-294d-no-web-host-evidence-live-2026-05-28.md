# AGRUN-294D No-web Host Evidence Live E2E

Date: 2026-05-28

## Goal

Verify real planner behavior for a host-owned evidence profile: the host exposes
one generic `host_data_query` customAction, disables `web_search` and `read_url`,
and expects the runtime to publish from structured host evidence without web
source assumptions.

## Live Matrix

| Provider | Model | Effort / thinking | Status | Action sequence | No web actions | successfulEvidenceCount | successfulReadUrlCount | Event sequence |
|---|---|---:|---|---|---:|---:|---:|---|
| OpenAI | `gpt-5-mini` | `reasoningEffort=high` | PASS | `host_data_query -> workspace_write -> workspace_read -> workspace_finalize_candidate -> workspace_publish_candidate` | true | 1 | 0 | monotonic 1..135 |
| Gemini | `gemini-3.1-flash-lite` | `thinkingLevel=high` | PASS | `host_data_query -> workspace_write -> workspace_read -> workspace_finalize_candidate -> workspace_publish_candidate` | true | 1 | 0 | monotonic 1..135 |

## Commands

```bash
node --check test/node-host-evidence-live.mjs
node test/concerns/host-evidence-policy.test.js
NODE_AGRUN_LIVE_PROVIDER=openai NODE_AGRUN_LIVE_REASONING_EFFORT=high node test/node-host-evidence-live.mjs --provider openai --reasoning-effort high
NODE_AGRUN_LIVE_PROVIDER=gemini NODE_AGRUN_GEMINI_THINKING_LEVEL=high node test/node-host-evidence-live.mjs --provider gemini --gemini-thinking-level high
```

## Review Artifacts

These files are under ignored `agrun_debug_runs/` so they are not committed:

- OpenAI: `agrun_debug_runs/2026-05-28T08-16-40-485Z-host-evidence-openai.md`
- OpenAI JSON: `agrun_debug_runs/2026-05-28T08-16-40-485Z-host-evidence-openai.json`
- Gemini: `agrun_debug_runs/2026-05-28T08-24-13-388Z-host-evidence-gemini.md`
- Gemini JSON: `agrun_debug_runs/2026-05-28T08-24-13-388Z-host-evidence-gemini.json`

## Output Quality Check

Both outputs were short operational reports grounded in the host fixture records:
`CASE-1001`, `CASE-1002`, and `Acme Logistics`. Neither output cited or implied
web evidence. Both included `HOST_EVIDENCE_LIVE_DONE`.

The test does not score prose style. It checks harness behavior: real model
planning, host action usage, no web actions, workspace publish path, generic
evidence count, legacy read-url count staying zero, and monotonic runtime events.

## HBR

This is a live verification harness, not a runtime behavior change. The host
fixture data is test-owned; agrun core remains host-agnostic and does not learn
ORM, database, or project-specific semantics.
