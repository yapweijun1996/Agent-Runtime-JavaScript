import { stableStringify } from './action-fingerprint.js';

function normalizeActionPermissionJudgeConfig(value) {
  if (value == null || value === false) {
    return { enabled: false, classify: null, cache: true };
  }
  const source = value === true ? {} : (value && typeof value === "object" && !Array.isArray(value) ? value : {});
  return {
    enabled: source.enabled !== false,
    cache: source.cache !== false,
    classify: typeof source.classify === "function" ? source.classify : null,
    timeoutMs: Number.isInteger(source.timeoutMs) && source.timeoutMs > 0 ? source.timeoutMs : 5000
  };
}

function createActionPermissionJudge(config) {
  const normalized = normalizeActionPermissionJudgeConfig(config);
  const cache = new Map();

  return {
    async classify(action, args, context) {
      if (!normalized.enabled || typeof normalized.classify !== "function") {
        // 1. Check declarative permissionRules first (last-rule-wins chain).
        const rulesDecision = resolvePermissionRules(action, args);
        if (rulesDecision) return rulesDecision;
        // 2. Fall back to tier-based default.
        const tier = Number.isInteger(action && action.tier) ? action.tier : null;
        if (tier === 0) {
          return createDecision$1("allow", "tier_default_allow", "tier_policy", action);
        }
        return createDecision$1("ask", "tier_default_ask", "tier_policy", action);
      }

      const key = createPermissionCacheKey(action, args);
      if (normalized.cache && cache.has(key)) {
        return {
          ...cache.get(key),
          cacheHit: true
        };
      }

      try {
        const result = await normalized.classify({
          action: projectActionForJudge(action),
          args: args && typeof args === "object" && !Array.isArray(args) ? args : {},
          context: context && typeof context === "object" ? context : {}
        });
        const decision = normalizeJudgeResult(result, action);
        if (normalized.cache) cache.set(key, decision);
        return decision;
      } catch (error) {
        return {
          ...createDecision$1("ask", "permission_judge_failed", "classifier_error", action),
          error: normalizeErrorMessage$2(error)
        };
      }
    },

    clear() {
      cache.clear();
    },

    get size() {
      return cache.size;
    }
  };
}

function shouldUsePermissionJudge(action) {
  const permission = action && action.permission && typeof action.permission === "object"
    ? action.permission
    : null;
  if (!permission) return true;
  return permission.source !== "built_in_metadata" && permission.source !== "host_metadata";
}

function normalizeJudgeResult(result, action) {
  const source = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  const actionValue = readPolicyAction(source.action) || (source.isReadOnly === true ? "allow" : "ask");
  return createDecision$1(
    actionValue,
    readString$X(source.reason) || (actionValue === "allow" ? "permission_judge_read_only" : "permission_judge_uncertain"),
    readString$X(source.source) || "classifier",
    action
  );
}

function createDecision$1(actionValue, reason, source, action) {
  return {
    action: readPolicyAction(actionValue) || "ask",
    actionName: readString$X(action && action.name) || null,
    cacheHit: false,
    permission: action && action.permission && typeof action.permission === "object" ? { ...action.permission } : null,
    reason,
    source,
    tier: Number.isInteger(action && action.tier) ? action.tier : null
  };
}

// Evaluate action.permissionRules with last-rule-wins semantics.
// Each rule: { action: "allow"|"ask"|"deny", reason?: string, matchTier?: number, pattern?: string }
// A rule matches when:
//   - matchTier is absent or equals action.tier, AND
//   - pattern is absent or is a substring of args.path
// Returns a decision from the last matching rule, or null if no rules match.
function resolvePermissionRules(action, args) {
  const rules = action && Array.isArray(action.permissionRules) ? action.permissionRules : [];
  if (rules.length === 0) return null;
  const actionTier = Number.isInteger(action.tier) ? action.tier : null;
  const argPath = args && typeof args.path === "string" ? args.path : null;
  let last = null;
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;
    const policyAction = readPolicyAction(rule.action);
    if (!policyAction) continue;
    const hasMatchTier = "matchTier" in rule && Number.isInteger(rule.matchTier);
    if (hasMatchTier && rule.matchTier !== actionTier) continue;
    const hasPattern = typeof rule.pattern === "string" && rule.pattern.length > 0;
    if (hasPattern && (argPath === null || !argPath.includes(rule.pattern))) continue;
    last = { policyAction, reason: readString$X(rule.reason) || `permission_rule_${policyAction}` };
  }
  if (!last) return null;
  return createDecision$1(last.policyAction, last.reason, "permission_rules", action);
}

function createPermissionCacheKey(action, args) {
  return stableStringify({
    argsSchema: action && action.planner && action.planner.argsSchema,
    name: action && action.name,
    permission: action && action.permission,
    permissionRules: action && action.permissionRules,
    tier: action && action.tier,
    args
  });
}

function projectActionForJudge(action) {
  return {
    description: readString$X(action && action.description),
    name: readString$X(action && action.name),
    permission: action && action.permission && typeof action.permission === "object" ? { ...action.permission } : null,
    tier: Number.isInteger(action && action.tier) ? action.tier : null
  };
}

function readPolicyAction(value) {
  const text = readString$X(value);
  return text === "allow" || text === "ask" || text === "deny" ? text : "";
}

function readString$X(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeErrorMessage$2(error) {
  return error && typeof error.message === "string" && error.message.trim()
    ? error.message.trim()
    : "permission judge failed";
}

export { createActionPermissionJudge, normalizeActionPermissionJudgeConfig, shouldUsePermissionJudge };
