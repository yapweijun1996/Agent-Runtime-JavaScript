import { stringifySessionContent } from './content.js';

function buildAnchoredRecentTurns(messages, inquiryContext, options) {
  const turns = buildTurns(messages);
  const maxTurns = readPositiveInteger$6(options && options.maxTurns, 0);
  const minTurns = readPositiveInteger$6(options && options.minTurns, 1);

  if (turns.length === 0) {
    return [];
  }

  const latestIndex = turns.length - 1;
  const anchors = new Set([latestIndex]);
  const anchorTexts = collectAnchorTexts(inquiryContext, options && options.anchorSignals);

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (matchesAnchor(turns[index], anchorTexts)) {
      anchors.add(index);
    }
  }

  const selected = [...anchors].sort((left, right) => left - right);
  const targetCount = Math.max(minTurns, maxTurns);

  for (let index = turns.length - 1; index >= 0 && selected.length < targetCount; index -= 1) {
    if (!anchors.has(index)) {
      selected.unshift(index);
    }
  }

  return selected.map((index) => turns[index]);
}

function renderTurns(turns) {
  return (Array.isArray(turns) ? turns : [])
    .map((turn, index) => {
      const lines = [`Turn ${index + 1}:`];

      if (turn.user) {
        lines.push(`User: ${turn.user}`);
      }

      for (const assistantText of Array.isArray(turn.assistant) ? turn.assistant : []) {
        lines.push(`Assistant: ${assistantText}`);
      }

      return lines.join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function buildTurns(messages) {
  const turns = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }

    const text = stringifySessionContent(message.content).trim();

    if (!text) {
      continue;
    }

    if (message.role === "user" || turns.length === 0) {
      turns.push({
        assistant: message.role === "assistant" ? [text] : [],
        user: message.role === "user" ? text : ""
      });
      continue;
    }

    turns[turns.length - 1].assistant.push(text);
  }

  return turns;
}

function collectAnchorTexts(inquiryContext, anchorSignals) {
  const context = inquiryContext && typeof inquiryContext === "object" ? inquiryContext : {};
  const signals = Array.isArray(anchorSignals) ? anchorSignals : [];
  const values = [];

  for (const signal of signals) {
    if (signal === "activeGoal") {
      values.push(context.activeGoal);
    } else if (signal === "activeTopic") {
      values.push(context.activeTopic);
    } else if (signal === "pendingClarification") {
      values.push(context.pendingClarification && context.pendingClarification.question);
    } else if (signal === "lastResolution") {
      values.push(readResolutionText(context.lastClarificationResolution));
    } else if (signal === "selectedSource") {
      values.push(context.selectedSource && context.selectedSource.title);
      values.push(context.selectedSource && context.selectedSource.url);
      values.push(context.lastReadSource && context.lastReadSource.title);
      values.push(context.lastReadSource && context.lastReadSource.url);
    }
  }

  return values
    .map(readString$b)
    .filter(Boolean)
    .map((value) => value.toLowerCase());
}

function matchesAnchor(turn, anchorTexts) {
  const haystack = [turn.user, ...(Array.isArray(turn.assistant) ? turn.assistant : [])]
    .map(readString$b)
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  return anchorTexts.some((text) => haystack.includes(text));
}

function readResolutionText(value) {
  if (!value || typeof value !== "object") {
    return "";
  }

  if (typeof value.value === "string") {
    return value.value.trim();
  }

  return typeof value.kind === "string" ? value.kind.trim() : "";
}

function readPositiveInteger$6(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readString$b(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { buildAnchoredRecentTurns, renderTurns };
