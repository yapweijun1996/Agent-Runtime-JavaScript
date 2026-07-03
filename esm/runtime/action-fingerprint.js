// Stable, order-independent JSON stringify — used as input to the
// action fingerprint hash so that `{a:1,b:2}` and `{b:2,a:1}` yield
// the same fingerprint.
function stableStringify$1(value) {
  if (value === null || value === undefined) return JSON.stringify(value ?? null);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify$1).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map(
    (key) => JSON.stringify(key) + ":" + stableStringify$1(value[key])
  );
  return "{" + parts.join(",") + "}";
}

// djb2-xor hash — sufficient for in-session dedup, not cryptographic.
// Returns a base36 string to keep debug output compact.
function djb2Hash(input) {
  const text = typeof input === "string" ? input : String(input);
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

// Fingerprint a planner action decision so that identical `tool + args`
// repeats can be detected and short-circuited. Returns null for
// non-action decisions (finalize/plan/clarify/final) — those are
// terminal or planning, never subject to dedup.
function fingerprintAction(decision) {
  if (!decision || typeof decision !== "object") return null;
  if (decision.type !== "action") return null;
  const name = typeof decision.name === "string" && decision.name ? decision.name : null;
  if (!name) return null;

  const envelope = {
    name,
    skillName: typeof decision.skillName === "string" ? decision.skillName : null,
    toolName: typeof decision.toolName === "string" ? decision.toolName : null,
    args: decision.args && typeof decision.args === "object" ? decision.args : {}
  };
  return djb2Hash(stableStringify$1(envelope));
}

export { djb2Hash, fingerprintAction, stableStringify$1 as stableStringify };
