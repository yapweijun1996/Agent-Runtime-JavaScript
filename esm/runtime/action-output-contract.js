// AGRUN-248-B — Contract check for action outputSchema declarations.
//
// Every action descriptor must declare either:
//   outputSchema: { kinds: [...], controls: [...], metrics? }
// or an explicit waiver:
//   outputSchema: null
//
// Mirrors the style of assertPlannerActionArgsContract — fail fast at registry
// construction so no action can ship without an envelope contract decision.

const ALLOWED_CONTROLS$1 = Object.freeze(new Set(["continue", "stop", "complete"]));

function assertActionOutputContract(actions) {
  if (!Array.isArray(actions)) {
    throw new Error("assertActionOutputContract requires an array of actions.");
  }
  for (const action of actions) {
    if (!action || typeof action !== "object") continue;
    if (!("outputSchema" in action)) {
      throw new Error(
        `Action "${actionName(action)}" must declare outputSchema (object) or outputSchema:null waiver.`
      );
    }
    const schema = action.outputSchema;
    if (schema === null) continue;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw new Error(
        `Action "${actionName(action)}" outputSchema must be an object or null; got ${typeof schema}.`
      );
    }
    const kinds = readStringArray$1(schema.kinds);
    if (kinds.length === 0) {
      throw new Error(
        `Action "${actionName(action)}" outputSchema.kinds must be a non-empty string array.`
      );
    }
    const controls = readStringArray$1(schema.controls);
    if (controls.length === 0) {
      throw new Error(
        `Action "${actionName(action)}" outputSchema.controls must be a non-empty string array.`
      );
    }
    for (const control of controls) {
      if (!ALLOWED_CONTROLS$1.has(control)) {
        throw new Error(
          `Action "${actionName(action)}" outputSchema.controls contains invalid value "${control}". Allowed: continue, stop, complete.`
        );
      }
    }
    if (schema.metrics != null) {
      if (typeof schema.metrics !== "object" || Array.isArray(schema.metrics)) {
        throw new Error(
          `Action "${actionName(action)}" outputSchema.metrics must be an object when present.`
        );
      }
      for (const [key, value] of Object.entries(schema.metrics)) {
        if (typeof value !== "string" || !value.trim()) {
          throw new Error(
            `Action "${actionName(action)}" outputSchema.metrics.${key} must be a non-empty string path.`
          );
        }
      }
    }
  }
}

function readStringArray$1(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function actionName(action) {
  return typeof action.name === "string" ? action.name : "<unnamed>";
}

export { assertActionOutputContract };
