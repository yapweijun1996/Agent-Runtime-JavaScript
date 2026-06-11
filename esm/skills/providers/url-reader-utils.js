const DEFAULT_READ_URL_TIMEOUT_MS = 10000;
const DEFAULT_READ_URL_MAX_BYTES = 200000;
const READ_URL_SUPPORTED_METHODS = Object.freeze(["GET", "HEAD"]);
const HTML_ENTITY_MAP = Object.freeze({ amp: "&", gt: ">", lt: "<", mdash: "-", nbsp: " ", quot: '"', rsquo: "'", "#39": "'" });
const NON_CONTENT_TAGS = Object.freeze(["script", "style", "noscript", "template", "svg", "iframe", "form", "dialog"]);
const BOILERPLATE_TAGS = Object.freeze(["nav", "header", "footer", "aside"]);
const SEMANTIC_INCLUDE_KEYWORDS = Object.freeze(["article", "body", "content", "entry", "main", "post", "story"]);
const SEMANTIC_EXCLUDE_KEYWORDS = Object.freeze(["ads", "advert", "breadcrumb", "comment", "footer", "header", "menu", "nav", "promo", "related", "share", "sidebar", "social", "subscribe"]);

function resolveFetch$5(fetchImpl) {
  if (typeof fetchImpl === "function") {
    return fetchImpl;
  }

  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }

  throw new Error("A fetch implementation is required for read_url.");
}

function normalizeHttpUrl(value) {
  const text = typeof value === "string" ? value.trim() : "";

  if (!text) {
    return "";
  }

  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

function normalizeReadUrlMethod(value) {
  const method = typeof value === "string" ? value.trim().toUpperCase() : "";
  return READ_URL_SUPPORTED_METHODS.includes(method) ? method : "";
}

function normalizeReadUrlMode(value) {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return mode === "text" || mode === "html_text" || mode === "json" || mode === "auto"
    ? mode
    : "auto";
}

function normalizePositiveInteger$5(value, fallbackValue) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallbackValue;
}

function normalizeHeaders$2(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const entries = Object.entries(value)
    .filter(([key, entryValue]) => typeof key === "string" && key.trim() && typeof entryValue === "string");

  return Object.fromEntries(entries.map(([key, entryValue]) => [key, entryValue.trim()]));
}

function readContentType(headers) {
  if (!headers || typeof headers.get !== "function") {
    return "";
  }

  return typeof headers.get("content-type") === "string"
    ? headers.get("content-type").trim().toLowerCase()
    : "";
}

function readHeaderValue(headers, name) {
  if (!headers || typeof headers.get !== "function" || typeof name !== "string" || !name.trim()) {
    return "";
  }

  const value = headers.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function isJsonContentType(contentType) {
  return contentType.includes("application/json") || contentType.endsWith("+json");
}

function isHtmlContentType(contentType) {
  return contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
}

function isTextLikeContentType(contentType) {
  if (!contentType) {
    return true;
  }

  return contentType.startsWith("text/") ||
    isJsonContentType(contentType) ||
    isHtmlContentType(contentType) ||
    contentType.includes("application/xml") ||
    contentType.endsWith("+xml");
}

function deriveReadMode(requestedMode, contentType) {
  if (requestedMode && requestedMode !== "auto") {
    return requestedMode;
  }

  if (isJsonContentType(contentType)) {
    return "json";
  }

  if (isHtmlContentType(contentType)) {
    return "html_text";
  }

  return "text";
}

function buildAcceptHeader(mode) {
  if (mode === "json") {
    return "application/json, text/plain;q=0.8, */*;q=0.5";
  }

  if (mode === "html_text") {
    return "text/html, application/xhtml+xml, text/plain;q=0.8, */*;q=0.5";
  }

  return "text/plain, text/html;q=0.8, application/json;q=0.6, */*;q=0.5";
}

function extractReadableHtmlText(html) {
  const source = stripBlockTags(stripHtmlComments(typeof html === "string" ? html : ""), NON_CONTENT_TAGS);
  if (!source) {
    return "";
  }

  const candidates = [
    extractFirstTagBlock(source, "article"),
    extractFirstTagBlock(source, "main"),
    extractBestSemanticContainer(source),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const text = htmlToText(stripBlockTags(candidate, BOILERPLATE_TAGS));
    if (text) {
      return text;
    }
  }

  return "";
}

function htmlToText(html) {
  const source = typeof html === "string" ? html : "";
  if (!source) {
    return "";
  }
  const normalized = stripBlockTags(stripHtmlComments(source), NON_CONTENT_TAGS)
    .replace(/<(?:br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(?:article|blockquote|div|h[1-6]|li|main|ol|p|pre|section|table|td|th|tr|ul)>/gi, "\n")
    .replace(/<(?:article|blockquote|div|h[1-6]|li|main|ol|p|pre|section|table|td|th|tr|ul)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeHtmlEntities(normalized)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function stripHtmlComments(html) {
  return typeof html === "string"
    ? html.replace(/<!--[\s\S]*?-->/g, " ")
    : "";
}

function stripBlockTags(html, tagNames) {
  return tagNames.reduce((current, tagName) => (
    current.replace(new RegExp(`<${tagName}\\b[\\s\\S]*?<\\/${tagName}>`, "gi"), " ")
  ), html);
}

function extractFirstTagBlock(html, tagName) {
  const match = new RegExp(`<${tagName}\\b[^>]*>`, "i").exec(html);
  return match ? extractTagBlockAt(html, tagName, match.index) : "";
}

function extractBestSemanticContainer(html) {
  const pattern = /<(div|section)\b([^>]*)>/gi;
  let bestBlock = "";
  let bestScore = 0;

  while (true) {
    const match = pattern.exec(html);
    if (!match) {
      return bestBlock;
    }
    const score = scoreSemanticAttributes(match[2]);
    if (score <= 0) {
      continue;
    }
    const block = extractTagBlockAt(html, match[1].toLowerCase(), match.index);
    if (!block) {
      continue;
    }
    const text = htmlToText(stripBlockTags(block, BOILERPLATE_TAGS));
    if (!text) {
      continue;
    }
    const weightedScore = score + Math.min(text.length, 4000) / 4000;
    if (weightedScore > bestScore) {
      bestBlock = block;
      bestScore = weightedScore;
    }
  }
}

function extractTagBlockAt(html, tagName, startIndex) {
  const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "gi");
  tagPattern.lastIndex = startIndex;
  let depth = 0;
  let started = false;

  while (true) {
    const match = tagPattern.exec(html);
    if (!match) {
      return started ? html.slice(startIndex) : "";
    }

    if (!started) {
      if (match.index !== startIndex) {
        return "";
      }
      started = true;
      if (/\/>$/.test(match[0])) {
        return match[0];
      }
      depth = 1;
      continue;
    }

    if (/^<\//.test(match[0])) {
      depth -= 1;
    } else if (!/\/>$/.test(match[0])) {
      depth += 1;
    }

    if (depth <= 0) {
      return html.slice(startIndex, tagPattern.lastIndex);
    }
  }
}

function scoreSemanticAttributes(attributes) {
  const normalized = typeof attributes === "string" ? attributes.toLowerCase() : "";
  if (!/(?:id|class)\s*=/.test(normalized)) {
    return 0;
  }
  if (SEMANTIC_EXCLUDE_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return 0;
  }
  return SEMANTIC_INCLUDE_KEYWORDS.reduce((score, keyword) => (
    normalized.includes(keyword) ? score + 1 : score
  ), 0);
}

function decodeHtmlEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, name) => {
    const key = String(name).toLowerCase();
    if (HTML_ENTITY_MAP[key]) {
      return HTML_ENTITY_MAP[key];
    }
    if (key.startsWith("#x")) {
      const codePoint = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    if (key.startsWith("#")) {
      const codePoint = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return entity;
  });
}

export { DEFAULT_READ_URL_MAX_BYTES, DEFAULT_READ_URL_TIMEOUT_MS, READ_URL_SUPPORTED_METHODS, buildAcceptHeader, deriveReadMode, extractReadableHtmlText, htmlToText, isHtmlContentType, isJsonContentType, isTextLikeContentType, normalizeHeaders$2 as normalizeHeaders, normalizeHttpUrl, normalizePositiveInteger$5 as normalizePositiveInteger, normalizeReadUrlMethod, normalizeReadUrlMode, readContentType, readHeaderValue, resolveFetch$5 as resolveFetch };
