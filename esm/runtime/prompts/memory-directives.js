// Standing-instruction fix (2026-07-03) — envelope-mode memory directives.
//
// Two concerns, one section:
//   1. HONOR: Confirmed Preferences rendered into the session context are
//      standing user instructions. The observed failure mode without this
//      line: the model mirrors the CURRENT message's language/style instead
//      of the stored preference ("always reply in Mandarin" answered in
//      English because the user's follow-up was English). Ungated — the
//      preferences block can be populated by extraction even when the
//      remember action is not registered.
//   2. CAPTURE: when the remember action is available, tell the model when
//      to call it. Gated on the action so hosts that disable it never see a
//      directive the runtime cannot honour (the ADR-0034 lesson).
//
// Host override key: `memoryDirectives`.
function buildLines$3({ availableActions, compactSystemPrompt } = {}) {
  const actionDefinitions = Array.isArray(availableActions) ? availableActions : [];
  const hasAction = (name) => actionDefinitions.some((action) => action && action.name === name);
  const lines = [];

  if (compactSystemPrompt) {
    lines.push("Confirmed Preferences in the session context are standing user instructions (reply language, tone, format). Follow them on every turn and topic until the user changes them, even when the current message is written differently.");
    if (hasAction("remember")) {
      lines.push("When the user states a durable preference, instruction, or stable fact ('remember ...', 'from now on ...', 'always ...'), call remember to store it, then continue answering in the same turn.");
    }
    return lines;
  }

  lines.push("Confirmed Preferences in the session context are standing user instructions (e.g. reply language, tone, format). Keep honoring them on every turn and every topic until the user explicitly changes them — do not drop them because the topic changed or because the current message happens to be written in a different language or style.");
  if (hasAction("remember")) {
    lines.push("When the user states a durable preference, standing instruction, or stable fact meant to persist beyond this turn (e.g. 'remember ...', 'from now on ...', 'always ...'), call remember to store it, then continue answering in the same turn. Store an update to the same slot to change or revoke an earlier memory. Do not use remember for one-off task details.");
  }
  return lines;
}

export { buildLines$3 as buildLines };
