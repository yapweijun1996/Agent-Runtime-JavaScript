import { cloneValue } from '../runtime/utils.js';
import { normalizeMultimodalParts, describeImagePart, buildCurrentTurnParts } from '../runtime/multimodal.js';

function createUserSessionContent(input) {
  if (typeof input === "string") {
    return { type: "text", text: input };
  }

  if (input && typeof input === "object" && !Array.isArray(input)) {
    const parts = readInputParts$1(input);

    if (parts.length > 0) {
      return {
        type: "parts",
        parts: cloneValue(parts)
      };
    }

    if (typeof input.prompt === "string" && input.prompt.trim().length > 0) {
      return {
        type: "text",
        text: input.prompt.trim()
      };
    }

    return {
      type: "json",
      value: cloneValue(input)
    };
  }

  return {
    type: "text",
    text: String(input)
  };
}

function createAssistantSessionContent(output, error) {
  if (error && typeof error.message === "string" && error.message.trim().length > 0) {
    return {
      error: cloneValue(error),
      text: error.message.trim(),
      type: "text"
    };
  }

  if (typeof output === "string") {
    return { type: "text", text: output };
  }

  if (output && typeof output === "object" && !Array.isArray(output)) {
    if (typeof output.text === "string" && output.text.trim().length > 0) {
      return {
        output: cloneValue(output),
        text: output.text.trim(),
        type: "text"
      };
    }

    return {
      type: "json",
      value: cloneValue(output)
    };
  }

  return {
    type: "json",
    value: cloneValue(output)
  };
}

function stringifySessionContent(content) {
  if (!content || typeof content !== "object") {
    return "";
  }

  if (content.type === "text") {
    return typeof content.text === "string" ? content.text.trim() : "";
  }

  if (content.type === "json") {
    return stableStringify$1(content.value);
  }

  if (content.type === "parts") {
    return stringifyParts(content.parts);
  }

  return "";
}

function readSessionParts(content) {
  if (!content || typeof content !== "object") {
    return [];
  }

  if (content.type === "parts" && Array.isArray(content.parts)) {
    return normalizeMultimodalParts(content.parts);
  }

  if (content.type === "text" && typeof content.text === "string" && content.text.trim()) {
    return [{ type: "text", text: content.text.trim() }];
  }

  return [];
}

function stableStringify$1(value) {
  return JSON.stringify(normalizeStableValue(value));
}

function normalizeStableValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeStableValue);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (Object.prototype.toString.call(value) !== "[object Object]") {
    return value;
  }

  const result = {};
  const keys = Object.keys(value).sort();

  for (const key of keys) {
    result[key] = normalizeStableValue(value[key]);
  }

  return result;
}

function readInputParts$1(input) {
  if (!Array.isArray(input.parts) || input.parts.length === 0) {
    return [];
  }

  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  return buildCurrentTurnParts(prompt, normalizeMultimodalParts(input.parts));
}

function stringifyParts(parts) {
  const list = Array.isArray(parts) ? normalizeMultimodalParts(parts) : [];

  return list
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }

      return `Attached image: ${describeImagePart(part)}`;
    })
    .filter(Boolean)
    .join("\n");
}

export { createAssistantSessionContent, createUserSessionContent, readSessionParts, stableStringify$1 as stableStringify, stringifySessionContent };
