import { cloneValue } from '../runtime/utils.js';

function createMemoryStore(initialEntries) {
  const entries = Array.isArray(initialEntries)
    ? initialEntries.map(cloneValue)
    : [];

  return {
    append(entry) {
      const nextEntry = cloneValue(entry);
      entries.push(nextEntry);
      return cloneValue(nextEntry);
    },

    readAll() {
      return entries.map(cloneValue);
    }
  };
}

function createReadOnlyMemory(store) {
  return {
    readAll() {
      return store.readAll().map(cloneValue);
    }
  };
}

export { createMemoryStore, createReadOnlyMemory };
