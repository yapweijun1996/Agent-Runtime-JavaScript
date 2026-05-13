# Chrome MCP Copy Lifecycle UI Verification — 2026-05-10

## Goal

Verify the Inspector follow-up with real Chrome DevTools MCP:

- Chrome MCP recovers from `selected page has been closed`.
- Browser example opens through MCP.
- A real provider turn generates a debug snapshot.
- Support panel exposes `Copy Lifecycle`.
- Debug Index shows `Task Progress` and `Action Results`.
- Raw panel exposes `Todo Progress Debug`.

## Environment

- URL: `http://127.0.0.1:5187/?debug_yn=y&qa=copy-lifecycle-mcp&qa_clean=y`
- Provider/model: `gemini / gemini-3.1-flash-lite-preview`
- Prompt: `Say ok in one short sentence.`
- Tool: Chrome DevTools MCP

## MCP Recovery

Initial MCP state failed with:

```text
Error: The selected page has been closed. Call list_pages to see open pages.
```

Process inspection showed `chrome-devtools-mcp` was still running, but the
dedicated Chrome profile process was gone. Restarted only the MCP server
processes, not the user's normal Chrome. After restart:

```text
Pages
1: about:blank [selected]
```

## Result

The page loaded through Chrome MCP and a real Gemini turn completed with `Ok.`.
Inspector showed:

- Support issue type: `Healthy Run`
- Run ID: `run-1`
- Debug Index rows: `Task Progress`, `Action Results`
- `Copy Lifecycle` button visible
- Clicking `Copy Lifecycle` changed the button label to `Copied`
- Runtime Lifecycle section visible with 16 lifecycle events
- Raw tab list included `Todo Progress Debug`
- Opening `Todo Progress Debug` rendered the raw tab body as `null` for this
  simple prompt, which is expected because no TodoState/TodoTask existed.

Console check:

- Vite connection debug messages
- React DevTools informational message
- No blocking runtime or UI errors

## Harness Boundary

This verified the Inspector UI and MCP path only. It did not introduce any
runtime content sufficiency gate, Todo auto-advance, or answer-length/source
hardcode. The runtime exposed facts; Inspector rendered them; AI still owns
task direction.

## HBR

- The stale-progress branch was unit/smoke verified, but this live UI prompt did
  not naturally produce stale Todo progress because it was intentionally short.
- Chrome MCP required a manual MCP server restart because its selected page
  state was stale after the dedicated Chrome process exited.
