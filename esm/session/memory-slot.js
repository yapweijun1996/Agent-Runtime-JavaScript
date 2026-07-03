// AGRUN-494 (audit M17) — SSOT for the session-memory (kind, slot) uniqueness
// key. Session memory entries are slot-keyed facts: `slot` names a category
// (e.g. "preferred_currency") and the LATEST confirmed value per (kind, slot)
// is the truth, not a history. The read-time merge already ASSUMES this — it
// builds a `${kind}:${slot}` Set over session entries to suppress duplicate
// global entries (mergeGlobalIntoSessionMemory). But `appendMemory` used to
// push unconditionally, so stale same-slot rows accumulated in the store
// (O(n) RAM, only the latest ever wanted) and the slot-uniqueness invariant the
// merge relies on was never actually enforced at write time.
//
// This module is the single key derivation shared by BOTH sides — the write
// dedup (store adapters' appendMemory) and the read merge — so "same slot" can
// never mean two different things. The key matches the merge's prior inline
// rule byte-for-byte (slot must be present; kind may be empty → `:slot`), so
// wiring the merge through it is behavior-identical.

function readNestedString$1(obj, ...keys) {
  let current = obj;
  for (const key of keys) {
    if (!current || typeof current !== "object") return "";
    current = current[key];
  }
  return typeof current === "string" ? current.trim() : "";
}

// Returns the canonical `${kind}:${slot}` uniqueness key for a session memory
// entry, or null when the entry carries no slot (slot-less entries are kept
// append-only — there is nothing to dedup them by).
function readSessionMemorySlotKey(entry) {
  const slot = readNestedString$1(entry, "metadata", "slot");
  if (!slot) return null;
  const kind = readNestedString$1(entry, "metadata", "kind");
  return `${kind}:${slot}`;
}

// Upsert `clonedEntry` (the caller owns cloning) into the in-memory `list`:
// when it has a slot key and an entry with the same key already exists, replace
// every prior occurrence IN PLACE (drop-all-but-latest, converging any
// pre-existing duplicates), preserving the earliest slot position so unrelated
// ordering is stable; otherwise append. Mutates and returns `list`.
function upsertSessionMemoryEntry(list, clonedEntry) {
  const key = readSessionMemorySlotKey(clonedEntry);
  if (!key) {
    list.push(clonedEntry);
    return list;
  }
  let firstIndex = -1;
  for (let index = 0; index < list.length; index += 1) {
    if (readSessionMemorySlotKey(list[index]) === key) {
      firstIndex = index;
      break;
    }
  }
  if (firstIndex === -1) {
    list.push(clonedEntry);
    return list;
  }
  // Put the latest value in the earliest slot position, then drop any later
  // duplicate rows (iterating from the end down so splices never shift an index
  // we have yet to visit, and never shift firstIndex).
  list[firstIndex] = clonedEntry;
  for (let index = list.length - 1; index > firstIndex; index -= 1) {
    if (readSessionMemorySlotKey(list[index]) === key) {
      list.splice(index, 1);
    }
  }
  return list;
}

export { readSessionMemorySlotKey, upsertSessionMemoryEntry };
