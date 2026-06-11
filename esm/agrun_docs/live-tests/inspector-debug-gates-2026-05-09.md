# Inspector Debug Gates Live QA — 2026-05-09

## Goal

Make the browser Inspector explain why a run stopped, continued, or asked for
approval without requiring developers to guess from raw JSON.

## Change Under Test

- Browser debug snapshots now expose `runtime.config.maxSteps` and sanitized
  `runtime.config.actionPolicy`.
- The Support panel now includes a `Debug Gates` section with:
  - Approval Gate
  - Skill Gate
  - Research Gate
  - Step Budget
  - Tool Availability
  - Planner Mode

## Live Check

URL:

`http://127.0.0.1:3000/?debug_yn=y&qa=inspector-debug-gates-devtools&qa_clean=y`

Prompt:

`/search latest AI browser 2026`

Observed Inspector fields:

- Approval Gate: `no pending approval`
- Action policy: `read_url:ask, web_search:ask`
- Skill Gate: `web-search-skill`
- Research Gate: `inactive`
- Step Budget: `21/80`
- Tool Availability: `none disabled`
- Planner Mode: `auto`

## Verification

- `npm --prefix examples/browser run lint`
- `npm --prefix examples/browser run test:smoke`
- `npm --prefix examples/browser run build`
- Chrome DevTools desktop snapshot at 1440x900 shows `Debug Gates` rows.
- Chrome DevTools mobile snapshot at 390x844 shows the Inspector sheet with
  the same rows.
- Console warnings/errors: none.
- Horizontal overflow check on desktop Inspector: false.

## Result

Pass. The Inspector now exposes the key runtime gates in the first Support
panel, so approval policy, skill loading, research-gate state, disabled tools,
and max-step budget can be diagnosed directly.

## Remaining Risk

`autoApproveTier1` is available only for normal provider turns because direct
search runs do not carry the browser settings request snapshot. For direct
search, action policy is still visible through runtime config.
