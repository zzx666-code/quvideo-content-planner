import { createModels, createProvider, envApiKeyAuth, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

export function realModel() {
  if (!process.env.ZHIPU_API_KEY) throw new Error('Real mode requires ZHIPU_API_KEY; offline mode needs no key.');
  const model: Model<'openai-completions'> = {
    id: process.env.ZHIPU_MODEL || 'glm-4.5-air', name: 'Zhipu content planner',
    api: 'openai-completions', provider: 'zhipu',
    baseUrl: process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4/',
    reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
    // Unknown billing rates: reports expose tokens, never claim zero actual billing.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const models = createModels();
  models.setProvider(createProvider({
    id: 'zhipu', models: [model], api: openAICompletionsApi(),
    auth: { apiKey: envApiKeyAuth('Zhipu', ['ZHIPU_API_KEY']) },
  }));
  return { model, streamFn: models.streamSimple.bind(models) };
}

export function requestPayload(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return payload;
  return { ...payload, thinking: { type: 'disabled' }, temperature: 0.2 };
}

export function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  const key = process.env.ZHIPU_API_KEY;
  if (key) message = message.replaceAll(key, '[REDACTED]');
  return message.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').slice(0, 1200);
}
