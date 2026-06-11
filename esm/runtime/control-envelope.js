function startControlEnvelope(runState, kind) {
  if (!runState || typeof runState !== "object") {
    return;
  }

  runState.controlEnvelopeKind = readEnvelopeKind(kind) || null;
  runState.controlEnvelopeConsumed = false;
  runState.requestTypeAfterApproval = null;
}

function consumeControlEnvelope(runState, requestTypeAfterApproval) {
  if (!runState || typeof runState !== "object") {
    return;
  }

  runState.controlEnvelopeConsumed = true;
  runState.requestTypeAfterApproval = readRequestType(requestTypeAfterApproval) || null;
}

function createControlEnvelopeDetail(runState) {
  const kind = readEnvelopeKind(runState && runState.controlEnvelopeKind);
  const consumed = runState && runState.controlEnvelopeConsumed === true;
  const requestType = readRequestType(runState && runState.requestTypeAfterApproval);

  return {
    controlEnvelopeConsumed: consumed,
    controlEnvelopeKind: kind || null,
    requestTypeAfterApproval: consumed
      ? requestType || "none"
      : requestType || null
  };
}

function readEnvelopeKind(value) {
  return value === "approval_resolution"
    ? value
    : "";
}

function readRequestType(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { consumeControlEnvelope, createControlEnvelopeDetail, startControlEnvelope };
