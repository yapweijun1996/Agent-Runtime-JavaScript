import { buildCurrentTurnParts, isImagePart, readImageBytes, describeImagePart, getReplayImageLimits } from '../runtime/multimodal.js';
import { readSessionParts } from './content.js';

function buildProviderConversation(messages, input, policy) {
  const completedMessages = Array.isArray(messages) ? messages : [];
  const recentMessages = completedMessages.slice(-readPositiveInteger$4(policy && policy.recentMessages, 6));
  const prompt = readPrompt(input);
  const currentParts = buildCurrentTurnParts(prompt, input && input.parts);
  const replaySelection = selectReplayImages(completedMessages, prompt);
  const replayedMessageIds = new Set(replaySelection.replayedMessageIds);
  const imageSourceMessages = completedMessages.filter((message) => (
    replayedMessageIds.has(readString$9(message && message.id)) &&
    !recentMessages.some((entry) => readString$9(entry && entry.id) === readString$9(message && message.id))
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

  const role = readString$9(message.role);
  if (role !== "user" && role !== "assistant") {
    return null;
  }

  const messageId = readString$9(message.id);
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
  const promptText = readString$9(prompt).toLowerCase();
  const explicit = [];
  const fallback = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role !== "user") {
      continue;
    }

    const messageId = readString$9(message.id);
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
  const filename = readString$9(part && part.filename).toLowerCase();
  return Boolean(filename) && Boolean(prompt) && prompt.includes(filename);
}

function comparePromptPriority(left, right) {
  return compareRecentPriority(left, right);
}

function compareRecentPriority(left, right) {
  if (left.createdAt !== right.createdAt) {
    return right.createdAt - left.createdAt;
  }

  return readString$9(right.messageId).localeCompare(readString$9(left.messageId));
}

function createImageKey(part) {
  return describeImagePart(part);
}

function readPrompt(input) {
  return input && typeof input === "object" && typeof input.prompt === "string"
    ? input.prompt
    : "";
}

function readPositiveInteger$4(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function compareCreatedAt(left, right) {
  const leftTime = typeof left.createdAt === "number" ? left.createdAt : 0;
  const rightTime = typeof right.createdAt === "number" ? right.createdAt : 0;

  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return readString$9(left.id).localeCompare(readString$9(right.id));
}

function dedupeMessages(message, index, list) {
  return list.findIndex((entry) => readString$9(entry && entry.id) === readString$9(message && message.id)) === index;
}

function readString$9(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { buildProviderConversation };
