# Approval Flow

## Purpose

This document describes the human-in-the-loop approval system in agrun.js. The approval flow allows the host application to gate certain actions behind user confirmation, with full support for resuming execution after approval or denial.

For the action policy tiers, see `agrun_docs/action-contract.md`.
For the full execution flow, see `agrun_docs/agentic-execution-flow.md`.

## Overview

```text
Planner selects action
        ↓
evaluateActionPolicy()
        ↓
    ┌─── allow → execute immediately
    ├─── ask   → return pending approval to host (human-in-the-loop pause)
    └─── deny  → record denial, continue loop (no host round-trip — see Policy Denial below)

        (host approves or denies)
        ↓
runtime.run({ type: "approval_resolution", ... })
        ↓
runApprovalResolution()
        ↓
    ┌─── approve → execute the action, continue loop
    └─── deny    → record denied, continue loop (planner picks alternative)
                   (2+ consecutive denials emit an observability signal only)
```

## Action Policy

### Tier-Based Defaults

Each action has a tier that determines its default policy:

| Tier | Default Policy | Examples |
|------|---------------|----------|
| 0 (or null) | `allow` | `execute_skill_tool`, `list_agent_skills` |
| 1 | `ask` | `web_search`, `read_url` |
| 2 | `ask` | (reserved for future higher-risk actions) |
| 3 | `deny` | (reserved for dangerous actions) |

### Policy Override

The host can override default policies per action through `actionPolicy` in runtime config:

```javascript
createRuntime({
  actionPolicy: {
    web_search: "allow",   // override tier 1 default
    read_url: "allow"      // override tier 1 default
  }
});
```

Valid policy values: `allow`, `ask`, `deny`.

### Policy Evaluation

`evaluateActionPolicy()` resolves the effective policy:

1. Check if a host override exists for the action name
2. If not, infer from the action's tier
3. Return `{ action, actionName, tier }`

## Policy Denial (Non-Blocking)

When an action's policy evaluates to `deny`, the runtime does **not** pause the
run or return an envelope for the host to resolve — there is no host approval
flow that could ever grant a permanent denial (AGRUN-562). Instead the OODAE
loop recovers on its own, in the same turn:

```text
mid-run state (loop continues — nothing below is returned to the host)
 ├ actionHistory: [..., { actionName, kind: "denied", summary }]
 ├ runState.observation:
 │  ├ kind       — "tool_rejection"
 │  ├ message    — 'Action "<name>" is denied by policy and can never be
 │  │              used this session...'
 │  ├ policy     — "deny"
 │  └ resolution — "denied"
 └ runState.turnControl:
    ├ signal — "run_again"
    └ source — "policy"
```

`runState.status` and `runState.pendingApproval` are left untouched (never
set to `"blocked"`, never populated). The planner sees the denied action via
`loopState.deniedActions` on its next cycle — the same mechanism described in
[Deny Handling](#deny-handling) below — and picks an alternative action,
`finalize`, or an honest `final` explaining the limitation. The `RunResult`
the host actually receives is whatever the planner produces next, typically
`output.kind: "planner_final"` or `"final_response"`.

This is the single-action dispatch door's behavior
(`action-loop-terminal.js` `handlePolicyBlock` → `handlePolicyDenied`). The
plan-batch door (`action-loop-plan-validation.js`) never lets a `deny`-tier
action into a plan in the first place — it rejects the whole plan envelope
with structured planner feedback (`action_policy_denied_in_plan`) telling the
planner to choose a different action, since (unlike an `ask`-tier action)
there is no standalone retry that could ever succeed.

## Pending Approval Envelope

When an action's policy evaluates to `ask`, the runtime returns a result with a pending approval:

```text
RunResult
 ├ output: null
 ├ runState.status: "blocked"
 ├ runState.turnControl:
 │  ├ signal         — "interruption"
 │  ├ source         — "policy"
 │  ├ actionName     — the action requiring approval
 │  └ pendingApproval — token-free approval summary for planner/inspector reads
 ├ runState.pendingApproval:
 │  ├ actionName    — the action requiring approval
 │  ├ policy        — "ask"
 │  ├ reason        — why approval is needed
 │  ├ resumable     — true
 │  ├ resolution    — "pending"
 │  └ resumeToken   — opaque token for resumption
 └ steps: [...execution trace up to this point]
```

### Resume Token

The `resumeToken` contains everything needed to resume execution:

```text
ResumeToken
 ├ actionName         — action to execute on approval
 ├ decision           — the planner's original decision (with args)
 ├ policy             — "ask"
 ├ reason             — policy reason
 ├ resumable          — true
 ├ turnCount          — turn counter at interruption time
 ├ turnControl        — interruption signal snapshot
 ├ researchContext     — search results and read sources gathered so far
 ├ toolContext         — tool execution history
 ├ agentSkillContext   — active skill state
 ├ actionHistory       — action history for cycle continuity
 ├ plannerInvalidCount — planner invalid count for state restoration
 └ _meta (optional)   — signing metadata when approvalSigning is enabled
    ├ v               — envelope version (currently 1)
    ├ nonce           — unique per-token UUID
    ├ issuedAt        — ms epoch of sign time
    ├ ttlMs           — lifetime window (default 15 min)
    └ sig             — HMAC-SHA256 base64url over the full token minus _meta.sig
```

> **Security (AGRUN-523): the resume token carries NO provider secret.** Every
> secret-keyed field (e.g. `request.apiKey`, `webSearchApiKey`, any
> `*token`/`*secret`/`authorization`) is redacted to `"[redacted]"` on the
> returned `result.output.pendingApproval` **and** `result.runState.pendingApproval`
> before the token is signed — so a host that logs, persists, or renders the
> approval surface never stores a usable key. The signature is computed over the
> redacted bytes, so `sign → verify` still validates on resume. **Consequence:**
> for client-auth providers the host MUST re-supply the credential on resume (see
> below); the runtime no longer falls back to a key embedded in the token. A
> server-auth (`authMode:"server"`) token never carried a client key and is
> unaffected.

### Resume Token Signing

By default, resume tokens are emitted as plain JSON. When a runtime is created with
`approvalSigning: true` (or a config object), tokens are signed and verified:

```javascript
createRuntime({
  skills: [...],
  approvalSigning: {
    key: "shared-secret-or-Uint8Array",   // optional — auto-generated if absent
    ttlMs: 15 * 60 * 1000,                // optional — default 15 min
    enforceSessionBinding: true,          // reject token if sessionId mismatches
    onDegraded: ({ reason }) => {}        // called if Web Crypto unavailable
  }
});
```

When signing is enabled:

- Every pending approval receives `_meta` with a random nonce, issue timestamp, and HMAC-SHA256 signature.
- `normalizeApprovalResolutionInput()` rejects tokens whose signature does not match, whose nonce was already consumed (replay), or whose `issuedAt + ttlMs` is in the past.
- With `enforceSessionBinding: true`, a token signed for session A cannot be redeemed against session B.
- If `globalThis.crypto.subtle` is unavailable, the signer emits an unsigned envelope (`_meta.unsigned = true`) and fires `onDegraded({ reason: "no_webcrypto" })`. Verification of unsigned tokens still enforces nonce + TTL.

Auto-generated keys are scoped to the runtime instance, so a page reload invalidates all outstanding tokens — this is intentional and reduces the replay window to the browsing session.

Backwards compatibility: when `approvalSigning` is omitted or falsy, token shape is unchanged and verification is a no-op.

## Approval Resolution

### Input Format

To resolve a pending approval, the host calls `runtime.run()` with:

```javascript
runtime.run({
  type: "approval_resolution",
  decision: "approve",  // or "deny"
  resumeToken: result.runState.pendingApproval.resumeToken,
  apiKey: "...",  // REQUIRED for client-auth (AGRUN-523): the token no longer
                  // carries the key. Also re-supply fetch/endpoints as needed.
                  // Gemini server-auth resumes from endpoint metadata — no key.
});
```

If a client-auth resume omits `apiKey`, the restored provider request has
`apiKey: null` and the provider call fails — this is the intended secure default,
not a regression. The reference host
(`examples/browser/src/runtime/approval-controller.ts`) re-supplies the key from
its settings on every approve.

For Gemini `authMode: "server"`, the resume token preserves proxy transport fields (`authMode`, `endpoint`, `streamEndpoint`, `cachedContentMode`) and must not serialize or require a provider `apiKey`. Gemini grounded search proxy fields (`searchProvider`, `webSearchAuthMode`, `webSearchEndpoint`, `webSearchModel`) are also preserved for approval resume.

### Resolution Flow

`runApprovalResolution()` handles the resolution:

1. **Parse**: Extract approval request from input via `normalizeApprovalResolutionInput()`
2. **Restore**: Rebuild the provider request from the resume token via `restoreApprovalRequest()`
3. **Hydrate**: Restore the action loop session state:
   - Research context from resume token
   - Tool context from resume token
   - Agent skill context
   - Action history
   - Cycle/turn counters
   - `turnControl` interruption metadata
   - Pending approval state
   - Context snapshot from the request
4. **Begin Cycle**: Start a new OODAE cycle with `strategy: "policy"`
5. **Route**:
   - If `deny` → `handleApprovalDenied()`
   - If `approve` → `executeAction()` with the original decision

### Control Envelope

The approval flow uses a control envelope pattern to track state:

- `startControlEnvelope(runState, "approval_resolution")` — marks the run as an approval resolution
- `consumeControlEnvelope(runState, requestType)` — clears the envelope after action completes

This prevents the action loop from re-entering approval state after the action executes.

### Deny Handling

This section covers the **resolution-side** denial: the host denying a
pending `ask` approval via `approval_resolution`. A `deny`-tier action
produces the identical actionHistory/observation/turnControl shape without
ever creating a pending approval in the first place — see
[Policy Denial (Non-Blocking)](#policy-denial-non-blocking) above.

When the host denies:

1. A `{ kind: "denied", actionName }` entry is pushed to `actionHistory`
2. An observation is recorded: `{ kind: "tool_rejection", resolution: "denied", message }`
3. `pendingApproval` is cleared
4. `runState.turnControl.signal` becomes `"run_again"` with the `tool_rejection` observation
5. The action loop continues — the planner sees the denied action in `loopState.deniedActions`, `loopState.lastObservation`, and `loopState.turnControl`, then picks an alternative (e.g., `final`, `finalize`, or a different action)

The system prompt instructs the planner: *"Never re-select an action listed in deniedActions."*

### Consecutive Denial Guard

If the user denies 2 or more actions consecutively (`MAX_CONSECUTIVE_DENIALS =
2`), the runtime emits an `approval-denial-streak` step for observability. It
does not force a `finalize` decision. The planner sees `deniedActions` and owns
the next move: choose a non-denied action, `finalize`, or an honest `final`
explaining the limitation.

```text
Deny web_search → planner picks read_url → Deny read_url
    → approval-denial-streak step emitted
    → planner chooses a non-denied action or honest terminal answer
```

### Approve and Continue

When the user approves:

1. The action executes with the original decision and args
2. If the action completes the run (`actionResult.done`) → return result
3. If the action does not complete → clear the approval envelope and continue the action loop for further cycles

## Integration with Host Applications

### Web UI Example

```text
1. User sends prompt
2. Runtime returns pending approval for web_search
3. UI shows: "The agent wants to search for X. Allow?"
4. User clicks Approve
5. UI sends approval_resolution with resumeToken
6. Runtime executes web_search, continues research
7. Runtime returns final answer (or another approval)
```

### Key Design Decisions

- **Resumable by default**: The approval system preserves full execution context, so the agent can continue exactly where it left off.
- **No timeout**: Approvals can be resolved at any time. The resume token contains all necessary state.
- **Stateless runtime**: The runtime does not store pending approvals internally. The host is responsible for passing the resume token back.
- **Multiple approvals**: A single run may trigger multiple sequential approvals if different actions need approval.
- **Deny continues**: Denial does not terminate the run. The planner adapts by choosing an alternative strategy, making the agent resilient to partial user restrictions.
