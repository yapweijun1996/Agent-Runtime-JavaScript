import { requestSemanticJudge } from './semantic-judge.js';
import { readString, readArray, readBoolean, readObject } from './semantic-json.js';

async function requestSemanticRecall(request) {
  const systemPrompt = [
    "You are the session recall judge for agrun.js.",
    "Decide whether the latest user message can be answered only from confirmed session memory.",
    "Return JSON only.",
    'Output keys: answerFromMemory, answer, shouldContinueToPlanner, supportingItems.',
    "supportingItems must be an array of { kind, slot, text } objects."
  ].join("\n");
  const prompt = buildRecallPrompt(request);
  const { response, text, value } = await requestSemanticJudge(request, {
    prompt,
    systemPrompt
  });

  return {
    response,
    text,
    value: normalizeRecallValue(value)
  };
}

function createSemanticRecallDecision(value) {
  if (!value || value.answerFromMemory !== true || !value.answer) {
    return null;
  }

  return {
    answer: value.answer,
    citations: ["session_memory"],
    reasoning: "answered from session memory",
    type: "final"
  };
}

function createSessionRecallResponse() {
  return {
    endpoint: null,
    finishReason: "session_memory",
    raw: null,
    requestBody: null,
    status: 200,
    text: "",
    usage: null
  };
}

function buildRecallPrompt(request) {
  return [
    "Latest user prompt:",
    readString(request && request.prompt) || "None",
    "",
    "Session context:",
    JSON.stringify(request && request.sessionContext ? request.sessionContext : null, null, 2)
  ].join("\n");
}

function normalizeRecallValue(value) {
  const record = readObject(value) || {};
  const answer = readString(record.answer);

  return {
    answer,
    answerFromMemory: readBoolean(record.answerFromMemory, false) && Boolean(answer),
    shouldContinueToPlanner: readBoolean(record.shouldContinueToPlanner, !answer),
    supportingItems: readArray(record.supportingItems)
      .map((item) => normalizeSupportingItem(item))
      .filter(Boolean)
  };
}

function normalizeSupportingItem(value) {
  const record = readObject(value);

  if (!record) {
    return null;
  }

  const kind = readString(record.kind);
  const text = readString(record.text);
  if (!kind || !text) {
    return null;
  }

  return {
    kind,
    slot: readString(record.slot) || null,
    text
  };
}

export { createSemanticRecallDecision, createSessionRecallResponse, requestSemanticRecall };
