import { isQuestionLikeText } from './topic-like-task.js';

const RESOLVED_KINDS = new Set(["confirm", "explicit_answer", "option_select"]);

function deriveClarificationStatus(pendingClarification, lastResolution, fallbackStatus) {
  if (isPendingClarification(pendingClarification)) {
    return "pending";
  }

  if (isResolvedResolution(lastResolution)) {
    return "resolved";
  }

  return readClarificationStatus(fallbackStatus);
}

function deriveOpenAmbiguity(pendingClarification) {
  return isPendingClarification(pendingClarification)
    ? readString$1d(pendingClarification.question)
    : "";
}

function deriveAmbiguityState(options) {
  const clarificationStatus = deriveClarificationStatus(
    options && options.pendingClarification,
    options && options.lastResolution,
    options && options.fallbackClarificationStatus
  );

  if (clarificationStatus === "resolved") {
    return "resolved";
  }

  if (clarificationStatus !== "pending") {
    return "none";
  }

  if (
    readString$1d(options && options.currentGoal).length === 0 ||
    readString$1d(options && options.currentTopic).length === 0 ||
    readString$1d(options && options.goalQuality) !== "stable"
  ) {
    return "unresolved";
  }

  if (readString$1d(options && options.evidenceState) !== "none") {
    return "inferable";
  }

  if (readString$1d(options && options.promptSignal) !== "low") {
    return "unresolved";
  }

  if (readString$1d(options && options.semanticHint) === "inferable") {
    return "inferable";
  }

  const question = deriveOpenAmbiguity(options && options.pendingClarification);
  if (hasOptionStyleAmbiguity(question)) {
    return "inferable";
  }

  return "unresolved";
}

function detectClarificationLoopRisk(options) {
  if (readString$1d(options && options.actionName) !== "ask_clarification") {
    return false;
  }

  const clarificationStatus = deriveClarificationStatus(
    options && options.pendingClarification,
    options && options.lastResolution,
    options && options.clarificationStatus
  );
  if (clarificationStatus === "resolved") {
    return true;
  }

  const question = deriveOpenAmbiguity(options && options.pendingClarification);
  if (!question) {
    return false;
  }

  const currentGoal = readString$1d(options && options.currentGoal);
  const currentTopic = readString$1d(options && options.currentTopic);
  if (!currentGoal || !currentTopic) {
    return false;
  }

  const stats = readRecentTurnStats(options && options.recentTurns);
  const repeatedClarification = (
    hasOptionStyleAmbiguity(question) ||
    (
      (stats.assistantQuestions >= 2 && stats.lowSignalUserTurns >= 1) ||
      (stats.assistantQuestions >= 1 && stats.lowSignalUserTurns >= 2)
    )
  );

  if (readString$1d(options && options.promptSignal) !== "low" || !repeatedClarification) {
    return false;
  }

  if (deriveAmbiguityState(options) === "inferable") {
    return true;
  }

  return readString$1d(options && options.evidenceState) !== "none";
}

function isPendingClarification(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    readString$1d(value.question)
  );
}

function isResolvedResolution(value) {
  const kind = readString$1d(value && value.kind);
  return RESOLVED_KINDS.has(kind);
}

function readClarificationStatus(value) {
  const text = readString$1d(value);
  return text === "resolved" ? "resolved" : "none";
}

function readRecentTurnStats(text) {
  const lines = readString$1d(text)
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  let assistantQuestions = 0;
  let lowSignalUserTurns = 0;

  for (const line of lines) {
    const userMatch = line.match(/^User:\s+(.+)$/i);
    if (userMatch) {
      if (isLowSignalText(userMatch[1])) {
        lowSignalUserTurns += 1;
      }
      continue;
    }

    const assistantMatch = line.match(/^Assistant:\s+(.+)$/i);
    if (assistantMatch && isQuestionLikeText(assistantMatch[1])) {
      assistantQuestions += 1;
    }
  }

  return {
    assistantQuestions,
    lowSignalUserTurns
  };
}

function hasOptionStyleAmbiguity(value) {
  return /\([A-Z]\)/.test(readString$1d(value));
}

function isLowSignalText(value) {
  const text = trimTrailingPunctuation$1(value).toLowerCase();
  return !text || text.length <= 3 || /^(yes|no|ok|okay|sure|yep|yup|nah|all|more)$/i.test(text);
}

function trimTrailingPunctuation$1(value) {
  return readString$1d(value).replace(/[.?!]+$/g, "").trim();
}

function readString$1d(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { deriveAmbiguityState, deriveClarificationStatus, deriveOpenAmbiguity, detectClarificationLoopRisk };
