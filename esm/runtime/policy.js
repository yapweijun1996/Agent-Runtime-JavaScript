function normalizeActionPolicy(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const policy = {};

  for (const [actionName, actionPolicy] of Object.entries(source)) {
    if (actionPolicy == null) {
      continue;
    }

    const normalizedPolicy = normalizePolicyEntry(actionPolicy);
    if (!normalizedPolicy) {
      throw new Error(`Unsupported action policy "${formatPolicyForError(actionPolicy)}" for "${actionName}".`);
    }

    policy[actionName] = normalizedPolicy;
  }

  return policy;
}

function evaluateActionPolicy(policy, action) {
  const actionName = typeof action === "string" ? action : action && action.name;
  const tier = typeof action === "string" || !action ? null : readTier(action);
  const explicitPolicy = normalizePolicyEntry(policy && policy[actionName]);

  if (explicitPolicy) {
    return {
      action: explicitPolicy.action,
      actionName,
      permission: readPermission(action),
      reason: explicitPolicy.reason || "explicit_action_policy",
      source: "explicit",
      tier
    };
  }

  return {
    action: inferTierPolicy(tier),
    actionName,
    permission: readPermission(action),
    reason: "tier_policy",
    source: "tier",
    tier
  };
}

function normalizePolicyEntry(value) {
  if (isSupportedPolicy(value)) {
    return { action: value, reason: "explicit_action_policy" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const action = typeof value.action === "string" ? value.action.trim() : "";
  if (!isSupportedPolicy(action)) {
    return null;
  }
  return {
    action,
    reason: typeof value.reason === "string" && value.reason.trim()
      ? value.reason.trim()
      : "explicit_action_policy"
  };
}

function formatPolicyForError(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function isSupportedPolicy(value) {
  return value === "allow" || value === "ask" || value === "deny";
}

function inferTierPolicy(tier) {
  if (tier === 1 || tier === 2) {
    return "ask";
  }

  if (tier === 3) {
    return "deny";
  }

  return "allow";
}

function readTier(action) {
  return typeof action.tier === "number" && Number.isInteger(action.tier)
    ? action.tier
    : null;
}

function readPermission(action) {
  return action && typeof action === "object" && action.permission && typeof action.permission === "object"
    ? { ...action.permission }
    : null;
}

export { evaluateActionPolicy, normalizeActionPolicy };
