import { isQuestionLikeText, isExecutableTopicLikeTurn } from './topic-like-task.js';
import { readString } from './semantic-json.js';

function classifyGoalQuality(currentGoal, currentTopic, options) {
  if (!currentGoal) {
    return {
      goalEqualsTopic: false,
      goalLooksLikeQuestion: false,
      quality: "missing"
    };
  }

  const goalEqualsTopic = normalizeValue(currentGoal) === normalizeValue(currentTopic);
  const goalLooksLikeQuestion = isQuestionLikeText(currentGoal);

  if (goalLooksLikeQuestion || /^Clarify:/i.test(currentGoal)) {
    return {
      goalEqualsTopic,
      goalLooksLikeQuestion: true,
      quality: "question_like"
    };
  }

  if (goalEqualsTopic) {
    if (readExecutionClass(options) === "research_loop" && readTurnIntentKind(options) === "new_task") {
      return {
        goalEqualsTopic,
        goalLooksLikeQuestion,
        quality: "stable"
      };
    }

    // AGRUN-246-D C2.2: a follow-up command on the stable goal/topic is owned by
    // the AI/router turnIntent.kind, not the English action-verb lexicon that
    // formerly classified `options.prompt` (isActionLikeText). new_task is
    // already handled by the research_loop branch above and the executable-topic
    // branch below; approval_resolution by the branch below. This covers the
    // remaining definite-relationship kinds.
    if (readTurnIntentKind(options) === "follow_up" || readTurnIntentKind(options) === "drill_down") {
      return {
        goalEqualsTopic,
        goalLooksLikeQuestion,
        quality: "stable"
      };
    }

    if (readTurnIntentKind(options) === "approval_resolution") {
      return {
        goalEqualsTopic,
        goalLooksLikeQuestion,
        quality: "stable"
      };
    }

    if (isExecutableTopicLikeTurn(
      options && typeof options === "object" ? options.prompt : "",
      options && typeof options === "object" ? options.turnIntent : null
    )) {
      return {
        goalEqualsTopic,
        goalLooksLikeQuestion,
        quality: "stable"
      };
    }

    return {
      goalEqualsTopic,
      goalLooksLikeQuestion,
      quality: "topic_only"
    };
  }
  return {
    goalEqualsTopic,
    goalLooksLikeQuestion,
    quality: "stable"
  };
}

function normalizeValue(value) {
  return readString(value).toLowerCase().replace(/\s+/g, " ");
}

function readTurnIntentKind(options) {
  return readString(
    options &&
    typeof options === "object" &&
    options.turnIntent &&
    typeof options.turnIntent === "object"
      ? options.turnIntent.kind
      : ""
  );
}

function readExecutionClass(options) {
  return readString(
    options &&
    typeof options === "object"
      ? options.executionClass
      : ""
  );
}

export { classifyGoalQuality };
