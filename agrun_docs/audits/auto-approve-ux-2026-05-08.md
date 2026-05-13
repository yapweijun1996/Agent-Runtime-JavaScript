# Auto-approve Tier-1 UI<>SSOT — UX audit 2026-05-08

## Issue summary

Live e2e on 2026-05-08 evening (ADR-0027 third run) observed the Settings panel showing the **Auto-approve Tier-1 actions** checkbox as `Enabled`, yet `JSON.parse(localStorage["agrun.browser.settings.v1"]).approvals.autoApproveTier1` returned `false`. Three approval gates fired during the run despite the visible toggle state, breaking the apparent UX contract.

## Code-path verification (Explore agent, 2026-05-08)

The data flow from UI → localStorage → runtime is intact:

| Step | File | Lines | State |
|---|---|---|---|
| 1. Checkbox | `examples/browser/src/components/ProvidersSettingsPanel.tsx` | 161-164 | OK |
| 2. onChange | same file | 164 | OK |
| 3. Modal handler | `examples/browser/src/components/SettingsModal.tsx` | 144-150 | OK |
| 4. Save button | same file | 290-307 | OK (gated on `hasUnsavedChanges`) |
| 5. App state update | `examples/browser/src/App.tsx` | 342-343 | OK |
| 6. localStorage write | `examples/browser/src/runtime/storage.ts` | 161-164 | OK |
| 7. localStorage read | same file | 102-159 (line 113) | OK (`parsed.approvals?.autoApproveTier1 === true`) |
| 8. Runtime consumption | `examples/browser/src/runtime/agent.ts` | 1051 | OK (`actionPolicy: autoApproveTier1 ? AUTO_APPROVE_TIER1_ACTION_POLICY : DEFAULT_ACTION_POLICY`) |

No code-path bug: every link is present and wired correctly.

## Diagnosis: UX gating, not a code bug

The Save button (line 290-307 of `SettingsModal.tsx`) is conditional on `hasUnsavedChanges = JSON.stringify(draftSettings) !== JSON.stringify(settings)`. The flow that produces the bug:

1. User opens Settings → `draftSettings = settings` (pulled from localStorage)
2. User toggles checkbox → `setDraftSettings({...draftSettings, approvals: { autoApproveTier1: true }})`. UI re-renders showing `Enabled`.
3. User closes modal **without clicking Save**. `draftSettings` is discarded; `settings` (and thus localStorage) remains unchanged.
4. Next time user opens Settings, the checkbox shows the actual `settings` value — but if the bug-reporting path is "I just toggled it", the user perceives `Enabled` as their intent.

The "draft + save" pattern is intentional (allows cancel/revert). The bug is **discoverability**: the Save bar only appears when changes are pending, but a user closing the modal via the X icon or Escape key has no warning that their changes will not persist.

## Proposed remedies (NOT applied 2026-05-08; require design call)

**Option A — Auto-save toggle settings** (lowest friction)
For boolean toggles like `autoApproveTier1` whose change is immediately material (next action gate fires), persist on toggle change instead of waiting for Save. Trade-off: loses revert affordance for these specific settings.

**Option B — Explicit dirty-state banner** (preserves draft/save semantics)
When `hasUnsavedChanges` is true and the user attempts to close the modal, prompt "You have unsaved changes. Save or discard?". Keeps the draft pattern but blocks silent loss.

**Option C — Inline persisted indicator**
Mark each input with a small "saved" / "unsaved" badge so the user can see which fields are committed. Keeps draft pattern; lowest UX intrusion.

## Status

Not fixed in AGRUN-235 (out of scope — focus was ADR-0028 push-mode delete). Open as separate UX work item.

## Live evidence

Source: `agrun_docs/live-tests/zero-residual-push-mode-2026-05-08.md` third run.
- Settings panel screenshot: checkbox checked.
- IndexedDB inspection: `localStorage["agrun.browser.settings.v1"]` parsed → `approvals.autoApproveTier1: false`.
- Runtime telemetry: 3 approval gates fired in sequence (web_search → read_url × 2).

## Reflection

Am I trying to hardcode this instead of using harness engineering? — No. The harness contract is correct; the bug is in the host UI's gating semantics. Fix belongs in `examples/browser/src/components/SettingsModal.tsx`, not the runtime.
