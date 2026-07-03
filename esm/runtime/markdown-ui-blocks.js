import { readString } from './semantic-json.js';

const UI_EXTENSION_BLOCKS = Object.freeze([
  "g3-followups",
  "g3-drill-hints"
]);

function stripSectionUiExtensionBlocks(value) {
  let text = readString(value);
  if (!text) return "";

  for (const language of UI_EXTENSION_BLOCKS) {
    text = text.replace(createFencePattern(language), "");
  }

  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function createFencePattern(language) {
  return new RegExp(
    "(^|\\n)[ \\t]*```" +
      escapeRegExp(language) +
      "[^\\n]*\\n[\\s\\S]*?\\n[ \\t]*```[ \\t]*(?=\\n|$)",
    "gi"
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { stripSectionUiExtensionBlocks };
