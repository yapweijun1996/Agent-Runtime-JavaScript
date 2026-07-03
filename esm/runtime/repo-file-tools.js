import { readString } from './semantic-json.js';

const DEFAULT_MAX_FILE_CHARS = 12000;
const DEFAULT_MAX_SEARCH_RESULTS = 20;
const DEFAULT_MAX_RESULT_CHARS = 240;
const MAX_HARD_FILE_CHARS = 80000;
const MAX_HARD_SEARCH_RESULTS = 100;
const MAX_HARD_RESULT_CHARS = 1000;
const DEFAULT_DENY_PATHS = Object.freeze([
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*secret*",
  "**/*secrets*",
  "**/*credential*",
  "**/*credentials*",
  "**/*private-key*",
  "**/id_rsa",
  "**/id_ed25519"
]);

function normalizeRepoFileToolsConfig(value) {
  if (value == null || value === false) {
    return {
      enabled: false,
      maxFileChars: DEFAULT_MAX_FILE_CHARS,
      maxResultChars: DEFAULT_MAX_RESULT_CHARS,
      maxSearchResults: DEFAULT_MAX_SEARCH_RESULTS,
      allowPaths: [],
      denyPaths: DEFAULT_DENY_PATHS.slice(),
      readFile: null,
      rootDir: "",
      search: null
    };
  }
  if (value === true || typeof value !== "object" || Array.isArray(value)) {
    return {
      enabled: false,
      maxFileChars: DEFAULT_MAX_FILE_CHARS,
      maxResultChars: DEFAULT_MAX_RESULT_CHARS,
      maxSearchResults: DEFAULT_MAX_SEARCH_RESULTS,
      allowPaths: [],
      denyPaths: DEFAULT_DENY_PATHS.slice(),
      readFile: null,
      rootDir: "",
      search: null
    };
  }
  const readFile = typeof value.readFile === "function" ? value.readFile : null;
  const search = typeof value.search === "function" ? value.search : null;
  const enabled = value.enabled === true && Boolean(readFile || search);
  return {
    enabled,
    allowPaths: normalizePathPatterns(value.allowPaths),
    denyPaths: mergeDenyPatterns(value.denyPaths),
    maxFileChars: normalizePositiveInteger$4(value.maxFileChars, DEFAULT_MAX_FILE_CHARS, MAX_HARD_FILE_CHARS),
    maxResultChars: normalizePositiveInteger$4(value.maxResultChars, DEFAULT_MAX_RESULT_CHARS, MAX_HARD_RESULT_CHARS),
    maxSearchResults: normalizePositiveInteger$4(value.maxSearchResults, DEFAULT_MAX_SEARCH_RESULTS, MAX_HARD_SEARCH_RESULTS),
    readFile,
    rootDir: readString(value.rootDir),
    search
  };
}

function hasRepoReadFileTool(config) {
  return Boolean(config && config.enabled === true && typeof config.readFile === "function");
}

function hasRepoSearchTool(config) {
  return Boolean(config && config.enabled === true && typeof config.search === "function");
}

function normalizeRepoPath(value) {
  const path = readString(value);
  if (!path) {
    throw new Error('repo file tools require a non-empty "path".');
  }
  if (path.includes("\0")) {
    throw new Error("repo file path is not allowed.");
  }
  if (path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)) {
    throw new Error("repo file path must be relative to the configured root.");
  }
  if (path.includes("\\")) {
    throw new Error("repo file path must use forward slashes.");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("repo file path cannot contain empty, dot, or parent segments.");
  }
  return parts.join("/");
}

function assertRepoPathAllowed(path, config, operation = "read") {
  const normalizedPath = normalizeRepoPath(path);
  const allowPaths = Array.isArray(config && config.allowPaths) ? config.allowPaths : [];
  const denyPaths = Array.isArray(config && config.denyPaths) ? config.denyPaths : DEFAULT_DENY_PATHS;
  if (allowPaths.length > 0 && !allowPaths.some((pattern) => matchPathPattern(normalizedPath, pattern))) {
    throw new Error(`repo ${operation} path is outside the configured allowlist.`);
  }
  if (denyPaths.some((pattern) => matchPathPattern(normalizedPath, pattern))) {
    throw new Error(`repo ${operation} path is blocked by the configured denylist.`);
  }
  return normalizedPath;
}

function normalizeRepoGlob(value) {
  const glob = readString(value);
  if (!glob) return "";
  if (glob.includes("\0") || glob.includes("\\") || glob.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(glob)) {
    throw new Error("repo search glob must be a relative forward-slash pattern.");
  }
  if (glob.split("/").some((part) => part === "..")) {
    throw new Error("repo search glob cannot contain parent segments.");
  }
  return glob;
}

function assertRepoGlobAllowed(glob, config) {
  const normalizedGlob = normalizeRepoGlob(glob);
  if (!normalizedGlob) return "";
  const allowPaths = Array.isArray(config && config.allowPaths) ? config.allowPaths : [];
  const denyPaths = Array.isArray(config && config.denyPaths) ? config.denyPaths : DEFAULT_DENY_PATHS;
  if (allowPaths.length > 0 && !allowPaths.some((pattern) => globCanMatchAllowedPath(normalizedGlob, pattern))) {
    throw new Error("repo search glob is outside the configured allowlist.");
  }
  if (denyPaths.some((pattern) => globOverlapsPattern(normalizedGlob, pattern))) {
    throw new Error("repo search glob is blocked by the configured denylist.");
  }
  return normalizedGlob;
}

function normalizeRepoFileOutput(value, request) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const text = truncateText$1(readString(source.text), request.maxFileChars);
  return {
    kind: "repo_file_result",
    ok: source.ok !== false,
    path: request.path,
    rootDir: request.rootDir || "",
    text: text.value,
    truncated: Boolean(source.truncated) || text.truncated
  };
}

function normalizeRepoSearchOutput(value, request) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const rawMatches = Array.isArray(source.matches) ? source.matches : [];
  const matches = [];
  for (let index = 0; index < rawMatches.length; index += 1) {
    const match = normalizeMatch(rawMatches[index], index, request);
    if (!isRepoPathAllowedForOutput(match.path, request)) {
      continue;
    }
    matches.push(match);
    if (matches.length >= request.maxResults) break;
  }
  return {
    kind: "repo_search_result",
    matches,
    ok: source.ok !== false,
    query: request.query,
    rootDir: request.rootDir || "",
    truncated: Boolean(source.truncated) || rawMatches.length > matches.length
  };
}

function normalizeMatch(value, index, request) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const text = truncateText$1(readString(source.text), request.maxResultChars);
  return {
    column: normalizeNonNegativeInteger(source.column, null),
    line: normalizeNonNegativeInteger(source.line, null),
    path: readString(source.path) || `match-${index + 1}`,
    text: text.value,
    truncated: Boolean(source.truncated) || text.truncated
  };
}

function truncateText$1(value, maxChars) {
  const text = typeof value === "string" ? value : "";
  if (text.length <= maxChars) {
    return { truncated: false, value: text };
  }
  return {
    truncated: true,
    value: text.slice(0, maxChars)
  };
}

function normalizePositiveInteger$4(value, fallback, hardMax) {
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, hardMax);
}

function normalizeNonNegativeInteger(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function normalizePathPatterns(value) {
  return (Array.isArray(value) ? value : [])
    .map(readString)
    .filter(Boolean)
    .map((pattern) => pattern.replace(/\\/g, "/"));
}

function mergeDenyPatterns(value) {
  const explicit = normalizePathPatterns(value);
  return Array.from(new Set(DEFAULT_DENY_PATHS.concat(explicit)));
}

function isRepoPathAllowedForOutput(path, request) {
  try {
    assertRepoPathAllowed(path.replace(/^\.\//, ""), request, "search");
    return true;
  } catch {
    return false;
  }
}

function globCanMatchAllowedPath(glob, allowPattern) {
  if (!allowPattern) return false;
  if (allowPattern.endsWith("/")) {
    return glob === allowPattern.slice(0, -1) || glob.startsWith(allowPattern);
  }
  if (glob.startsWith(`${allowPattern}/`)) return true;
  return matchPathPattern(glob.replace(/\*/g, "x"), allowPattern);
}

function globOverlapsPattern(glob, denyPattern) {
  if (!denyPattern) return false;
  if (denyPattern.endsWith("/") && glob.startsWith(denyPattern)) return true;
  if (denyPattern.includes(".env") && glob.includes(".env")) return true;
  if (/secret|credential|private-key|id_rsa|id_ed25519/i.test(denyPattern) &&
      /secret|credential|private-key|id_rsa|id_ed25519/i.test(glob)) {
    return true;
  }
  return glob === denyPattern;
}

function matchPathPattern(path, pattern) {
  const normalizedPath = readString(path).replace(/^\.\//, "");
  const normalizedPattern = readString(pattern).replace(/^\.\//, "");
  if (!normalizedPath || !normalizedPattern) return false;
  if (normalizedPattern.endsWith("/")) {
    return normalizedPath.startsWith(normalizedPattern);
  }
  if (normalizedPath === normalizedPattern) return true;
  return globToRegExp(normalizedPattern).test(normalizedPath);
}

function globToRegExp(pattern) {
  const placeholder = "\u0001";
  const escaped = pattern
    .replace(/\*\*/g, placeholder)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(new RegExp(placeholder, "g"), ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export { assertRepoGlobAllowed, assertRepoPathAllowed, hasRepoReadFileTool, hasRepoSearchTool, normalizeRepoFileOutput, normalizeRepoFileToolsConfig, normalizeRepoGlob, normalizeRepoPath, normalizeRepoSearchOutput };
