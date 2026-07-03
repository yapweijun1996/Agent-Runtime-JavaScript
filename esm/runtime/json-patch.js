import { cloneValue } from './utils.js';

// AGRUN-425 — State deltas via JSON Patch (RFC 6902) over JSON Pointer (RFC 6901).
//
// A pure, self-contained diff/apply engine: diffJsonPatch(before, after) returns
// the minimal-ish add/remove/replace operations that transform `before` into
// `after`, and applyJsonPatch(doc, patch) returns a NEW document with the patch
// applied (never mutates its input). The contract that matters:
//
//   applyJsonPatch(before, diffJsonPatch(before, after))  deep-equals  after
//
// This is the engine only — it is the reusable primitive for emitting incremental
// state deltas to an observer (instead of full snapshots) and for serialized
// state transport. It does NOT itself wire into the live-trace contract (that is
// the larger AGRUN-423-intersecting follow-up).
//
// Generated patches use add/remove/replace (the operations a diff needs); the
// applier additionally tolerates the "-" array-append token. Array diffing is
// index-wise: common indices are recursed, then the tail is added (ascending) or
// removed (descending) so every op targets a valid index at apply time. This is
// correct (round-trips) though not guaranteed minimal for reordered arrays.

function diffJsonPatch(before, after) {
  const ops = [];
  buildDiff(before, after, "", ops);
  return ops;
}

function applyJsonPatch(doc, patch) {
  let result = cloneValue(doc);
  const ops = Array.isArray(patch) ? patch : [];
  for (const op of ops) {
    result = applyOp(result, op);
  }
  return result;
}

function buildDiff(before, after, path, ops) {
  if (deepEqual(before, after)) return;

  const beforeType = typeOf(before);
  const afterType = typeOf(after);

  // Leaf value or a type change (object<->array<->primitive): replace wholesale.
  if (beforeType !== afterType || (afterType !== "object" && afterType !== "array")) {
    ops.push({ op: "replace", path, value: cloneValue(after) });
    return;
  }

  if (afterType === "object") {
    for (const key of Object.keys(before)) {
      if (!hasOwn(after, key)) ops.push({ op: "remove", path: `${path}/${escapeToken(key)}` });
    }
    for (const key of Object.keys(after)) {
      const childPath = `${path}/${escapeToken(key)}`;
      if (!hasOwn(before, key)) {
        ops.push({ op: "add", path: childPath, value: cloneValue(after[key]) });
      } else {
        buildDiff(before[key], after[key], childPath, ops);
      }
    }
    return;
  }

  // Array: recurse common indices, then add/remove the tail.
  const common = Math.min(before.length, after.length);
  for (let i = 0; i < common; i += 1) {
    buildDiff(before[i], after[i], `${path}/${i}`, ops);
  }
  if (after.length > before.length) {
    for (let i = before.length; i < after.length; i += 1) {
      ops.push({ op: "add", path: `${path}/${i}`, value: cloneValue(after[i]) });
    }
  } else if (before.length > after.length) {
    for (let i = before.length - 1; i >= after.length; i -= 1) {
      ops.push({ op: "remove", path: `${path}/${i}` });
    }
  }
}

function applyOp(doc, op) {
  if (!op || typeof op !== "object") return doc;
  const tokens = parsePointer(typeof op.path === "string" ? op.path : "");
  const operation = typeof op.op === "string" ? op.op : "";

  // Root replacement / removal.
  if (tokens.length === 0) {
    if (operation === "add" || operation === "replace") return cloneValue(op.value);
    if (operation === "remove") return null;
    throw new Error(`Unsupported root JSON Patch op: ${operation}`);
  }

  const parent = resolve(doc, tokens.slice(0, -1));
  const key = tokens[tokens.length - 1];

  if (Array.isArray(parent)) {
    const index = key === "-" ? parent.length : Number(key);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Invalid array index in JSON Patch path: ${op.path}`);
    }
    if (operation === "add") parent.splice(index, 0, cloneValue(op.value));
    else if (operation === "remove") parent.splice(index, 1);
    else if (operation === "replace") parent[index] = cloneValue(op.value);
    else throw new Error(`Unsupported JSON Patch op: ${operation}`);
    return doc;
  }

  if (isPlainObject(parent)) {
    if (operation === "add" || operation === "replace") parent[key] = cloneValue(op.value);
    else if (operation === "remove") delete parent[key];
    else throw new Error(`Unsupported JSON Patch op: ${operation}`);
    return doc;
  }

  throw new Error(`Cannot apply JSON Patch at path: ${op.path}`);
}

function resolve(doc, tokens) {
  let node = doc;
  for (const token of tokens) {
    if (Array.isArray(node)) {
      node = node[Number(token)];
    } else if (isPlainObject(node)) {
      node = node[token];
    } else {
      throw new Error(`JSON Pointer does not resolve: /${tokens.join("/")}`);
    }
  }
  return node;
}

// ── RFC 6901 JSON Pointer ──────────────────────────────────────────────────

function escapeToken(token) {
  return String(token).replace(/~/g, "~0").replace(/\//g, "~1");
}

function unescapeToken(token) {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function parsePointer(pointer) {
  if (pointer === "") return [];
  return pointer.split("/").slice(1).map(unescapeToken);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function typeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "object") return "object";
  return typeof value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function deepEqual(a, b) {
  if (a === b) return true;
  const typeA = typeOf(a);
  const typeB = typeOf(b);
  if (typeA !== typeB) return false;
  if (typeA === "array") {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeA === "object") {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!hasOwn(b, key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

export { applyJsonPatch, diffJsonPatch };
