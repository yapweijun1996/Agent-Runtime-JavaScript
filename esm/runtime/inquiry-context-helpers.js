function normalizeAnchorText(value) {
  return readString$1a(value).replace(/[.?!]+$/g, "").trim();
}

function looksLikeAffirmativePrompt(value) {
  return /^(yes|yeah|yep|ok|okay|sure|go ahead|do it|just do it)\b/i.test(readString$1a(value));
}

function inferClarifiedTopic(question) {
  const text = readString$1a(question);
  const directMatch = text.match(/^do you mean\s+(.+?)(?:\s+specifically)?[?]?$/i);

  if (directMatch && directMatch[1]) {
    const candidate = normalizeAnchorText(directMatch[1]);
    if (
      /\bor\b/i.test(candidate) ||
      /\bsomething else\b/i.test(candidate)
    ) {
      return "";
    }
    return candidate;
  }

  return "";
}

function readResolvedInputContext(runState) {
  const inputResolution = runState && typeof runState === "object"
    ? runState.inputResolution
    : null;
  const intentState = inputResolution && typeof inputResolution.intentState === "object"
    ? inputResolution.intentState
    : null;

  if (!intentState) {
    return null;
  }

  return {
    activeGoal: readString$1a(intentState.goal),
    activeQuery: readString$1a(inputResolution && inputResolution.activeQuery),
    activeTopic: readString$1a(intentState.topic),
    continuityKind: "input_resolution",
    hasUserClarification: intentState.hasUserClarification === true,
    lastClarificationResolution: cloneResolution(intentState.lastResolution),
    pendingClarification: clonePendingClarification$1(intentState.pendingClarification),
    turnKind: null
  };
}

function matchClarificationOption(prompt, options) {
  const normalizedPrompt = readString$1a(prompt).toLowerCase();
  const normalizedOptions = Array.isArray(options) ? options : [];

  for (const option of normalizedOptions) {
    const key = readString$1a(option && option.key);
    const text = readString$1a(option && option.text);

    if (!key || !text) {
      continue;
    }

    if (normalizedPrompt === key.toLowerCase() || normalizedPrompt === text.toLowerCase()) {
      return {
        key,
        text
      };
    }
  }

  return null;
}

function matchesClarificationAnswer(prompt, clarifiedTopic) {
  const normalizedPrompt = normalizeAnchorText(prompt).toLowerCase();
  const normalizedTopic = normalizeAnchorText(clarifiedTopic).toLowerCase();

  if (!normalizedPrompt || !normalizedTopic) {
    return false;
  }

  if (normalizedPrompt === normalizedTopic) {
    return true;
  }

  const promptTokens = tokenize$1(normalizedPrompt);
  const topicTokens = tokenize$1(normalizedTopic);
  if (promptTokens.length < 2 || topicTokens.length === 0) {
    return false;
  }

  return promptTokens.every((token) => topicTokens.includes(token));
}

function clonePendingClarification$1(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? {
        ...value
      }
    : null;
}

function cloneResolution(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? {
        ...value
      }
    : null;
}

function countTokenOverlap(left, right) {
  const leftTokens = tokenize$1(left);
  const rightTokens = new Set(tokenize$1(right));
  let overlap = 0;

  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap;
}

function overlapsCurrentDirection(prompt, currentGoal, currentTopic) {
  return (
    countTokenOverlap(prompt, currentGoal) > 0 ||
    countTokenOverlap(prompt, currentTopic) > 0
  );
}

function hasStandaloneTopicAnchor(prompt) {
  return tokenize$1(prompt).length >= 2;
}

function tokenize$1(value) {
  return readString$1a(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function readString$1a(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { clonePendingClarification$1 as clonePendingClarification, cloneResolution, countTokenOverlap, hasStandaloneTopicAnchor, inferClarifiedTopic, looksLikeAffirmativePrompt, matchClarificationOption, matchesClarificationAnswer, normalizeAnchorText, overlapsCurrentDirection, readResolvedInputContext };
