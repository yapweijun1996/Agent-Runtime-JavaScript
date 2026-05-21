# Long Task Lab Review and Workspace Publish Fix - 2026-05-21

## Goal

Review whether the current Long Task Lab can work in a real browser with Chrome DevTools MCP, then fix the default mission so it exercises the virtual workspace publish path instead of bypassing it with direct `planner_finalize`.

## Environment

- App: `examples/long-task-lab`
- URL: `http://localhost:3001/`
- Browser test tool: Chrome DevTools MCP
- Provider path tested: OpenAI, `gpt-5.4-mini`
- Auto-approve tier 1: enabled for the live mission
- Max steps: 35 for the initial review, then 45 for workspace-publish follow-up runs
- Network secret policy: raw request headers and bodies were not copied.

## Verification

- `node examples/long-task-lab/test/lab-state.smoke.ts` passed.
- `node test/unit/workspace-actions.test.js` passed.
- `node test/unit/virtual-workspace.test.js` passed.
- `node test/unit/action-loop-session-terminals.test.js` passed.
- `npm run test:long-task-lab` passed.
- `npm test` passed.
- `npm run build:lib` passed with the existing OpenTelemetry `this` rewrite warning and zod circular dependency warning.
- `npm run build:long-task-lab` passed.
- Provider connection test returned `pong` in about 2.25s.
- Chrome DevTools current-page console had no error, warning, or issue messages after the final follow-up mission.
- Codeloom `audit_diff` ran on the changed runtime, Long Task Lab, and test files: 9 files audited, 0 files missing from the index.
- Network calls completed with HTTP 200:
  - OpenAI Responses calls.
  - SearXNG web search call.
  - Read URL service calls.
- IndexedDB persisted the final completed record:
  - `agrun-long-task-lab-record-store`: latest run completed in 18 cycles, 841 events, 1 artifact.
  - Latest artifact source: `workspace_publish_candidate`.
  - Latest artifact length: 2935 chars.
- Local storage secret scan found 0 API-key-like matches.
- IndexedDB secret scan found 0 API-key-like matches.
- Mobile viewport smoke at 390x844 showed the Debug panel and bottom navigation accessible.

## Initial Result

Long Task Lab works for the tested default OpenAI path: it can load, connect to the provider, run a mission, persist records, and show the final report without browser console errors.

The initial mission completed in 6/35 cycles, but its terminal path was `planner_finalize`, not `workspace_publish_candidate`.

## Fix

- Added host-level `virtualWorkspace.requirePublishPath` config and enabled it in Long Task Lab.
- Updated the finalize contract so a host-required workspace publish path blocks direct finalize before a workspace candidate exists.
- Changed empty `workspace_publish_candidate` from a thrown error into an AI-observable `virtual_workspace_publish_blocked` result with status `missing_candidate_content`, so the model can recover by drafting content instead of repeating opaque errors.
- Fixed the Long Task Lab Workspace panel projection:
  - reads object-shaped `virtualWorkspace.files`;
  - falls back to terminal `output.workspaceCandidate` for candidate path and stats;
  - marks `continuation_required` as blocked instead of completed so max-step pauses do not show as "Final artifact ready".

## Final Chrome DevTools Result

- Final live mission completed with status `Done`.
- Runtime cycles: 18/45.
- Terminal path: `workspace_finalize_candidate` -> `workspace_read` -> `workspace_publish_candidate`.
- Final Artifact source: `workspace_publish_candidate`.
- Workspace panel showed:
  - candidate path `final_candidate.md`;
  - 419 words;
  - 2935 chars;
  - publish state `workspace_publish_candidate`.
- Records preserved the terminal artifact with source `workspace_publish_candidate`.

## HBR

- Initial review HBR: the final report was generated through `planner_finalize`, not `workspace_publish_candidate`.
- Initial review HBR: Workspace panel showed no final candidate and no workspace files.
- Initial review HBR: evidence was honest but thin: 3 read attempts, 2 usable/strong sources, 1 weak source.
- Initial review HBR: Debug packet showed `10 recovery, 21 blocked`; the run still completed, but the volume of recovery/blocked internal events is a quality signal worth reviewing.
- A pre-fix follow-up run hit 45/45 cycles after repeated empty `workspace_publish_candidate` attempts on `final_candidate.md`; this exposed the need to make empty publish an AI-observable block instead of a throw.
- The final passing run still had limited evidence breadth: 2 usable reads, 1 strong source, and the memo labels its evidence base as directional rather than exhaustive.
- This pass tested OpenAI only. Gemini/custom provider live missions were not rerun in this review.

## Verdict

Can work: yes, for the OpenAI default path.

Production-quality long-task claim: stronger than the initial review. The default mission now exercises the virtual workspace publish path and the UI/Records surfaces preserve the workspace artifact. Evidence quality and Gemini/custom provider live coverage remain follow-up areas.
