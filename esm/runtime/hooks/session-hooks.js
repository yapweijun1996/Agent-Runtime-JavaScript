import { createHookRunner } from '../hook-runner.js';
import { createPolicyHook } from './policy-hook.js';
import { createTerminalRepairPreRequestHook, createTerminalRepairOnResponseHook } from './terminal-repair-hook.js';

// Built-in session hook bundle (AGRUN-422 + AGRUN-421). Lazily attaches the
// session-scoped HookRunner with the runtime's default hooks registered —
// lazy (instead of createActionLoopSession wiring) so every session shape,
// including test mocks and resume-rebuilt sessions, gets the same hooks the
// moment any dispatch door asks for the runner.
//
// Built-ins:
//   preToolCall — policy gate (fail-CLOSED via resolveBlockedPolicyDecision)
//   preRequest  — terminal-repair before_planner refresh (fail-open, advisory)
//   onResponse  — terminal-repair direct-terminal gate (fail-open + loud step)


function ensureSessionHookRunner(session) {
  if (!session.hookRunner) {
    session.hookRunner = createHookRunner({
      timeoutMs: session.runtimeConfig && session.runtimeConfig.hostHookTimeoutMs
    });
    session.hookRunner.add("preToolCall", createPolicyHook());
    session.hookRunner.add("preRequest", createTerminalRepairPreRequestHook());
    session.hookRunner.add("onResponse", createTerminalRepairOnResponseHook());
  }
  return session.hookRunner;
}

export { ensureSessionHookRunner };
