# AGRUN-512 — authoring-discipline prompt guidance (2026-06-15)

## What shipped (honest scope)

The AGRUN-512 evaluation recommended **gating** the 9 `virtualMutationPermission`
workspace authoring actions on trivial prompts. The maintainer **rejected gating**
(caging the AI violates AI-first) and directed an **AI-first prompt fix**: teach the
AI *when* authoring is appropriate, keep all tools visible.

Shipped: one generic, purpose-describing guidance line on **both** planner doors,
mirroring the existing TodoState-discipline line (`planner-native-directives.js:62`):
- `src/runtime/prompts/planner-native-directives.js` (native_tools door)
- `src/runtime/prompts/workspace-directives.js` (envelope door, always-on block)

> "Workspace authoring … is for substantial, multi-section deliverables … For a
> simple or direct answer …, do NOT open a workspace draft: gather any needed
> evidence and finalize directly. Choose workspace authoring only when YOU judge
> the answer genuinely needs multiple sections or iterative refinement."

**No gating.** `planner-action-surface.js` is untouched; all 9 authoring actions
stay selectable in every mode. The change is host-overridable
(`nativePlannerDirectives` / `workspaceDirectives`).

## ⚠️ The 2026-06-13 6/6 failure is NOT reproducible (the binding finding)

The motivating failure (gpt-5-mini, native_tools, trivial prompt, 2026-06-13, 6/6
FAIL → `list_agent_skills → workspace_write → workspace_read →
workspace_review_candidate` → `MAX_STEPS_EXCEEDED`) **could not be reproduced** in
the current environment.

`test/live-observe-authoring-discipline.mjs` ran the SAME prompts in `native_tools`
(`maxSteps=8`) in two modes on the same keys: **baseline** = the pre-change planner
directives (the AGRUN-512 line stripped via a prompts override) vs **fixed** = the
shipped directives. Matrix run 2026-06-15 with real keys (`.env.local`):

| Provider / model | prompts | skills | baseline | fixed |
|---|---|---|---|---|
| OpenAI `gpt-5-mini` | extreme-trivial (pong / 2+2 / hello) | off | 6/6 clean | 6/6 clean |
| OpenAI `gpt-5-mini` | borderline explainer (REST API / testing benefits / HTTP vs HTTPS) | off | 6/6 clean | 6/6 clean |
| OpenAI `gpt-5-mini` | borderline explainer | **on** (bundled skills) | 6/6 clean | 6/6 clean |
| Gemini `gemini-3.1-flash-lite` | borderline explainer | **on** | 6/6 clean | 6/6 clean |

"clean" = `status: completed`, **zero** workspace authoring decisions, ≤2 action
cycles. **Baseline == fixed in every cell.** The current models finalize trivial /
borderline prompts directly whether or not the discipline line is present — so the
fix's *necessity* cannot be demonstrated against a live failure, because the failure
does not occur now.

Why it could not be reproduced (best assessment): the 2026-06-13 6/6 left **no
committed trace** (exact prompt, skill config, and model build are only prose in
`agrun_docs/evaluations/agrun-512-workspace-authoring-gate.md`). The wander was
plausibly intermittent / model-version-specific. Future readers: do not assume the
fix "works" was proven — it was not; it was shipped as a prophylactic (below).

## Decision: ship as a low-risk prophylactic + regression gate (maintainer-approved)

- **AI-first + maintainer-directed**: the prompt-teach approach is exactly what the
  maintainer chose over gating; the line mirrors the proven TodoState precedent.
- **Zero regression risk**: baseline == fixed proves the line neither suppresses
  legitimate direct answers nor (since all 9 tools stay visible + research smokes are
  green in `npm run check`) degrades authoring/research flows.
- **Lasting value**: `npm run test:live:authoring-discipline` is a committed gate that
  locks "a trivial prompt finalizes directly with zero workspace authoring" — so if a
  future model/prompt change DOES start wandering, it is caught.
- **No causal claim**: this is NOT "AGRUN-512 6/6 fixed". It is "the
  maintainer-directed authoring-discipline guidance, shipped safely; the target
  failure is not currently reproducible."

## Verification

- `npm run check` → EXIT 0 (prompt snapshot regenerated for the 2 added lines;
  `test/unit/workspace-authoring-discipline.test.js` asserts the guidance is present
  on both doors AND that all 9 authoring actions remain visible in plain tool_loop —
  i.e. no gating crept in; `planner-action-surface.test.js` unchanged).
- Live matrix above (real keys, no mock).

## Gate

```bash
npm run build
npm run test:live:authoring-discipline       # both providers; baseline vs fixed; skips on missing key
# options: --provider openai|gemini  --reps N  --skills  (loads bundled skills to match the original surface)
```

## Artifacts (raw, local — gitignored)
`test/live-observe-out/authoring-discipline-{openai,gemini}-2026-06-15T0*.summary.json`
