# Runtime Lifecycle Inspector Real Chinese Research QA — 2026-05-10

## Goal

Verify the new Inspector Runtime Lifecycle and action result envelope projections
on a real provider run, using the long Chinese prompt:

`用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告`

## Environment

- Browser example: `http://127.0.0.1:3001`
- Provider: Gemini, seeded from local `.env.local`
- Browser: headless Chrome with CDP
- QA URL:
  `?debug_yn=y&qa=runtime-lifecycle-real-cn-3000-v4-2026-05-10&qa_auto_approve_tier1=y`
- Tier-1 auto approval: enabled
- Task Progress: enabled

## Result

The run completed and the Inspector rendered the expected debug sections.

Observed Inspector headings:

- `Threading`
- `Diagnosis`
- `Runtime Lifecycle`
- `OODAE Cycles`
- `AI Workflow`
- `LLM Trace`
- `Virtual Workspace`
- `Evidence`

Observed checks:

- `hasRuntimeLifecycle=true`
- `hasLastAction=true`
- `hasActionChip=true`
- `hasOodaeCycles=true`
- `hasAiWorkflow=true`
- `hasLlmTrace=true`
- `issueType=Healthy Run`
- visible Chinese output had about `3045` CJK characters
- `read_url` network responses observed: 14
- read URL statuses included `200`, `304`, and `204`

## HBR

Chrome DevTools MCP failed before this run with `selected page has been closed`,
so the real browser verification used a local headless Chrome CDP script
instead of the MCP tool.

The first long-run script also completed the AI answer but failed during DOM
state extraction because the test expression used unsafe regex newline escaping.
The second long-run script completed but incorrectly clicked the already-open
Inspector button, closing the panel before checking it. The final v4 run fixed
that by clicking only when the Inspector button said `Show inspector`.

## Harness Boundary

This QA proves observability only. The runtime still does not decide whether
the research is good enough, whether 3000 characters is sufficient, or whether
the AI should continue researching. Inspector exposes lifecycle and action
facts so the AI/user/developer can debug from evidence.
