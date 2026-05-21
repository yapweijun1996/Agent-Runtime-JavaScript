# Long Task Lab OpenAI Auto-Approve E2E — 2026-05-17

## Scope

Run the Long Task Lab MVP through a real OpenAI provider path with
auto-approve enabled. The goal was to verify whether a source-heavy
long-running mission can complete while showing useful Mission Control,
Evidence, Workspace, Debug Packet, IndexedDB, and browser diagnostic signals.

## Environment

- App: `examples/long-task-lab`
- URL: `http://localhost:3002/`
- Provider/model: OpenAI / `gpt-5.4-mini`
- Auto-approve tier 1: enabled
- Max steps: `30`
- Web search endpoint: configured from local dev settings
- Read URL endpoint/key: configured from local dev settings
- Browser tool: Chrome DevTools MCP

Secrets were not copied into this document. Chrome-side inspection confirmed
that the Debug Packet redaction removed key-like values, but localStorage still
stored provider and service keys as part of saved settings. That is a security
and UX issue for the demo host.

## Commands

```bash
npm run test:long-task-lab
npm run build:long-task-lab
npm --prefix examples/long-task-lab run dev
```

Results:

- `npm run test:long-task-lab` passed.
- `npm run build:long-task-lab` passed.
- Build warning: Vite reported the Long Task Lab bundle is larger than 500 kB.
- Dev server started on `http://localhost:3002/` because port 3001 was already
  in use.

## User Flow

Initial setup rendered correctly:

- Provider/model/key controls were visible.
- Web search endpoint and Read URL endpoint were prefilled from local settings.
- Read URL API key was not visible as a user-editable field.
- Mission Control, Timeline, Final Artifact, Evidence, Workspace, and Debug
  surfaces rendered.

Attempted prompt override:

- Chrome DevTools `fill_form` visually changed the Mission prompt.
- After clicking Start, the app ran the preset's default Market Research prompt
  instead of the visually edited prompt.
- This means browser automation must use a real React-safe input path; DOM-fill
  style testing can produce false confidence.

Actual prompt used:

```text
Create a concise market research memo about browser-first AI agent runtimes for SaaS product teams.
Use web_search and read_url for direct evidence.
Track the work with TodoState, draft in the virtual workspace, and publish a clean final memo with links.
Include: market signal, buyer needs, competitive patterns, risks, and a recommendation.
```

## Outcome

The run failed by step budget:

- UI status: `failed`
- Error: `MAX_STEPS_EXCEEDED`
- Message: `Action loop exceeded maxSteps without reaching a terminal output.`
- Latest action: `workspace_publish_candidate`
- Runtime cycle count: `30`
- Mission Control displayed `693 / 30`, which is event/timeline count rather
  than user-meaningful cycle count.

Evidence was gathered:

- Search queries: 1
- Search results: 5
- Read sources: 4
- Strong sources: 2
- Usable sources: 2
- Duplicate read sources appeared for the same URLs.

Workspace / terminal repair:

- `terminalRepairState.active=true`
- Active deficits: `readiness`, `terminal_loop`
- Terminal repair budget: exhausted
- Repeated semantic terminal pattern: `workspace_publish_candidate`
- Action-pattern convergence reported repeated terminal publish attempts
  without observable progress.
- The convergence progress snapshot showed a ready workspace candidate
  (`final_candidate.md`, about 456 words / 3297 chars), but the Long Task Lab
  Workspace panel summarized no candidate/files. The demo UI is losing useful
  workspace facts from the runtime state.

## Debug And Inspection

Debug Packet:

- Copyable packet rendered.
- Packet length was about 278 kB, which is too large for easy support sharing.
- No OpenAI/Gemini/Bearer key literal pattern was detected in the packet.
- The packet exposed terminal repair and action-pattern convergence facts well
  enough to diagnose the failed run.

Console:

- Initial non-blocking dev messages: Vite connect, React DevTools suggestion,
  favicon 404, form accessibility issues.
- Repeated React errors occurred for duplicate children keys in Evidence and
  Timeline rendering:
  - Duplicate source keys for repeated read URLs/titles.
  - Duplicate timeline ids such as repeated `terminal-repair-state-refreshed`
    events.

Network:

- OpenAI Responses API requests returned 200.
- Search request returned 200.
- Read URL service requests returned 200.
- Failure was not caused by network or provider HTTP errors.

IndexedDB / history:

- IndexedDB database existed: `agrun-long-task-lab-session-store`.
- Stores existed: `globalMemory`, `memoryEntries`, `messages`, `sessions`,
  `summaries`.
- After the failed run:
  - `sessions`: 1
  - `messages`: 2
- After page reload, the app returned to idle and did not auto-load the latest
  run into the UI. The historical session remained in IndexedDB but was not
  visible to the user.

localStorage:

- `agrun-long-task-lab-settings-v1` persisted local settings.
- The stored settings included key-like values. This should be changed before
  presenting the demo as customer-safe.

## Findings

1. **P1 — Real OpenAI auto-approved source-heavy mission failed by max steps.**
   The runtime gathered evidence and drafted a candidate, but the model repeated
   terminal publish attempts until `MAX_STEPS_EXCEEDED`.

2. **P1 — Long Task Lab persists secrets in localStorage settings.**
   Debug Packet redaction works, but localStorage still stores key-like values.
   This is not safe for a customer-facing demo.

3. **P1 — No visible history restore.**
   IndexedDB keeps the session/messages, but page reload returns the UI to idle
   with no visible latest run/history record.

4. **P2 — Workspace panel loses useful runtime candidate facts.**
   Runtime convergence facts showed a final candidate, but the UI Workspace
   summary showed no candidate/files.

5. **P2 — Duplicate React keys during repeated evidence/timeline updates.**
   Duplicate read URLs and repeated step ids generated repeated React console
   errors.

6. **P2 — Mission Control step count is misleading.**
   It displayed event count `693 / 30` instead of a clean cycle/budget meter.

7. **P2 — Prompt automation can visually edit without updating React state.**
   DevTools `fill_form` showed a new prompt in the textarea, but Start used the
   preset prompt. E2E automation must use a React-safe input path.

8. **P3 — Form accessibility issues.**
   DevTools reported missing labels/id/name attributes for some controls.

## HBR

This live E2E did not pass. It is valuable because it proved the Long Task Lab
can expose the failure reason, evidence state, terminal repair state,
convergence state, and persisted session data. It also proved the demo is not
yet ready as an end-user showcase for source-heavy long tasks.

## Recommended Fix Order

1. Stop persisting API keys in localStorage; keep only non-secret settings or
   use session-only / explicit local-dev seed behavior.
2. Add visible run history restore from IndexedDB, at minimum "latest run"
   with status, final/error, evidence counts, and debug packet.
3. Fix Mission Control budget display to show cycle/runtime step count, not
   raw event count.
4. Deduplicate Evidence sources and generate stable unique timeline keys.
5. Improve Workspace summarizer so it can surface candidate stats from the
   available runtime/convergence facts when full virtualWorkspace is absent.
6. Tune the terminal publish path so repeated `workspace_publish_candidate`
   with a ready candidate can either finalize cleanly or fail earlier with a
   clearer repair instruction.
7. Add approval/history/debug export controls before running the next customer
   demo E2E.
