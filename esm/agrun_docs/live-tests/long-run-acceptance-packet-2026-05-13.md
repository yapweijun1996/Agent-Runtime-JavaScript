# Long-Run Acceptance Packet QA - 2026-05-13

## Goal

Fix the long-run research/report loop so the AI can keep seeing a compact,
stable acceptance state after search, read, workspace, and publish actions.
The runtime must provide observable facts, not write the report or choose the
AI's next research strategy.

## Implementation

- Added `refreshResearchReportLoopGate(runState, runtimeConfig, context)` in
  `src/runtime/research-report-loop.js`.
- The refresh path reuses the existing report-loop evaluation and commit path,
  then writes `runState.researchReportLoop.gateSignal.acceptancePacket`.
- The acceptance packet includes requested length, observed candidate stats,
  read/source minimum status, research gaps, publish block status, recent
  search state, and cycle budget.
- Wired refresh after:
  - `web_search`
  - `read_url`
  - `workspace_read`
  - `workspace_finalize_candidate`
  - `workspace_publish_candidate`
  - workspace write/append/insert/replace actions
- Updated planner prompt projection so the AI can see the compact packet.
- Reduced duplicate prompt/context pollution by suppressing repeated
  `currentGoal`, `currentTopic`, `activeQuery`, and duplicate goal anchor text
  when they match the raw user request. Explicit terminal suffix markers remain
  preserved.

## Verification

Passed:

- `node test/unit/research-report-loop.test.js`
- `node test/unit/action-plan-args-validation.test.js`
- `node test/unit/workspace-actions.test.js`
- `node test/unit/planner-prompt-plan-validation-feedback.test.js`
- `node test/concerns/memory.test.js`
- `node test/concerns/session.test.js`
- `node test/concerns/approval-resume.test.js`
- `npm run build`
- `npm test`
- `npm run dist:check`

Build notes:

- Existing Rollup/Vite dependency warnings still appear for OpenTelemetry,
  zod circular dependencies, and large chunks. They are unrelated to this
  change.

## Live Browser QA

Target:

- `http://127.0.0.1:3331/?debug_yn=y&qa=acceptance-packet-3000word-live-rerun3b-2026-05-13&qa_provider=gemini&qa_auto_approve_tier1=y`

Prompt summary:

- End-user style 3000-word AI agent harness engineering report.
- Must use long-web-research and read_url evidence where possible.
- Must end with `MCP_CHROME_ACCEPTANCE_PACKET_3000_WORD_RERUN3_DONE`.

Observed result:

- Run status: failed by maxSteps.
- Selected skill: `long-web-research`.
- `read_url`: ok 200.
- Candidate path: `engineering_brief.md`.
- Candidate stats: 22472 chars, 19276 non-whitespace chars, 3058 words.
- Final readiness declared by AI: `ready`.
- Research gate: `researchFinalAllowed=false`.
- Evidence gap: `insufficient_relevant_sources`.
- Source minimum: `reads=1/3`, `relevant=1/2`.
- Workspace publish remained blocked/continued; the run did not safely publish.

Pass evidence:

- The AI no longer stopped at 1200-1300 words in this live run.
- The candidate expanded beyond the requested 3000-word length.
- `read_url` worked and contributed one successful read.
- Todo progress reached a fresh completed state; no stale active Todo item was
  left after work.

Failed evidence:

- The AI still declared `ready` while the acceptance packet/source minimum said
  evidence was insufficient.
- The loop eventually hit maxSteps instead of choosing more evidence work or a
  concrete `limited` finalReadiness with `remainingGaps`.

## HBR

The acceptance packet fixed the missing length-continuation signal, but it did
not fully fix AI readiness judgment. The next issue is decision alignment:
when `acceptancePacket.evidence.sourceMinimum.passed=false` or
`researchFinalAllowed=false`, AI must either gather/read more sources or return
`limited` with concrete `remainingGaps`. It must not declare clean `ready`.

## Next Follow-Up

1. Strengthen the AI-facing readiness contract around
   `acceptancePacket.evidence.sourceMinimum` and `researchFinalAllowed`.
2. Add a regression where a 3000-word candidate has enough length but
   insufficient sources; expected result is more evidence work or `limited`
   with concrete `remainingGaps`, not `ready`.
3. Rerun live browser QA and confirm no maxSteps failure.
