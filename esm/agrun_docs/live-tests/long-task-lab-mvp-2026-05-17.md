# Long Task Lab MVP Smoke — 2026-05-17

## Scope

Verify the new `examples/long-task-lab` MVP can run locally, map agrun runtime
signals into Mission Control / Evidence / Workspace / Final Artifact / Debug
surfaces, and complete or fail honestly during a real provider run.

## Commands

```bash
npm run test:long-task-lab
npm run build:long-task-lab
npm --prefix examples/long-task-lab run dev
```

Results:

- `npm run test:long-task-lab` passed.
- `npm run build:long-task-lab` passed.
- Build warning: Vite reports the app bundle is larger than 500 kB after
  minification. This is expected for the current source-level agrun import.
- Production build was checked for obvious local key literals after changing
  auto-seed to dev-only. The remaining matches were code literals/patterns,
  not the local `.env.local` key values.

## Browser QA

Target:

```text
http://localhost:3001/
```

Observed desktop state:

- Page title: `agrun Long Task Lab`.
- Task Setup rendered provider/model/key controls, search/read-url endpoint
  fields, preset selector, prompt editor, Start/Stop.
- Mission Control rendered status, runtime step count, latest action, TodoState
  progress, and repair status.
- Timeline, Final Artifact, Evidence, Workspace, and Debug surfaces rendered.
- Evidence/Workspace/Debug tabs switched correctly.
- No horizontal overflow was detected in the inspected desktop viewport.
- No JS `error` or `unhandledrejection` events were captured during smoke.

Tool limitation:

- The in-app Browser Node control tool was not available in this session after
  tool discovery. Chrome DevTools was used instead. A rendered mobile screenshot
  was not captured.

## Real API Run

Provider/model:

```text
OpenAI / gpt-5.4-mini
```

Prompt:

```text
Run a short Long Task Lab smoke mission. Use TodoState if helpful, use web_search
for one current source about AI agent runtimes, read one URL if available, then
produce a concise final artifact with source link and an honest limitation if
evidence is weak.
```

Settings:

- `maxSteps=30`
- `autoApproveTier1=true`
- Web search endpoint from local dev settings.
- Read URL endpoint from local dev settings.

Outcome:

- Status: `completed`.
- Final source: `planner`.
- Terminalized by: `planner_final`.
- Evidence panel populated:
  - Queries: 2.
  - Reads: 1.
  - Usable: 0.
  - Strong: 0.
- Final artifact was short and honest:
  - It cited one OpenAI Academy URL.
  - It did not claim strong evidence.
- No captured JS runtime errors.

## HBR

- First attempted real run blocked on `web_search` policy because auto-approve
  was off. The app showed blocked state, but there is no approval-resume UI yet.
- Second run completed, but source quality was weak because the direct page read
  was blocked/challenge-like. This proves the UI can surface weak evidence; it
  does not prove the Market Research preset can reliably produce a strong memo.
- Mission Control initially displayed timeline event count (`120 / 30`) instead
  of runtime step count. Fixed after QA by reading `snapshot.stepCount` /
  `runState.stepCount`.

## Next

1. Add approval resume controls for policy-blocked runs.
2. Add Playwright or Browser-plugin screenshot coverage for desktop and mobile.
3. Add a stronger canonical real API preset run after approval resume is wired.
