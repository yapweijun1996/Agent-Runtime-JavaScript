/**
 * AGRUN-212a — TodoState runtime harness, MVP schema.
 *
 * Why this module exists:
 *   AGRUN-211 ships a UI panel that extracts todo/progress from
 *   assistant prose. That is fine as a UI bridge but cannot be the
 *   production harness — it cannot survive compaction, multi-tab
 *   edits, or planner replanning without losing fidelity. This
 *   module owns the structured runtime state instead.
 *
 * Contract (5 fields, no DAG, no priority weights — locked by ADR-0010):
 *   TodoState = {
 *     id:            string         // stable per-thread plan id
 *     goal:          string         // user-facing anchor (free text)
 *     items:         TodoItem[]     // order = array index, no priority
 *     activeItemId:  string | null  // points into items[].id; at most one
 *     status:        "active" | "completed" | "abandoned"
 *     createdAt:     number
 *     updatedAt:     number
 *     version:       number         // CAS token, bumped per mutation
 *   }
 *
 *   TodoItem = {
 *     id:           string
 *     label:        string
 *     status:       "pending" | "active" | "done" | "blocked" | "abandoned"
 *     notes?:       Array<{ at: number, kind: "progress"|"replan"|"block", text: string }>
 *     _provenance:  { threadId, turnId } | null
 *   }
 *
 * Harness reuse:
 *   - `_provenance` reuses AGRUN-145's stamp shape; no parallel scheme.
 *   - `version` reuses AGRUN-206's CAS pattern; persistence rides
 *     `sessionStore.saveSession` so the surrounding sessionRecord's
 *     CAS protects nested TodoState mutations automatically.
 *
 * Design rules (rejected by ADR-0010):
 *   - NO `dependencies` array → DAG complexity belongs to AGRUN-212b.
 *   - NO `priority` field → list order is authoritative.
 *   - NO automatic completion rule → planner LLM owns transitions.
 *   - NO independent persistence API → always through saveSession.
 */

const TODO_STATUSES = Object.freeze(["active", "completed", "abandoned"]);
const TODO_ITEM_STATUSES = Object.freeze([
  "pending", "active", "done", "blocked", "abandoned"
]);
const TODO_NOTE_KINDS = Object.freeze(["progress", "replan", "block"]);

// Status transitions a TodoItem may undergo. The graph is intentionally
// permissive (any status → any status) but we keep the table explicit
// so future tightening (e.g. forbid `done → pending`) is a single-table
// edit, not a search across call sites.
const ALLOWED_ITEM_TRANSITIONS = Object.freeze({
  pending:   ["active", "done", "blocked", "abandoned"],
  active:    ["pending", "done", "blocked", "abandoned"],
  done:      ["pending", "active", "abandoned"],
  blocked:   ["pending", "active", "done", "abandoned"],
  abandoned: ["pending", "active"]
});

const TODO_STATE_CONSTANTS = Object.freeze({
  STATUSES: TODO_STATUSES,
  ITEM_STATUSES: TODO_ITEM_STATUSES,
  NOTE_KINDS: TODO_NOTE_KINDS,
  ALLOWED_ITEM_TRANSITIONS
});

function readNonEmptyString$1(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function readTimestamp$1(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function generateId$3(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeProvenance$1(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const threadId = readNonEmptyString$1(value.threadId);
  const turnId = typeof value.turnId === "string" && value.turnId.trim()
    ? value.turnId.trim()
    : null;
  if (!threadId && !turnId) return null;
  return { threadId: threadId || "default", turnId };
}

function normalizeNote(value) {
  if (!value || typeof value !== "object") return null;
  const kind = TODO_NOTE_KINDS.includes(value.kind) ? value.kind : "progress";
  const text = readNonEmptyString$1(value.text);
  if (!text) return null;
  const at = readTimestamp$1(value.at, Date.now());
  return { at, kind, text };
}

function normalizeItem(value, fallbackTimestamp) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = readNonEmptyString$1(value.id) || generateId$3("todo-item");
  const label = readNonEmptyString$1(value.label);
  if (!label) return null;
  const status = TODO_ITEM_STATUSES.includes(value.status) ? value.status : "pending";
  const notes = Array.isArray(value.notes)
    ? value.notes.map(normalizeNote).filter(Boolean)
    : [];
  return {
    id,
    label,
    status,
    notes,
    _provenance: normalizeProvenance$1(value._provenance)
  };
}

/**
 * Build a fresh TodoState. Mutations happen through `applyTodoPlan` /
 * `applyTodoAdvance` / `applyTodoCancel` so the active-item invariant
 * and version bump stay in one place — no caller hand-rolls field
 * updates.
 */
function createTodoState(options) {
  const opts = options && typeof options === "object" ? options : {};
  const now = readTimestamp$1(opts.now, Date.now());
  const id = readNonEmptyString$1(opts.id) || generateId$3("todo");
  const goal = readNonEmptyString$1(opts.goal);
  const items = Array.isArray(opts.items)
    ? opts.items.map((item) => normalizeItem(item)).filter(Boolean)
    : [];
  const requestedActive = readNonEmptyString$1(opts.activeItemId);
  const activeItemId = items.some((item) => item.id === requestedActive)
    ? requestedActive
    : null;

  // Single-active-item invariant: if items[].status === "active" exist,
  // the canonical activeItemId must point at exactly one of them. We
  // do NOT mutate item statuses here — `applyTodoPlan` is the only
  // sanctioned path for that — but we surface the inconsistency by
  // refusing to silently pick one. The factory just records the
  // caller's `activeItemId` if it matches an item; otherwise null.

  return {
    id,
    goal,
    items,
    activeItemId,
    status: TODO_STATUSES.includes(opts.status) ? opts.status : "active",
    createdAt: readTimestamp$1(opts.createdAt, now),
    updatedAt: readTimestamp$1(opts.updatedAt, now),
    version: typeof opts.version === "number" && Number.isInteger(opts.version) && opts.version >= 0
      ? opts.version
      : 0
  };
}

/**
 * Coerce an unknown persisted blob into a canonical TodoState. Used by
 * thread hydration so legacy/partial records flow through one
 * normalization path. Returns null when the blob is unrecognizable.
 */
function normalizeTodoState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return createTodoState(value);
}

function findItemIndex(items, itemId) {
  if (typeof itemId !== "string" || !itemId) return -1;
  return items.findIndex((item) => item.id === itemId);
}

/**
 * Create or replace the plan.
 *
 * Two modes:
 *
 *   1. **Replace** (default, `merge !== true`): Drop all existing items and
 *      start from `plan.items`. Equivalent to "create a new TodoState while
 *      preserving id + createdAt".
 *
 *   2. **Merge** (`merge: true`): Preserve `done` and `abandoned` items from
 *      the existing state (history of completed work) and append the new
 *      `plan.items` after them. Used when the planner LLM realises the
 *      remaining plan needs to change but earlier work should not be lost.
 *      Items in `plan.items` whose `id` collides with a preserved terminal
 *      item override that item (the planner is explicitly redoing it).
 *      Active-item resolution still draws only from the *new* items —
 *      terminal items can never become active again.
 *
 * Rules (both modes):
 *   - Bumps `version` and `updatedAt`.
 *   - Drops the previous `activeItemId`; picks `activeItemId` when supplied,
 *     otherwise starts the first pending item so a fresh plan is actionable.
 *   - `plan.note`, when supplied, is stamped as a `replan` note on each
 *     *new* item (preserved terminal items are not retroactively annotated).
 */
function applyTodoPlan(state, plan) {
  const baseState = state && typeof state === "object" ? state : createTodoState({});
  const opts = plan && typeof plan === "object" ? plan : {};
  const merge = opts.merge === true;
  const now = readTimestamp$1(opts.now, Date.now());
  const newItems = Array.isArray(opts.items)
    ? opts.items.map((item) => normalizeItem(item)).filter(Boolean)
    : [];
  const replanNoteText = readNonEmptyString$1(opts.note);
  if (replanNoteText) {
    for (const item of newItems) {
      item.notes = [
        ...(Array.isArray(item.notes) ? item.notes : []),
        { at: now, kind: "replan", text: replanNoteText }
      ];
    }
  }

  const preservedItems = merge && Array.isArray(baseState.items)
    ? collectPreservedTerminalItems(baseState.items, newItems)
    : [];

  const requestedActive = readNonEmptyString$1(opts.activeItemId);
  const planStatus = TODO_STATUSES.includes(opts.status) ? opts.status : "active";
  // Active resolution looks ONLY at new items: terminal items in the
  // preserved set cannot become active again. This keeps the
  // single-active-item invariant honest under merge.
  const requestedActiveItem = newItems.find((item) => item.id === requestedActive) || null;
  const existingActiveItem = newItems.find((item) => item.status === "active") || null;
  const firstPendingItem = newItems.find((item) => item.status === "pending") || null;
  const activeItemId = planStatus === "active"
    ? (requestedActiveItem || existingActiveItem || firstPendingItem)?.id || null
    : null;
  const reconciledNewItems = newItems.map((item) => {
    if (activeItemId && item.id === activeItemId) {
      return item.status === "active" ? item : { ...item, status: "active" };
    }
    if (item.status === "active") {
      return { ...item, status: "pending" };
    }
    return item;
  });
  const items = preservedItems.length > 0
    ? [...preservedItems, ...reconciledNewItems]
    : reconciledNewItems;
  const next = {
    id: baseState.id || generateId$3("todo"),
    goal: readNonEmptyString$1(opts.goal) || baseState.goal || "",
    items,
    activeItemId,
    status: planStatus,
    createdAt: readTimestamp$1(baseState.createdAt, now),
    updatedAt: now,
    version: (typeof baseState.version === "number" ? baseState.version : 0) + 1
  };
  return next;
}

function collectPreservedTerminalItems(existingItems, newItems) {
  const overriddenIds = new Set(
    newItems.map((item) => item && typeof item.id === "string" ? item.id : null).filter(Boolean)
  );
  const preserved = [];
  for (const item of existingItems) {
    if (!item || typeof item !== "object") continue;
    if (item.status !== "done" && item.status !== "abandoned") continue;
    if (overriddenIds.has(item.id)) continue;
    preserved.push({
      ...item,
      notes: Array.isArray(item.notes) ? item.notes.slice() : []
    });
  }
  return preserved;
}

/**
 * Advance a single item: change its status, optionally attach a note,
 * and reconcile the plan-level `activeItemId` when necessary.
 *
 * Rules (ADR-0010):
 *   - Forbid invalid transitions per ALLOWED_ITEM_TRANSITIONS. Throw
 *     so callers cannot silently corrupt status history.
 *   - When `nextStatus === "active"`, set `activeItemId = itemId` and
 *     demote any other item currently `active` to `pending`. This
 *     enforces the single-active-item invariant in one place.
 *   - When the previously-active item is moved off `active`, clear
 *     `activeItemId` (caller may set a new active in a follow-up).
 *   - Bumps `version` and `updatedAt`.
 */
function applyTodoAdvance(state, advance) {
  if (!state || typeof state !== "object") {
    throw new Error("applyTodoAdvance: state is required");
  }
  if (state.status === "completed" || state.status === "abandoned") {
    throw new Error(`applyTodoAdvance: ${state.status} TodoState cannot be advanced`);
  }
  const opts = advance && typeof advance === "object" ? advance : {};
  const itemId = readNonEmptyString$1(opts.itemId);
  if (!itemId) throw new Error("applyTodoAdvance: itemId is required");
  const nextStatus = opts.nextStatus;
  if (!TODO_ITEM_STATUSES.includes(nextStatus)) {
    throw new Error(`applyTodoAdvance: invalid nextStatus "${nextStatus}"`);
  }
  const items = Array.isArray(state.items) ? state.items.map((item) => ({ ...item, notes: Array.isArray(item.notes) ? item.notes.slice() : [] })) : [];
  const idx = findItemIndex(items, itemId);
  if (idx === -1) {
    throw new Error(`applyTodoAdvance: itemId "${itemId}" not found`);
  }
  const fromStatus = items[idx].status;
  const allowed = ALLOWED_ITEM_TRANSITIONS[fromStatus] || [];
  if (fromStatus !== nextStatus && !allowed.includes(nextStatus)) {
    throw new Error(`applyTodoAdvance: transition "${fromStatus}" → "${nextStatus}" is not allowed`);
  }

  const now = readTimestamp$1(opts.now, Date.now());
  items[idx] = { ...items[idx], status: nextStatus };

  // Single-active-item enforcement: when this item becomes active,
  // any other item currently `active` must step down to `pending`
  // (NOT `abandoned` — the caller may want to come back). When the
  // active item moves off `active`, the plan-level pointer clears.
  let activeItemId = state.activeItemId || null;
  if (nextStatus === "active") {
    for (let i = 0; i < items.length; i += 1) {
      if (i !== idx && items[i].status === "active") {
        items[i] = { ...items[i], status: "pending" };
      }
    }
    activeItemId = itemId;
  } else if (activeItemId === itemId && nextStatus !== "active") {
    activeItemId = null;
  }

  // Optional note appended to the touched item.
  const noteText = readNonEmptyString$1(opts.note);
  if (noteText) {
    const noteKind = TODO_NOTE_KINDS.includes(opts.noteKind)
      ? opts.noteKind
      : (nextStatus === "blocked" ? "block" : "progress");
    items[idx] = {
      ...items[idx],
      notes: [...items[idx].notes, { at: now, kind: noteKind, text: noteText }]
    };
  }

  // Provenance stamp on the touched item (AGRUN-145 reuse).
  const provenance = normalizeProvenance$1(opts._provenance);
  if (provenance) {
    items[idx] = { ...items[idx], _provenance: provenance };
  }

  return {
    ...state,
    items,
    activeItemId,
    updatedAt: now,
    version: (typeof state.version === "number" ? state.version : 0) + 1
  };
}

/**
 * Abandon the current TodoState explicitly. This is the runtime-level
 * cancel contract for hosts and planner actions: unfinished items move
 * to `abandoned`, completed items stay `done`, and the plan-level
 * pointer clears.
 *
 * Rules:
 *   - Missing state throws; callers must create a plan before canceling it.
 *   - Completed plans cannot be canceled because that would rewrite history.
 *   - Already-abandoned plans are idempotent no-ops.
 *   - Bumps `version` and `updatedAt` only when a mutation occurs.
 */
function applyTodoCancel(state, cancel) {
  if (!state || typeof state !== "object") {
    throw new Error("applyTodoCancel: state is required");
  }
  if (state.status === "completed") {
    throw new Error("applyTodoCancel: completed TodoState cannot be cancelled");
  }
  if (state.status === "abandoned") {
    return state;
  }

  const opts = cancel && typeof cancel === "object" ? cancel : {};
  const now = readTimestamp$1(opts.now, Date.now());
  const noteText = readNonEmptyString$1(opts.note || opts.reason);
  const provenance = normalizeProvenance$1(opts._provenance);
  const items = Array.isArray(state.items)
    ? state.items.map((item) => {
        const base = {
          ...item,
          notes: Array.isArray(item.notes) ? item.notes.slice() : []
        };
        if (base.status === "done" || base.status === "abandoned") {
          return base;
        }
        const notes = noteText
          ? [...base.notes, { at: now, kind: "progress", text: noteText }]
          : base.notes;
        return {
          ...base,
          status: "abandoned",
          notes,
          _provenance: provenance || base._provenance || null
        };
      })
    : [];

  return {
    ...state,
    items,
    activeItemId: null,
    status: "abandoned",
    updatedAt: now,
    version: (typeof state.version === "number" ? state.version : 0) + 1
  };
}

/**
 * Read-only summary suitable for planner-prompt injection. Caps the
 * payload by listing only the active item plus ±2 surrounding items;
 * full dumps go through `serializeTodoState` (used by `todo_inspect`).
 *
 * Returns `null` when state is missing — callers can branch cheaply.
 */
function summarizeTodoStateForPrompt(state, options) {
  if (!state || typeof state !== "object" || !Array.isArray(state.items) || state.items.length === 0) {
    return null;
  }
  // 2026-05-11 — a todoState carrying `terminatedAt` is preserved for
  // audit (thread record keeps the snapshot after a terminal action)
  // but must not be rendered into the planner prompt: the work unit
  // ended on the previous turn and a fresh user message deserves a
  // clean slate. See `observeTodoStateOnTerminal` for why the
  // annotation is added without falsely marking items done.
  if (state.terminatedAt != null) {
    return null;
  }
  const opts = options && typeof options === "object" ? options : {};
  const window = Number.isInteger(opts.window) && opts.window >= 0 ? opts.window : 2;
  const items = state.items;
  const activeIdx = findItemIndex(items, state.activeItemId);
  const center = activeIdx >= 0 ? activeIdx : 0;
  const start = Math.max(0, center - window);
  const end = Math.min(items.length, center + window + 1);
  const slice = items.slice(start, end).map((item) => {
    const lastNote = Array.isArray(item.notes) && item.notes.length > 0
      ? item.notes[item.notes.length - 1].text
      : null;
    return {
      id: item.id,
      label: item.label,
      status: item.status,
      isActive: item.id === state.activeItemId,
      lastNote
    };
  });
  return {
    goal: state.goal || "",
    activeItemId: state.activeItemId,
    status: state.status,
    visible: slice,
    omittedBefore: start,
    omittedAfter: items.length - end,
    totalItems: items.length
  };
}

/**
 * Full structured snapshot for the `todo_inspect` action and for
 * downstream UI consumption. Returns a deep-cloned object so callers
 * cannot mutate the live state by accident.
 */
function serializeTodoState(state) {
  if (!state || typeof state !== "object") return null;
  return JSON.parse(JSON.stringify(state));
}

export { TODO_STATE_CONSTANTS, applyTodoAdvance, applyTodoCancel, applyTodoPlan, createTodoState, normalizeTodoState, serializeTodoState, summarizeTodoStateForPrompt };
