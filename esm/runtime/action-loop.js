import { createActionLoopSession } from './action-loop-session.js';
import { continueActionLoop } from './action-loop-session-loop.js';

async function runActionLoop(options) {
  // Crash-recovery resume (P2): a host-supplied `resumeState` (the output of
  // importState) feeds the existing `options.runState` injection seam so the
  // loop continues from the checkpointed state instead of a fresh runState.
  const resumeOptions = options.resumeState && !options.runState
    ? { ...options, runState: options.resumeState }
    : options;
  const session = createActionLoopSession(resumeOptions);
  return continueActionLoop(session);
}

export { runActionLoop };
