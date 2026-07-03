function parseLooseJsonValue(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return null;
  }

  const direct = safeParse$2(text);
  if (direct != null) {
    return direct;
  }

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    const fenced = safeParse$2(fenceMatch[1]);
    if (fenced != null) {
      return fenced;
    }
  }

  const balancedObject = extractBalancedJson(text, "{", "}");
  if (balancedObject) {
    const objectValue = safeParse$2(balancedObject);
    if (objectValue != null) {
      return objectValue;
    }
  }

  const balancedArray = extractBalancedJson(text, "[", "]");
  if (balancedArray) {
    const arrayValue = safeParse$2(balancedArray);
    if (arrayValue != null) {
      return arrayValue;
    }
  }

  return null;
}

function extractBalancedJson(text, open, close) {
  if (typeof text !== "string") {
    return null;
  }

  const start = text.indexOf(open);
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

// AGRUN-447 — readString / readStringArray / readPositiveInteger below are
// the SSOT for these readers. New code imports from here instead of adding
// another local copy (~100 legacy locals migrate opportunistically).
function readString$5(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray$6(value) {
  return Array.isArray(value) ? value.map(readString$5).filter(Boolean) : [];
}

// AGRUN-466 — canonical finite-number reader (null fallback). The two local
// `: 0` fallback variants are a different semantic and deliberately NOT
// served by this function.
function readFiniteNumber$9(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean$2(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }

  return fallback === true;
}

function readNumber$n(value, fallback) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function readObject$2(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function readArray$3(value) {
  return Array.isArray(value) ? value : [];
}

function safeParse$2(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

export { extractBalancedJson, parseLooseJsonValue, readArray$3 as readArray, readBoolean$2 as readBoolean, readFiniteNumber$9 as readFiniteNumber, readNumber$n as readNumber, readObject$2 as readObject, readString$5 as readString, readStringArray$6 as readStringArray };
