import { searchGeminiGrounding } from './gemini-grounding.js';
import { searchSearxng } from './searxng.js';

async function searchWeb(request) {
  // Pass signal through so providers can respect deadline/abort.
  const enriched = request.signal ? { ...request } : request;

  if (request.provider === "searxng") {
    return searchSearxng(enriched);
  }

  if (request.provider === "gemini_grounding") {
    return searchGeminiGrounding(enriched);
  }

  throw new Error(`Unsupported web search provider: ${request.provider}`);
}

export { searchWeb };
