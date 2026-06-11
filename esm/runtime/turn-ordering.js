/**
 * AGRUN-201 — Turn ordering harness.
 *
 * `turnId` (and `runId`) values follow the shape `<prefix>-<number>`,
 * e.g. `run-1`, `run-10`, `turn-2`. Naive string comparison treats
 * `"run-10" < "run-2"` as true (lexicographic) which silently corrupts
 * compaction-window and evidence-window filtering: newer turns get
 * classified as older and trimmed out.
 *
 * This module is the single source of truth for ordering turn ids.
 * Every call site that compares two turn ids MUST go through
 * `compareTurnIds` / `isTurnIdBefore`. Direct `<` / `>` on turn ids is
 * forbidden — it bypasses the harness and reintroduces the bug.
 *
 * Contract:
 *   - `parseTurnId(id)` → `{ prefix, sequence } | null`. Tolerant of
 *     legacy ids that don't match the pattern (returns null instead of
 *     throwing) so call sites can fall back to "unknown ordering" and
 *     keep the entry rather than silently dropping it.
 *   - `compareTurnIds(a, b)` → negative / 0 / positive, the standard
 *     `Array.prototype.sort` comparator shape. Same-prefix ids are
 *     compared numerically; different-prefix or unparseable ids fall
 *     back to lexical compare so the function is total.
 *   - `isTurnIdBefore(candidate, floor)` → boolean. Returns false when
 *     either id is missing or unparseable, matching the pre-existing
 *     "keep when in doubt" policy of the filter call sites (legacy
 *     entries must not be silently dropped).
 */

const TURN_ID_PATTERN = /^([^-]*)-(\d+)$/;

function parseTurnId(id) {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  const match = TURN_ID_PATTERN.exec(trimmed);
  if (!match) return null;
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || sequence < 0) return null;
  return { prefix: match[1], sequence };
}

function compareTurnIds(a, b) {
  const aStr = typeof a === "string" ? a : "";
  const bStr = typeof b === "string" ? b : "";
  const aParsed = parseTurnId(aStr);
  const bParsed = parseTurnId(bStr);
  if (aParsed && bParsed && aParsed.prefix === bParsed.prefix) {
    return aParsed.sequence - bParsed.sequence;
  }
  if (aStr < bStr) return -1;
  if (aStr > bStr) return 1;
  return 0;
}

function isTurnIdBefore(candidate, floor) {
  if (typeof candidate !== "string" || !candidate) return false;
  if (typeof floor !== "string" || !floor) return false;
  if (!parseTurnId(candidate) || !parseTurnId(floor)) return false;
  return compareTurnIds(candidate, floor) < 0;
}

export { compareTurnIds, isTurnIdBefore, parseTurnId };
