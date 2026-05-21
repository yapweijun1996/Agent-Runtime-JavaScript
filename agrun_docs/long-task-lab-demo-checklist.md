# Long Task Lab Demo Checklist

## Goal

Use this checklist before showing Long Task Lab to an end user. The demo should
prove that agrun.js can run a complex browser-first long task, expose progress,
save a replayable record, export/import JSONL, and keep debugging evidence easy
to inspect.

## One-command Records Demo

Run:

```bash
npm run demo:long-task-lab:records
```

What it does:

- Starts the Long Task Lab dev server with local env auto-seeding.
- Starts a clean headless Chrome profile through CDP.
- Configures OpenAI, maxSteps 60, auto-approve tier 1, web search, and read_url.
- Imports a deterministic demo JSONL fixture that follows the Long Task Lab
  record schema and includes a readable Final Report.
- Opens Records, reads the latest selected run from IndexedDB, writes a local
  `record.jsonl` inside the temporary Chrome profile, clears local records, then
  imports the JSONL file back through the Records UI file input.
- Fails if the selected record has no events, if export/import loses data, or if
  the restored record has no readable Final Report.

Optional:

```bash
npm run demo:long-task-lab:records -- --live-run
```

Use `--live-run` for a real OpenAI provider mission. Live provider runs are
intentionally nondeterministic and can exceed a quick demo timeout, so the
default command is the stable Records harness and live provider E2E is recorded
separately.

## Manual Demo Flow

Preflight:

- API keys come from `.env.local` or exported environment variables.
- Do not paste keys into docs, task logs, KB, screenshots, or raw DevTools
  request dumps.
- Provider is OpenAI unless the goal is specifically Gemini regression testing.
- Auto-approve tier 1 is enabled only for demo-safe `web_search` and `read_url`.
- Web search and read_url endpoints are configured.

Live task:

- Choose or paste a mission prompt that asks for a real deliverable.
- Start the run.
- Watch Mission Control for cycles, latest action, evidence, workspace status,
  and terminal source.
- The pass state is `Final artifact ready`.
- `Run needs attention` is a real HBR and must be investigated.

Records:

- Open Records after completion.
- Open the latest run.
- Confirm Final Report is readable in Markdown and Raw.
- Confirm Record Log can filter by event type.
- Export selected `record.jsonl`.
- Clear records only when no run is active.
- Import `record.jsonl`.
- Confirm the same run and final report are restored.

PWA/build:

- Production build must pass.
- Lighthouse production preview should have no failed audits.
- Service worker should control production preview.
- Offline shell should be reachable.
- Browser console should not have blocking uncaught exceptions.

## Verification Commands

```bash
npm run test:long-task-lab
npm --prefix examples/long-task-lab run build
npm run dist
git diff --check
```

## HBR Rules

- If OpenAI/Gemini provider calls fail, classify provider/network vs runtime
  separately.
- If a run completes but Records cannot read the final report, it is a blocking
  demo issue.
- If export/import restores events but loses full artifact content, it is a
  blocking record schema issue.
- If Lighthouse fails only on crawler metadata, fix the PWA shell before demo.
- If DevTools raw request inspection reveals Authorization headers, discard the
  raw dump and use sanitized app/debug evidence instead.
