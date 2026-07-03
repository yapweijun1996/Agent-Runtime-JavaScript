import { diffJsonPatch, applyJsonPatch } from './json-patch.js';
import { cloneValue } from './utils.js';

// AGRUN-425 — State deltas via JSON Patch: a compact, replayable encoding of a
// SEQUENCE of full state snapshots (e.g. an observer's per-step state feed).
//
// projectStateDeltaStream turns [snapshot0, snapshot1, ...] into a stream where
// the first entry (and every fullSyncEvery-th entry) carries a full snapshot and
// every other entry carries only the RFC 6902 patch from the previous snapshot.
// replayStateDeltaStream reconstructs the original snapshot sequence. The
// load-bearing contract is the round-trip:
//
//   replayStateDeltaStream(projectStateDeltaStream(snapshots)) deep-equals snapshots
//
// The periodic full-sync (fullSyncEvery) bounds reconstruction cost and makes the
// stream self-resynchronizing — a consumer that joins at a full-sync entry can
// rebuild state without the earlier deltas.
//
// This is the transport/encoding primitive built on the json-patch engine; it
// does NOT change any existing live-trace or event-emission contract — a host
// applies it to whatever snapshot sequence it already has to shrink the payload.

const STATE_DELTA_STREAM_VERSION = "agrun.state-delta.v1";

function projectStateDeltaStream(snapshots, options = {}) {
  const list = Array.isArray(snapshots) ? snapshots : [];
  // fullSyncEvery <= 0 means "only the first entry is a full snapshot".
  const fullSyncEvery = readNonNegativeInt(options.fullSyncEvery);
  const entries = [];
  let previous = null;
  for (let index = 0; index < list.length; index += 1) {
    const snapshot = list[index];
    const isFullSync = index === 0 || (fullSyncEvery > 0 && index % fullSyncEvery === 0);
    if (isFullSync) {
      entries.push({ kind: "snapshot", index, value: cloneValue(snapshot) });
    } else {
      entries.push({ kind: "delta", index, patch: diffJsonPatch(previous, snapshot) });
    }
    previous = snapshot;
  }
  return { schemaVersion: STATE_DELTA_STREAM_VERSION, fullSyncEvery, entries };
}

function replayStateDeltaStream(stream) {
  const entries = Array.isArray(stream && stream.entries) ? stream.entries : [];
  const snapshots = [];
  let current = null;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.kind === "snapshot") {
      current = cloneValue(entry.value);
    } else if (entry.kind === "delta") {
      current = applyJsonPatch(current, entry.patch);
    } else {
      continue;
    }
    snapshots.push(cloneValue(current));
  }
  return snapshots;
}

function readNonNegativeInt(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export { STATE_DELTA_STREAM_VERSION, projectStateDeltaStream, replayStateDeltaStream };
