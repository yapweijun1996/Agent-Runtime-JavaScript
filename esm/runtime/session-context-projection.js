import { summarizeReadSourceForDirection } from '../session/context-snapshot-fields.js';

const FINALIZER_CONTEXT_LIMITS = Object.freeze({
  activeQuery: 400,
  compactedContext: 1200,
  currentGoal: 500,
  currentTopic: 300,
  decisions: 1000,
  facts: 1200,
  memory: 800,
  openAmbiguity: 500,
  preferences: 800,
  recentTurns: 1000,
  summary: 1200
});

function projectSessionContextFromPlannerState(sessionContext, plannerState) {
  const context = normalizeContext(sessionContext);

  if (!context) {
    return null;
  }

  const state = plannerState && typeof plannerState === "object" ? plannerState : null;
  if (!state) {
    return context;
  }

  const pendingClarification = hasOwn$3(state, "pendingClarification")
    ? state.pendingClarification
    : context.pendingClarification;
  const lastResolution = hasOwn$3(state, "lastResolution")
    ? state.lastResolution
    : context.lastResolution;
  const clarificationStatus = pendingClarification
    ? "pending"
    : lastResolution
      ? "resolved"
      : "none";

  return {
    ...context,
    activeQuery: readString$1W(state.activeQuery) || context.activeQuery,
    clarificationStatus,
    currentGoal: readString$1W(state.currentGoal) || context.currentGoal,
    currentTopic: readString$1W(state.currentTopic) || context.currentTopic,
    lastResolution,
    openAmbiguity: pendingClarification && typeof pendingClarification.question === "string"
      ? pendingClarification.question
      : "",
    pendingClarification
  };
}

function projectSessionContextForFinalizer(sessionContext, plannerState, options) {
  const context = projectSessionContextFromPlannerState(sessionContext, plannerState);
  if (!context) return null;

  const opts = {};
  const limits = {
    ...FINALIZER_CONTEXT_LIMITS,
    ...(opts.limits && typeof opts.limits === "object" ? opts.limits : {})
  };
  const compacted = {
    activeQuery: capString(context.activeQuery, limits.activeQuery),
    clarificationStatus: context.clarificationStatus,
    compactedContext: capString(context.compactedContext || context.summary, limits.compactedContext),
    currentGoal: capString(context.currentGoal, limits.currentGoal),
    currentTopic: capString(context.currentTopic, limits.currentTopic),
    decisions: capString(context.decisions, limits.decisions),
    facts: capString(context.facts, limits.facts),
    lastReadSource: summarizeReadSourceForDirection(context.lastReadSource, { snippetCharBudget: 360 }),
    lastResolution: compactStructuredValue(context.lastResolution, 600),
    memory: capString(context.memory, limits.memory),
    openAmbiguity: capString(context.openAmbiguity, limits.openAmbiguity),
    pendingClarification: compactStructuredValue(context.pendingClarification, 600),
    preferences: capString(context.preferences, limits.preferences),
    recentTurns: capString(context.recentTurns, limits.recentTurns),
    selectedSource: compactStructuredValue(context.selectedSource, 600),
    summary: context.compactedContext ? "" : capString(context.summary, limits.summary)
  };

  return removeEmptyFields(compacted);
}

function normalizeContext(sessionContext) {
  return sessionContext && typeof sessionContext === "object" ? sessionContext : null;
}

function hasOwn$3(value, key) {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));
}

function readString$1W(value) {
  return typeof value === "string" ? value.trim() : "";
}

function capString(value, maxChars) {
  const text = readString$1W(value);
  if (!text) return "";
  const budget = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : 0;
  if (budget === 0 || text.length <= budget) return text;
  return `${text.slice(0, Math.max(0, budget - 3))}...`;
}

function compactStructuredValue(value, maxChars) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let text = "";
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (!text) return null;
  if (text.length <= maxChars) return value;
  return {
    summary: capString(text, maxChars),
    truncated: true
  };
}

function removeEmptyFields(value) {
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      if (entry.trim()) out[key] = entry;
      continue;
    }
    if (entry && typeof entry === "object") {
      out[key] = entry;
      continue;
    }
    if (entry != null) {
      out[key] = entry;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export { projectSessionContextForFinalizer, projectSessionContextFromPlannerState };
