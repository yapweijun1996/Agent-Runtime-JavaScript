# Long Task Lab PWA UI Refactor Live Test — 2026-05-18

## Goal

Apply the approved UI/UX + PWA refactor plan:

- Add a Single Source of Truth token layer for typography, spacing, colors,
  radii, touch targets, and z-index.
- Improve the long-running task page mobile UX with an app-like detail sheet
  instead of a fully stacked detail rail.
- Add PWA foundation: manifest, icons, service worker, offline page, theme
  metadata, and production registration.

## Implementation

Files added:

- `examples/long-task-lab/src/styles/tokens.css`
- `examples/long-task-lab/src/runtime/lab-pwa.ts`
- `examples/long-task-lab/public/manifest.webmanifest`
- `examples/long-task-lab/public/sw.js`
- `examples/long-task-lab/public/offline.html`
- `examples/long-task-lab/public/icons/icon.svg`
- `examples/long-task-lab/public/icons/maskable-icon.svg`

Files updated:

- `examples/long-task-lab/src/App.tsx`
- `examples/long-task-lab/src/main.tsx`
- `examples/long-task-lab/src/index.css`
- `examples/long-task-lab/src/components/TaskSetupPanel.tsx`
- `examples/long-task-lab/index.html`

## UI Rules

- Root remains `16px`; 9pt-equivalent text is represented by `--font-xs:
  0.75rem` and is limited to labels/metadata.
- Inputs keep a 44px touch target through `--touch-min`.
- Detail panels become a bottom sheet on mobile. The primary mission surface
  remains visible first; Evidence, Workspace, Records, and Debug are opened
  from a fixed mobile detail tab bar.
- The desktop three-column layout is preserved.

## PWA Rules

- Service worker registers only in production builds.
- App shell, offline page, manifest, and local icons are cached.
- External API calls and the `/openai-gateway` proxy are not cached.
- Offline mode is honest: it keeps the app shell available, but new AI runs
  still require network/provider access.

## MCP Chrome Proof

Production preview URL:

`http://localhost:4174/?qa=pwa-ui-refactor`

Initial PWA proof:

```json
{
  "title": "agrun Long Task Lab",
  "rootFontSize": "16px",
  "fontXs": ".75rem",
  "touchMin": "44px",
  "manifestName": "agrun Long Task Lab",
  "manifestDisplay": "standalone",
  "manifestIconCount": 2,
  "swReady": true,
  "swController": true,
  "offlineStatus": 200,
  "unlabeled": 0,
  "formAutocomplete": "off"
}
```

Mobile sheet proof:

```json
{
  "viewport": { "width": 500, "height": 733 },
  "before": {
    "navDisplay": "grid",
    "overflowX": false
  },
  "afterOpen": {
    "backdropActive": true,
    "selectedPanelHeading": "Records",
    "filterVisible": true,
    "overflowX": false
  },
  "afterClose": {
    "backdropActive": false,
    "overflowX": false
  }
}
```

Desktop proof:

```json
{
  "viewport": { "width": 1280, "height": 733 },
  "navDisplay": "none",
  "railPosition": "static",
  "overflowX": false,
  "panels": [
    { "className": "setup-panel", "width": 360 },
    { "className": "main-workspace", "width": 498 },
    { "className": "detail-rail", "width": 420 }
  ]
}
```

## Verification Commands

- `node --check examples/long-task-lab/public/sw.js`
- `node -e "JSON.parse(require('fs').readFileSync('examples/long-task-lab/public/manifest.webmanifest','utf8')); console.log('manifest ok')"`
- `npm run test:long-task-lab`
- `npm --prefix examples/long-task-lab run build`

## HBR

The manifest currently uses SVG icons. Browser parsing and service worker proof
passed, but some installability audits may prefer PNG 192/512 icons. This is a
follow-up asset-quality task rather than a blocker for the UI/PWA shell logic.
Chrome also reports a verbose autocomplete suggestion for API-key password
fields. The setup form has `autocomplete="off"`, the key fields use
`autocomplete="new-password"`, and DOM audit found zero unlabeled fields; this
is not a blocking app/runtime issue.
