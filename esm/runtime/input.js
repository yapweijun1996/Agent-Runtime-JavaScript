function normalizeInput(raw) {
  if (typeof raw === "string") {
    return {
      raw,
      type: "string",
      text: raw
    };
  }

  if (raw && typeof raw === "object") {
    return {
      raw,
      type: "object",
      text: null
    };
  }

  return {
    raw,
    type: "unknown",
    text: null
  };
}

export { normalizeInput };
