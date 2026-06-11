import { requestProviderCompletion } from './provider.js';
import { parseLooseJsonValue } from './semantic-json.js';

async function requestSemanticJudge(request, options) {
  const response = await requestProviderCompletion(request, {
    prompt: options.prompt,
    sessionContext: null,
    systemPrompt: options.systemPrompt
  });
  const value = parseLooseJsonValue(response.text);

  return {
    response,
    text: response.text,
    value
  };
}

export { requestSemanticJudge };
