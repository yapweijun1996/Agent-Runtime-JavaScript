import { hasRepoSearchTool, hasRepoReadFileTool, assertRepoPathAllowed, normalizeRepoSearchOutput, assertRepoGlobAllowed, normalizeRepoFileOutput } from '../repo-file-tools.js';
import { readString } from '../semantic-json.js';

function createRepoReadFileAction(repoFileTools) {
  if (!hasRepoReadFileTool(repoFileTools)) return null;
  return Object.freeze({
    description: "Read a file from the host-provided repository workspace. Disabled unless the host explicitly provides a read-only adapter.",
    name: "repo_read_file",
    planner: {
      aliases: ["read_file", "repo_read"],
      argsExample: { path: "src/index.js", maxChars: 12000 },
      argsSchema: {
        maxChars: { type: "number" },
        path: { type: "string", required: true }
      },
      decisionType: "action",
      guidance: "Use repo_read_file only when the user asks to inspect project files. Paths must be relative to the configured repo root."
    },
    tier: 1,
    execute: executeRepoReadFileAction,
    outputSchema: {
      kinds: ["repo_file_result", "repo_file_tools_result"],
      controls: ["continue"]
    },
    preflight(context, args) {
      assertRepoPathAllowed(args && args.path, readConfig(context), "read");
    }
  });
}

function createRepoSearchAction(repoFileTools) {
  if (!hasRepoSearchTool(repoFileTools)) return null;
  return Object.freeze({
    description: "Search text in the host-provided repository workspace. Disabled unless the host explicitly provides a read-only adapter.",
    name: "repo_rg",
    planner: {
      aliases: ["grep", "ripgrep", "repo_search", "search_files"],
      argsExample: { glob: "src/**/*.js", maxResults: 20, query: "createRuntime" },
      argsSchema: {
        glob: { type: "string" },
        maxResults: { type: "number" },
        query: { type: "string", required: true }
      },
      decisionType: "action",
      guidance: "Use repo_rg to find relevant project files before reading them. Keep queries specific and use a relative glob when helpful."
    },
    tier: 1,
    execute: executeRepoSearchAction,
    outputSchema: {
      kinds: ["repo_search_result", "repo_file_tools_result"],
      controls: ["continue"],
      metrics: { resultCount: "matches.length" }
    },
    preflight(_context, args) {
      normalizeRepoSearchArgs(_context, args);
    }
  });
}

async function executeRepoReadFileAction(context, args) {
  const config = readConfig(context);
  if (!hasRepoReadFileTool(config)) {
    return createUnavailableResult("repo_read_file");
  }
  const path = assertRepoPathAllowed(args && args.path, config, "read");
  const maxFileChars = normalizePositiveInteger$3(args && args.maxChars, config.maxFileChars);
  const request = {
    maxFileChars,
    path,
    rootDir: config.rootDir
  };
  const raw = await config.readFile(request);
  const output = normalizeRepoFileOutput(raw, request);
  return {
    control: "continue",
    output,
    summary: `repo_read_file(${path}, chars=${output.text.length}${output.truncated ? ", truncated" : ""})`
  };
}

async function executeRepoSearchAction(context, args) {
  const config = readConfig(context);
  if (!hasRepoSearchTool(config)) {
    return createUnavailableResult("repo_rg");
  }
  const request = normalizeRepoSearchArgs(context, args);
  const raw = await config.search(request);
  const output = normalizeRepoSearchOutput(raw, request);
  return {
    control: "continue",
    output,
    summary: `repo_rg(${request.query}, matches=${output.matches.length}${output.truncated ? ", truncated" : ""})`
  };
}

function normalizeRepoSearchArgs(context, args) {
  const config = readConfig(context);
  const query = readString(args && args.query);
  if (!query) {
    throw new Error('repo_rg requires a non-empty "query".');
  }
  return {
    allowPaths: config.allowPaths,
    denyPaths: config.denyPaths,
    glob: assertRepoGlobAllowed(args && args.glob, config),
    maxResultChars: config.maxResultChars,
    maxResults: normalizePositiveInteger$3(args && args.maxResults, config.maxSearchResults),
    query,
    rootDir: config.rootDir
  };
}

function readConfig(context) {
  return context && context.runtimeConfig && context.runtimeConfig.repoFileTools
    ? context.runtimeConfig.repoFileTools
    : null;
}

function createUnavailableResult(actionName) {
  return {
    control: "continue",
    output: {
      error: "repo_file_tools_unavailable",
      kind: "repo_file_tools_result",
      ok: false
    },
    summary: `${actionName}(unavailable)`
  };
}

function normalizePositiveInteger$3(value, fallback) {
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, fallback);
}

export { createRepoReadFileAction, createRepoSearchAction, executeRepoReadFileAction, executeRepoSearchAction };
