import { createInMemorySessionStore } from './store-memory.js';
import { createIndexedDBSessionStore } from './store-indexeddb.js';
import { createResilientSessionStore } from './store-resilient.js';

function createSessionStore(options) {
  if (options && typeof options === "object" && typeof options.createSession === "function") {
    validateSessionStore(options);
    return options;
  }

  if (typeof globalThis.indexedDB === "object" && globalThis.indexedDB) {
    const primary = createIndexedDBSessionStore(options);
    return createResilientSessionStore(primary, options);
  }

  return createInMemorySessionStore(options);
}

function validateSessionStore(store) {
  const requiredMethods = [
    "appendGlobalMemory",
    "appendMemory",
    "appendMessage",
    "clearAllGlobalMemory",
    "createSession",
    "deleteGlobalMemory",
    "getSession",
    "getSummary",
    "listSummaries",
    "readAllGlobalMemory",
    "readMemory",
    "readMessages",
    "saveSession",
    "updateGlobalMemory",
    "updateMessage",
    "writeSummary"
  ];

  for (const method of requiredMethods) {
    if (typeof store[method] !== "function") {
      throw new Error(`sessionStore must define "${method}()".`);
    }
  }
}

export { createInMemorySessionStore, createIndexedDBSessionStore, createResilientSessionStore, createSessionStore };
