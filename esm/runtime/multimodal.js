const CURRENT_IMAGE_LIMITS = {
  maxCount: 4,
  maxSingleBytes: 5 * 1024 * 1024,
  maxTotalBytes: 12 * 1024 * 1024
};

const REPLAY_IMAGE_LIMITS = {
  maxCount: 6,
  maxTotalBytes: 15 * 1024 * 1024
};

function getCurrentImageLimits() {
  return { ...CURRENT_IMAGE_LIMITS };
}

function getReplayImageLimits() {
  return { ...REPLAY_IMAGE_LIMITS };
}

function normalizeMultimodalParts(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(normalizeMultimodalPart)
    .filter(Boolean);
}

function buildCurrentTurnParts(prompt, parts) {
  const normalizedPrompt = readString$1P(prompt);
  const normalizedParts = normalizeMultimodalParts(parts);
  const imageAndExtraParts = normalizedParts.filter((part) => (
    part.type === "image" ||
    (part.type === "text" && part.text !== normalizedPrompt)
  ));

  if (normalizedPrompt) {
    return [{ type: "text", text: normalizedPrompt }, ...imageAndExtraParts];
  }

  return imageAndExtraParts;
}

function validateImageParts(parts, limits) {
  const config = {
    ...CURRENT_IMAGE_LIMITS,
    ...(limits && typeof limits === "object" ? limits : {})
  };
  const images = normalizeMultimodalParts(parts).filter(isImagePart);

  if (images.length > config.maxCount) {
    return `Only ${config.maxCount} images can be sent in one request.`;
  }

  let totalBytes = 0;

  for (const image of images) {
    const bytes = readImageBytes(image);

    if (bytes > config.maxSingleBytes) {
      return `${readImageLabel(image)} is too large. Maximum size is ${formatBytes(config.maxSingleBytes)}.`;
    }

    totalBytes += bytes;
  }

  if (totalBytes > config.maxTotalBytes) {
    return `Selected images are too large. Maximum total size is ${formatBytes(config.maxTotalBytes)}.`;
  }

  return "";
}

function isImagePart(part) {
  return Boolean(part) && typeof part === "object" && part.type === "image";
}

function readImageBytes(part) {
  if (!isImagePart(part)) {
    return 0;
  }

  if (typeof part.bytes === "number" && Number.isFinite(part.bytes) && part.bytes > 0) {
    return Math.floor(part.bytes);
  }

  const dataUrl = parseDataUrl(part.url);
  return dataUrl ? estimateBase64Bytes(dataUrl.data) : 0;
}

function describeImagePart(part) {
  if (!isImagePart(part)) {
    return "";
  }

  const label = readImageLabel(part);
  const mimeType = readString$1P(part.mimeType) || "image/*";
  const bytes = readImageBytes(part);
  return bytes > 0
    ? `${label} (${mimeType}, ${bytes} bytes)`
    : `${label} (${mimeType})`;
}

function parseDataUrl(value) {
  const source = readString$1P(value);
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/i.exec(source);

  if (!match) {
    return null;
  }

  return {
    data: match[2],
    mimeType: readString$1P(match[1]) || "application/octet-stream"
  };
}

function normalizeMultimodalPart(part) {
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    return null;
  }

  if (part.type === "text") {
    const text = readString$1P(part.text);
    return text ? { type: "text", text } : null;
  }

  if (part.type === "image") {
    const url = readString$1P(part.url);
    const mimeType = readString$1P(part.mimeType);

    if (!url || !mimeType) {
      return null;
    }

    return {
      type: "image",
      url,
      mimeType,
      filename: readOptionalString$2(part.filename),
      bytes: readPositiveNumber$3(part.bytes)
    };
  }

  return null;
}

function readImageLabel(part) {
  return readString$1P(part && part.filename) || "Image";
}

function estimateBase64Bytes(data) {
  const text = readString$1P(data);

  if (!text) {
    return 0;
  }

  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return Math.floor((text.length * 3) / 4) - padding;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
}

function readOptionalString$2(value) {
  const text = readString$1P(value);
  return text || null;
}

function readPositiveNumber$3(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function readString$1P(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { buildCurrentTurnParts, describeImagePart, getCurrentImageLimits, getReplayImageLimits, isImagePart, normalizeMultimodalParts, parseDataUrl, readImageBytes, validateImageParts };
