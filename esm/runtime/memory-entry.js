/**
 * Stamp provenance fields onto a metadata object without clobbering values the
 * caller set explicitly. Safe to call with missing / null provenance.
 */
function stampProvenance(metadata, provenance) {
  if (!metadata || typeof metadata !== "object") return;
  if (!provenance || typeof provenance !== "object") return;
  if (typeof provenance.threadId === "string" && provenance.threadId.trim() && !metadata.threadId) {
    metadata.threadId = provenance.threadId.trim();
  }
  if (typeof provenance.turnId === "string" && provenance.turnId.trim() && !metadata.turnId) {
    metadata.turnId = provenance.turnId.trim();
  }
  if (typeof provenance.source === "string" && provenance.source.trim() && !metadata.source) {
    metadata.source = provenance.source.trim();
  }
  if (Array.isArray(provenance.sources) && !Array.isArray(metadata.sources)) {
    const cleaned = [];
    for (const item of provenance.sources) {
      if (item && typeof item === "object" && typeof item.url === "string" && item.url.trim()) {
        cleaned.push({ url: item.url.trim() });
      } else if (typeof item === "string" && item.trim()) {
        cleaned.push({ url: item.trim() });
      }
    }
    if (cleaned.length > 0) metadata.sources = cleaned;
  }
}

export { stampProvenance };
