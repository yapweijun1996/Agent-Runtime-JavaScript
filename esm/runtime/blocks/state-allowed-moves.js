import { readString } from '../semantic-json.js';

// Layer-0 leaf shared by the convergence-loop veto gates, extracted from
// action-loop-action.js (AGRUN-450 slice 7). Reads a convergence state's
// allowedNextMoves recovery surface (capped) and emits a not-populated signal
// when it is missing/empty. Pure — only readString.


function readStateAllowedNextMovesWithSignal(state, limit, source) {
  const allowedNextMoves = Array.isArray(state && state.allowedNextMoves)
    ? state.allowedNextMoves.map(readString).filter(Boolean).slice(0, limit)
    : [];
  return {
    allowedNextMoves,
    signal: allowedNextMoves.length > 0
      ? null
      : {
          kind: "allowed_next_moves_not_populated",
          source,
          reason: "state_allowedNextMoves_missing_or_empty"
        }
  };
}

export { readStateAllowedNextMovesWithSignal };
