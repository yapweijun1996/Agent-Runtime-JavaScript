import { buildCurrentTurnParts, isImagePart, readImageBytes, describeImagePart, getReplayImageLimits } from '../runtime/multimodal.js';
import { readSessionParts } from './content.js';
import { readString } from '../runtime/semantic-json.js';

function buildProviderConversation(messages, input, policy) {
  const completedMessages = Array.isArray(messages) ? messages : [];
  // AGRUN-586 — carry EVERY message the caller passes (the post-summary,
  // uncompacted window). The old fixed slice(-recentMessages) silently dropped
  // anything older than 3 exchanges even though no summary covered it, so a
  // turn-2 fact was unrecallable by turn 6 on every provider. Growth is bounded
  // by the token-budget compaction trigger, which now counts the conversation;
  // `policy.recentMessages` keeps its real meaning — the verbatim tail
  // preserved when compaction summarizes older turns.
  const recentMessages = completedMessages;
  const prompt = readPrompt(input);
  const currentParts = buildCurrentTurnParts(prompt, input && input.parts);
  const replaySelection = selectReplayImages(completedMessages, prompt);
  const replayedMessageIds = new Set(replaySelection.replayedMessageIds);
  const imageSourceMessages = completedMessages.filter((message) => (
    replayedMessageIds.has(readString(message && message.id)) &&
    !recentMessages.some((entry) => readString(entry && entry.id) === readString(message && message.id))
  ));
  const sourceMessages = [...imageSourceMessages, ...recentMessages]
    .sort(compareCreatedAt)
    .filter(dedupeMessages);
  const conversation = sourceMessages
    .map((message) => createConversationMessage(message, replaySelection.byMessageId))
    .filter(Boolean);

  return {
    conversation,
    currentParts,
    summary: {
      omittedImages: replaySelection.omittedCount,
      replayedImages: replaySelection.replayedCount
    }
  };
}

function createConversationMessage(message, byMessageId) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const role = readString(message.role);
  if (role !== "user" && role !== "assistant") {
    return null;
  }

  const messageId = readString(message.id);
  const contentParts = readSessionParts(message.content);
  const selectedKeys = byMessageId.get(messageId) || new Set();
  const parts = contentParts
    .map((part) => {
      if (part.type !== "image") {
        return part;
      }

      return selectedKeys.has(createImageKey(part)) ? part : null;
    })
    .filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  return {
    parts,
    role
  };
}

function selectReplayImages(messages, prompt) {
  const limits = getReplayImageLimits();
  const promptText = readString(prompt).toLowerCase();
  const explicit = [];
  const fallback = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role !== "user") {
      continue;
    }

    const messageId = readString(message.id);
    const parts = readSessionParts(message.content).filter(isImagePart);

    for (const part of parts) {
    const candidate = {
      bytes: readImageBytes(part),
      createdAt: typeof message.createdAt === "number" ? message.createdAt : 0,
      key: createImageKey(part),
      messageId,
      part
      };

      if (matchesFilename(candidate.part, promptText)) {
        explicit.push(candidate);
      } else {
        fallback.push(candidate);
      }
    }
  }

  const ordered = [
    ...explicit.sort(comparePromptPriority),
    ...fallback.sort(compareRecentPriority)
  ];
  const byMessageId = new Map();
  let replayedCount = 0;
  let omittedCount = 0;
  let totalBytes = 0;

  for (const candidate of ordered) {
    if (
      replayedCount >= limits.maxCount ||
      totalBytes + candidate.bytes > limits.maxTotalBytes
    ) {
      omittedCount += 1;
      continue;
    }

    const set = byMessageId.get(candidate.messageId) || new Set();
    set.add(candidate.key);
    byMessageId.set(candidate.messageId, set);
    replayedCount += 1;
    totalBytes += candidate.bytes;
  }

  return {
    byMessageId,
    omittedCount,
    replayedCount,
    replayedMessageIds: Array.from(byMessageId.keys())
  };
}

function matchesFilename(part, prompt) {
  const filename = readString(part && part.filename).toLowerCase();
  return Boolean(filename) && Boolean(prompt) && prompt.includes(filename);
}

function comparePromptPriority(left, right) {
  return compareRecentPriority(left, right);
}

function compareRecentPriority(left, right) {
  if (left.createdAt !== right.createdAt) {
    return right.createdAt - left.createdAt;
  }

  return readString(right.messageId).localeCompare(readString(left.messageId));
}

function createImageKey(part) {
  return describeImagePart(part);
}

function readPrompt(input) {
  return input && typeof input === "object" && typeof input.prompt === "string"
    ? input.prompt
    : "";
}

function compareCreatedAt(left, right) {
  const leftTime = typeof left.createdAt === "number" ? left.createdAt : 0;
  const rightTime = typeof right.createdAt === "number" ? right.createdAt : 0;

  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return readString(left.id).localeCompare(readString(right.id));
}

function dedupeMessages(message, index, list) {
  return list.findIndex((entry) => readString(entry && entry.id) === readString(message && message.id)) === index;
}

export { buildProviderConversation };
