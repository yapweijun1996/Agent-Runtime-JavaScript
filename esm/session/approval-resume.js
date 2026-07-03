import { createStructuredError, ERROR_CODES } from '../runtime/errors.js';
import { normalizeApprovalResolutionInput } from '../runtime/approval-state.js';
import { cloneValue } from '../runtime/utils.js';
import { prepareProviderSessionContext, createSessionContextView } from './compaction.js';
import { readContextSnapshot, createContextSnapshot } from './context-snapshot-normalize.js';
import { readString } from '../runtime/semantic-json.js';
import { projectSessionContextFromSnapshot } from './context-snapshot-projection.js';
import { summarizeSessionContextMeta } from './prompt.js';

async function prepareSessionApprovalResumeInput(options) {
  const clonedInput = cloneValue(options.input);
  const approvalRequest = await normalizeApprovalResolutionInput(clonedInput, {
    signer: options.approvalSigner || null,
    enforceSessionBinding: !!options.enforceSessionBinding
  });
  const baseRequest = readRequestClone(approvalRequest.resumeToken.request);
  const fallbackSnapshot = readContextSnapshot(baseRequest)
    || readContextSnapshot(options.sessionRecord && options.sessionRecord.contextSnapshot);
  const fallbackContext = fallbackSnapshot
    ? projectSessionContextFromSnapshot(fallbackSnapshot)
    : readSessionContext(baseRequest && baseRequest.sessionContext);
  const sessionId = readString(options.sessionId);

  approvalRequest.resumeToken.sessionId = readString(approvalRequest.resumeToken.sessionId) || sessionId;

  if (baseRequest) {
    const prepared = await prepareProviderSessionContext({
      input: {
        ...baseRequest,
        agrunSessionId: sessionId
      },
      sessionRecord: options.sessionRecord,
      sessionId,
      sessionPolicy: options.sessionPolicy,
      sessionStore: options.sessionStore,
      // Two-door parity (AGRUN-474 precedent) — the tool-loop door merges
      // cross-session global memory into the prompt context; the approval-
      // resume door builds a prompt via this same function and must not
      // silently drop it.
      globalMemoryEntries: options && options.globalMemoryEntries ? options.globalMemoryEntries : [],
      threadScope: options && options.threadScope ? options.threadScope : null
    });

    if (!prepared.error) {
      approvalRequest.resumeToken.request = {
        ...prepared.input,
        agrunSessionId: sessionId
      };
      approvalRequest.resumeToken.sessionContextMode = "session_store";

      return {
        approvalResumeFallbackUsed: false,
        // AGRUN-145 Slice D — propagate compaction window so runLoop
        // trims evidence from compacted turns on the resumed run too.
        compactionWindow: prepared.compactionWindow || null,
        // AGRUN-474 — Two-door parity for ALL compaction signals. The tool-loop
        // door spreads the whole prepared result, so it carries compactionUsage
        // (cost accounting + `compaction-completed` step) and compactionTurn
        // (hidden-turn persistence) for free; this door re-lists fields, so they
        // were silently dropped. Forward them so a compaction on the approval
        // resume path is accounted, persisted, and observable just like the
        // tool-loop path — and so the C4 `compaction-failed` signal stays paired
        // with its `compaction-completed` counterpart.
        compactionUsage: prepared.compactionUsage || null,
        compactionTurn: prepared.compactionTurn || null,
        // AGRUN-461 — forward a swallowed compaction failure so handle.js emits
        // `compaction-failed` on the approval resume door as well.
        compactionError: prepared.compactionError || null,
        input: {
          ...clonedInput,
          agrunSessionId: sessionId,
          resumeToken: approvalRequest.resumeToken,
          _approvalPreVerified: true
        },
        contextSnapshot: prepared.contextSnapshot || null,
        sessionContextMeta: prepared.sessionContextMeta || null,
        sessionContextSource: "session_store",
        sessionContextView: prepared.sessionContextView || null,
        summaryUpdatedAt: prepared.summaryUpdatedAt || null
      };
    }

    if (fallbackContext) {
      approvalRequest.resumeToken.request = {
        ...baseRequest,
        agrunSessionId: sessionId,
        contextSnapshot: fallbackSnapshot
          ? createContextSnapshot(fallbackSnapshot)
          : null,
        sessionContext: fallbackContext
      };
      approvalRequest.resumeToken.sessionContextMode = "token_fallback";

      return {
        approvalResumeFallbackUsed: true,
        // AGRUN-474/AGRUN-461 — Two-door parity (see above): forward every
        // compaction signal even when the resume falls back to token context;
        // the compaction physically ran, so its spend + turn + any failure must
        // not be lost just because we did not adopt the session-store context.
        compactionUsage: prepared.compactionUsage || null,
        compactionTurn: prepared.compactionTurn || null,
        compactionError: prepared.compactionError || null,
        input: {
          ...clonedInput,
          agrunSessionId: sessionId,
          resumeToken: approvalRequest.resumeToken,
          _approvalPreVerified: true
        },
        contextSnapshot: approvalRequest.resumeToken.request.contextSnapshot || null,
        sessionContextMeta: summarizeSessionContextMeta(fallbackContext),
        sessionContextSource: "token_fallback",
        sessionContextView: createSessionContextView(fallbackContext),
        summaryUpdatedAt: null
      };
    }

    return {
      approvalResumeFallbackUsed: false,
      // AGRUN-474/AGRUN-461 — Two-door parity (see above): forward every
      // compaction signal even when the resume hard-fails on the budget error.
      compactionUsage: prepared.compactionUsage || null,
      compactionTurn: prepared.compactionTurn || null,
      compactionError: prepared.compactionError || null,
      error: prepared.error,
      input: {
        ...clonedInput,
        agrunSessionId: sessionId,
        resumeToken: approvalRequest.resumeToken,
        _approvalPreVerified: true
      },
      contextSnapshot: null,
      sessionContextMeta: null,
      sessionContextSource: null,
      sessionContextView: null,
      summaryUpdatedAt: null
    };
  }

  if (fallbackContext) {
    approvalRequest.resumeToken.sessionContextMode = "token_fallback";

    return {
      approvalResumeFallbackUsed: true,
      input: {
        ...clonedInput,
        agrunSessionId: sessionId,
        resumeToken: approvalRequest.resumeToken,
        _approvalPreVerified: true
      },
      contextSnapshot: fallbackSnapshot || null,
      sessionContextMeta: summarizeSessionContextMeta(fallbackContext),
      sessionContextSource: "token_fallback",
      sessionContextView: createSessionContextView(fallbackContext),
      summaryUpdatedAt: null
    };
  }

  return {
    approvalResumeFallbackUsed: false,
    error: createStructuredError(
      ERROR_CODES.APPROVAL_RESOLUTION_ERROR,
      "Approval resume requires a session-backed request context.",
      null,
      "missing_session_context"
    ),
    input: {
      ...clonedInput,
      agrunSessionId: sessionId,
      resumeToken: approvalRequest.resumeToken,
      _approvalPreVerified: true
    },
    contextSnapshot: null,
    sessionContextMeta: null,
    sessionContextSource: null,
    sessionContextView: null,
    summaryUpdatedAt: null
  };
}

function readRequestClone(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? cloneValue(value)
    : null;
}

function readSessionContext(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? cloneValue(value)
    : null;
}

export { prepareSessionApprovalResumeInput };
