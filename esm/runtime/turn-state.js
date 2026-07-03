import { classifyGoalQuality } from './goal-quality.js';
import { cloneValue } from './utils.js';
import { readString } from './semantic-json.js';

function createTurnState(options) {
  const inputResolution = options && typeof options === "object" ? options.inputResolution : null;
  const intentState = inputResolution && typeof inputResolution.intentState === "object"
    ? inputResolution.intentState
    : null;
  const inquiryContext = options && typeof options === "object" ? options.inquiryContext : null;
  const pendingApprovalAction = readPendingApprovalAction(options && options.pendingApproval);
  const observationSummary = options && typeof options === "object"
    ? options.observationSummary
    : null;
  const turnIntent = options && typeof options === "object" ? options.turnIntent : null;
  const executionClass = options && typeof options === "object"
    ? readString(options.executionClass)
    : "";
  const turnIntentKind = readString(turnIntent && turnIntent.kind);
  const currentPrompt = readString(observationSummary && observationSummary.prompt)
    || readString(options && options.originalQuery)
    || readString(turnIntent && turnIntent.goal);
  const goalAnchorText = turnIntentKind === "new_task" && currentPrompt
    ? currentPrompt
    : readString(intentState && intentState.goal)
    || readString(inquiryContext && inquiryContext.activeGoal);
  // 2026-05-09 — Prefer `researchState.topic` (AI-authored via tool
  // calls) when available; fall through to `intentState.topic` /
  // `inquiryContext.activeTopic` raw values otherwise.
  //
  // The previous AGRUN-214o P4 path used `resolveEntityCandidate` +
  // `looksLikeVerbatimResearchPrompt` (English regex matching
  // "research|investigate|please|...") to collapse verbose prompts
  // down to an extracted entity before injecting "Current topic:"
  // into the planner. That was push-mode anti-pattern: hardcoded
  // English-only heuristic, lite-tier coddling (rewriting AI's
  // input to "help small models"), and runtime semantic decision
  // about what the topic "should" be. Mandarin / non-English users
  // never benefited. AI-first replacement: trust whatever the
  // upstream pipeline produces; AI sees the full original prompt
  // elsewhere via `originalQuery`.
  const researchTopic = readString(
    options && options.runState && options.runState.researchState && options.runState.researchState.topic
  );
  const rawTopic = readString(intentState && intentState.topic)
    || readString(inquiryContext && inquiryContext.activeTopic);
  const topicAnchorText = researchTopic
    || extractStructuralTopic(rawTopic)
    || rawTopic;
  const goalQuality = classifyGoalQuality(
    goalAnchorText,
    topicAnchorText,
    {
      executionClass,
      prompt: readString(observationSummary && observationSummary.prompt),
      turnIntent
    }
  ).quality;

  return {
    candidateSourceCount: Array.isArray(inquiryContext && inquiryContext.candidateSources)
      ? inquiryContext.candidateSources.length
      : 0,
    goalAnchorText,
    goalQuality,
    hasEvidenceSignal: Boolean(intentState && intentState.hasEvidenceSignal),
    hasUserClarification: Boolean(
      intentState && intentState.hasUserClarification
    ) || Boolean(
      inquiryContext &&
      inquiryContext.lastClarificationResolution &&
      typeof inquiryContext.lastClarificationResolution === "object"
    ),
    pendingApprovalAction,
    pendingClarification: cloneStructuredValue$1(
      inquiryContext && inquiryContext.pendingClarification
        ? inquiryContext.pendingClarification
        : intentState && intentState.pendingClarification
    ),
    status: deriveTurnStateStatus(goalQuality, intentState, inquiryContext, pendingApprovalAction, turnIntent),
    topicAnchorText,
    turnIntentKind: turnIntentKind || null
  };
}

function setTurnStateStatus(turnState, status) {
  if (!turnState || typeof turnState !== "object") {
    return;
  }

  turnState.status = readTurnStateStatus(status) || readTurnStateStatus(turnState.status) || "running";
}

function readTurnStateStatus(value) {
  return TURN_STATE_STATUSES.includes(value)
    ? value
    : "";
}

function deriveTurnStateStatus(goalQuality, intentState, inquiryContext, pendingApprovalAction, turnIntent) {
  if (readString(turnIntent && turnIntent.kind) === "approval_resolution") {
    return "running_control_step";
  }

  if (pendingApprovalAction) {
    return "blocked_on_approval";
  }

  if (
    (inquiryContext && inquiryContext.pendingClarification) ||
    (intentState && intentState.pendingClarification)
  ) {
    return "need_clarification";
  }

  if (goalQuality === "stable" && intentState && intentState.hasEvidenceSignal === true) {
    return "ready_to_answer";
  }

  return "running";
}

function readPendingApprovalAction(pendingApproval) {
  if (!pendingApproval || typeof pendingApproval !== "object") {
    return "";
  }

  return readString(pendingApproval.actionName);
}

function cloneStructuredValue$1(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? cloneValue(value)
    : null;
}

function extractStructuralTopic(value) {
  const text = readString(value);
  if (!text) return "";
  const topicPhrase = text.match(/\btopic\s*[:=]?\s*["'“”‘’`]([^"'“”‘’`]{2,160})["'“”‘’`]/i);
  if (topicPhrase) return topicPhrase[1].trim();
  const quoted = text.match(/["'“”‘’`]([^"'“”‘’`]{2,120})["'“”‘’`]/);
  return quoted ? quoted[1].trim() : "";
}

const TURN_STATE_STATUSES = [
  "running",
  "running_control_step",
  "need_clarification",
  "blocked_on_approval",
  "ready_to_answer",
  "done"
];

export { createTurnState, readTurnStateStatus, setTurnStateStatus };
