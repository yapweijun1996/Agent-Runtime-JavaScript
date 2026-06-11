import { requestDeepSeekChatCompletion } from './providers/deepseek-browser.js';
import { normalizeBrowserProviderRequest } from './providers/request.js';
import { createProviderResponseTrace } from '../runtime/llm-trace.js';

// AGRUN-274a — provider adapter, NOT a Set A skill. `isProviderAdapter`
// tells skill-probe.js to skip this entry.

const deepseekBrowserSkill = {
  name: "deepseek-browser-skill",
  isProviderAdapter: true,

  async execute(context) {
    const request = normalizeBrowserProviderRequest(context.input.raw, "deepseek");

    context.helpers.log({
      type: "provider-requested",
      model: request.model,
      provider: request.provider
    });

    const result = await requestDeepSeekChatCompletion(request, request.fetch);

    context.helpers.log({
      type: "provider-responded",
      finishReason: result.finishReason,
      provider: request.provider,
      requestPayload: result.requestBody,
      responsePayload: createProviderResponseTrace({
        durationMs: result.durationMs,
        finishReason: result.finishReason,
        model: request.model,
        provider: request.provider,
        response: result.raw,
        status: result.status,
        text: result.text,
        usage: result.usage
      })
    });

    return {
      endpoint: result.endpoint,
      durationMs: result.durationMs,
      finishReason: result.finishReason,
      model: request.model,
      multimodal: request.multimodal || null,
      provider: request.provider,
      raw: result.raw,
      reasoningSummary: result.reasoningSummary || null,
      requestBody: result.requestBody,
      status: result.status,
      text: result.text,
      usage: result.usage
    };
  }
};

export { deepseekBrowserSkill };
