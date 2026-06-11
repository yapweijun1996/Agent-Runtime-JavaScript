import { normalizeInquiryContext, createContextSnapshot } from '../session/context-snapshot-normalize.js';
import { refreshProjectedSessionContext } from './session-context-state.js';
import { looksLikeTopicPrompt } from './topic-like-task.js';
import { readResolvedInputContext, cloneResolution, clonePendingClarification, normalizeAnchorText, looksLikeAffirmativePrompt, inferClarifiedTopic, matchesClarificationAnswer, matchClarificationOption, countTokenOverlap, hasStandaloneTopicAnchor, overlapsCurrentDirection } from './inquiry-context-helpers.js';

function resolvePromptInquiryContext(inquiryContext, prompt, options) {
  const context = normalizeInquiryContext(inquiryContext);
  const normalizedPrompt = normalizeAnchorText(prompt);
  if (!normalizedPrompt) {
    return {
      activeGoal: readString$19(context.activeGoal),
      activeQuery: readString$19(context.activeQuery),
      activeTopic: readString$19(context.activeTopic),
      continuityKind: "preserve",
      hasUserClarification: false,
      lastClarificationResolution: cloneResolution(context.lastClarificationResolution),
      pendingClarification: clonePendingClarification(context.pendingClarification),
      turnKind: "unknown"
    };
  }

  const currentGoal = readString$19(context.activeGoal);
  const currentQuery = readString$19(context.activeQuery);
  const currentTopic = readString$19(context.activeTopic);
  const pendingClarification = context.pendingClarification && typeof context.pendingClarification === "object"
    ? context.pendingClarification
    : null;
  const turnIntent = options && typeof options === "object" && options.turnIntent
    && typeof options.turnIntent === "object"
    ? options.turnIntent
    : null;
  const turnIntentKind = readString$19(turnIntent && turnIntent.kind);

  if (turnIntentKind === "new_task") {
    return {
      activeGoal: normalizedPrompt,
      activeQuery: normalizedPrompt,
      activeTopic: normalizedPrompt,
      continuityKind: "upstream_new_task",
      hasUserClarification: false,
      lastClarificationResolution: null,
      pendingClarification: null,
      turnKind: "new_task"
    };
  }

  if (pendingClarification && looksLikeAffirmativePrompt(normalizedPrompt)) {
    const clarifiedTopic = inferClarifiedTopic(pendingClarification.question);

    if (clarifiedTopic) {
      return {
        activeGoal: currentGoal || normalizedPrompt,
        activeQuery: clarifiedTopic || currentQuery || normalizedPrompt,
        activeTopic: clarifiedTopic || currentTopic || normalizedPrompt,
        continuityKind: "clarification_confirm",
        hasUserClarification: true,
        lastClarificationResolution: {
          kind: "confirm",
          sourceTurn: "current_input",
          value: true
        },
        pendingClarification: null,
        turnKind: "follow_up"
      };
    }

    return {
      activeGoal: currentGoal || normalizedPrompt,
      activeQuery: currentQuery || currentTopic || normalizedPrompt,
      activeTopic: currentTopic || currentGoal || normalizedPrompt,
      continuityKind: "clarification_acknowledged",
      hasUserClarification: true,
      lastClarificationResolution: cloneResolution(context.lastClarificationResolution),
      pendingClarification: clonePendingClarification(context.pendingClarification),
      turnKind: "follow_up"
    };
  }

  if (pendingClarification) {
    const clarifiedTopic = inferClarifiedTopic(pendingClarification.question);

    if (clarifiedTopic && matchesClarificationAnswer(normalizedPrompt, clarifiedTopic)) {
      return {
        activeGoal: currentGoal || normalizedPrompt,
        activeQuery: clarifiedTopic || currentQuery || normalizedPrompt,
        activeTopic: clarifiedTopic || currentTopic || normalizedPrompt,
        continuityKind: "clarification_explicit_answer",
        hasUserClarification: true,
        lastClarificationResolution: {
          kind: "explicit_answer",
          sourceTurn: "current_input",
          value: normalizedPrompt
        },
        pendingClarification: null,
        turnKind: "follow_up"
      };
    }

    const selectedOption = matchClarificationOption(normalizedPrompt, pendingClarification.options);

    if (selectedOption) {
      return {
        activeGoal: selectedOption.text,
        activeQuery: currentQuery || currentTopic || selectedOption.text,
        activeTopic: currentTopic || selectedOption.text,
        continuityKind: "clarification_option_select",
        hasUserClarification: true,
        lastClarificationResolution: {
          kind: "option_select",
          sourceTurn: "current_input",
          value: selectedOption.key
        },
        pendingClarification: null,
        turnKind: "follow_up"
      };
    }
  }

  if (
    pendingClarification &&
    !looksLikeAffirmativePrompt(normalizedPrompt) &&
    looksLikeTopicPrompt(normalizedPrompt) &&
    countTokenOverlap(normalizedPrompt, pendingClarification.question) === 0 &&
    hasStandaloneTopicAnchor(normalizedPrompt)
  ) {
    return {
      activeGoal: normalizedPrompt,
      activeQuery: normalizedPrompt,
      activeTopic: normalizedPrompt,
      continuityKind: "clarification_breakout",
      hasUserClarification: false,
      lastClarificationResolution: null,
      pendingClarification: null,
      turnKind: "new_task"
    };
  }

  if (
    currentGoal &&
    looksLikeTopicPrompt(normalizedPrompt) &&
    overlapsCurrentDirection(normalizedPrompt, currentGoal, currentTopic)
  ) {
    return {
      activeGoal: currentGoal,
      activeQuery: normalizedPrompt,
      activeTopic: normalizedPrompt,
      continuityKind: "topic_refinement",
      hasUserClarification: false,
      lastClarificationResolution: cloneResolution(context.lastClarificationResolution),
      pendingClarification: clonePendingClarification(context.pendingClarification),
      turnKind: "follow_up"
    };
  }

  // AGRUN-246-K: follow-up continuity is AI-owned, not lexicon-derived.
  //
  // We reach here when an ongoing session has a prior topic, the turn is not an
  // AI-declared new_task (handled at the top), not a clarification flow, and
  // shares no token overlap with the current direction (topic_refinement above
  // already caught overlapping follow-ups). The old code used an English
  // action-verb lexicon (isActionLikeText) to guess "is this a follow-up
  // command?" — preserve the prior topic if so, else reset. That lexicon was
  // i18n-broken (it preserved continuity only for English commands; Mandarin /
  // non-English / indirect follow-ups silently reset to the bare prompt) and it
  // stood in for a SEMANTIC judgement the AI owns.
  //
  // With a prior topic present we PRESERVE it by default (continuityKind
  // "follow_up_command"): the active goal still anchors to the new prompt so the
  // task is pursued correctly, while activeQuery/activeTopic keep the
  // conversation's subject — the common, conversational case. A genuine no-
  // overlap topic switch (structurally indistinguishable from a follow-up
  // command without a lexicon) is the AI's call: when a classifier is configured
  // it emits turnIntent.kind === "new_task" and resets at the top; in a no-
  // classifier run the prior topic lags one turn and recovers via
  // topic_refinement. Continuity is now language-neutral. See ADR-0047.
  if (currentTopic) {
    return {
      activeGoal: normalizedPrompt,
      activeQuery: currentQuery || currentTopic,
      activeTopic: currentTopic,
      continuityKind: "follow_up_command",
      hasUserClarification: false,
      lastClarificationResolution: cloneResolution(context.lastClarificationResolution),
      pendingClarification: clonePendingClarification(context.pendingClarification),
      turnKind: "follow_up"
    };
  }

  // First turn / no prior topic to preserve — anchor everything to the prompt.
  return {
    activeGoal: normalizedPrompt,
    activeQuery: normalizedPrompt,
    activeTopic: normalizedPrompt,
    continuityKind: "prompt_anchor",
    hasUserClarification: false,
    lastClarificationResolution: null,
    pendingClarification: null,
    turnKind: "new_task"
  };
}

function syncPromptInquiryContext(runState, request, options) {
  const prompt = readString$19(request && request.prompt);

  if (!runState || !prompt || readString$19(request && request.type) === "approval_resolution") {
    return;
  }

  const snapshot = ensureContextSnapshot$1(runState);
  const inquiryContext = normalizeInquiryContext(snapshot.inquiryContext);
  const resolved = readResolvedInputContext(runState)
    || resolvePromptInquiryContext(inquiryContext, prompt);

  inquiryContext.activeGoal = resolved.activeGoal || inquiryContext.activeGoal;
  inquiryContext.activeQuery = resolved.activeQuery || inquiryContext.activeQuery;
  inquiryContext.activeTopic = resolved.activeTopic || inquiryContext.activeTopic;
  inquiryContext.lastClarificationResolution = cloneResolution(
    resolved.lastClarificationResolution
  );

  if (!(options && options.preservePendingClarification === true)) {
    inquiryContext.pendingClarification = clonePendingClarification(
      resolved.pendingClarification
    );
  }

  runState.contextSnapshot = createContextSnapshot({
    ...snapshot,
    inquiryContext
  });
  refreshProjectedSessionContext(runState);
}

function ensureContextSnapshot$1(runState) {
  if (runState.contextSnapshot) {
    return createContextSnapshot(runState.contextSnapshot);
  }

  const snapshot = createContextSnapshot({});
  runState.contextSnapshot = snapshot;
  return snapshot;
}

function readString$19(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { resolvePromptInquiryContext, syncPromptInquiryContext };
