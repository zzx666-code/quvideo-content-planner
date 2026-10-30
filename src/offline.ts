import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  isModelType,
  type FauxResponseStep,
} from '@earendil-works/pi-ai';
import { isRecord, type Request } from './domain.ts';
import type { RunState } from './store.ts';

// Deterministic test policy, NOT evidence of real LLM reasoning.
export function offlineModel(input: Request, state: RunState, responses?: FauxResponseStep[]) {
  const faux = fauxProvider({
    provider: 'offline',
    models: [{ id: 'deterministic-policy', input: ['text'] }],
  });
  const action = (name: string, args: Record<string, unknown>, reason: string) =>
    fauxAssistantMessage(fauxToolCall(name, { ...args, reason }), { stopReason: 'toolUse' });
  const factory: FauxResponseStep = (context) => {
    const last = context.messages.filter((message) => message.role === 'toolResult').at(-1);
    if (last?.role === 'toolResult' && last.isError) {
      const attempt = state.attempts.at(-1);
      if (attempt?.result?.retryable === true)
        return action(
          attempt.tool,
          isRecord(attempt.arguments) ? attempt.arguments : {},
          '工具明确返回可重试，保留成功素材并重试失败步骤。',
        );
      return fauxAssistantMessage('工具无法继续执行，返回未完成并保留成功结果。');
    }
    if (!state.foundAssetIds.length) {
      if (state.attempts.filter((attempt) => attempt.tool === 'search_assets').length >= 2)
        return fauxAssistantMessage('两次检索无素材，请补充资料。');
      return action(
        'search_assets',
        { query: last ? '内容' : input.topic },
        last ? '首次检索无结果，改写查询补查。' : '先检索主题相关的合成素材。',
      );
    }
    const script = state.scripts.at(-1);
    if (!script)
      return action(
        'generate_script',
        {
          assetIds: [state.foundAssetIds[0]],
          strategy: input.preferredStrategy || 'premium',
          title: input.topic,
        },
        '使用已检索事实和首选制作档位生成初稿。',
      );
    const estimate = state.estimates[script.id];
    if (!estimate)
      return action(
        'estimate_plan',
        { scriptId: script.id },
        '获取费用与耗时计算结果后再决定是否保存。',
      );
    if (estimate.feasible)
      return action(
        'save_plan',
        { scriptId: script.id },
        '最新估算同时满足预算与截止时间，提交本地保存。',
      );
    const result = state.attempts
      .filter((attempt) => attempt.tool === 'estimate_plan')
      .at(-1)?.result;
    const alternatives = Array.isArray(result?.alternatives) ? result.alternatives : [];
    const alternative = alternatives.find(
      (value: unknown) => isRecord(value) && value.feasible === true,
    );
    if (isRecord(alternative))
      return action(
        'generate_script',
        { assetIds: script.assetIds, strategy: alternative.strategy, title: script.title },
        '已观察到当前方案超限，使用估算工具返回的可行替代档位重规划。',
      );
    return fauxAssistantMessage('预算或截止时间不支持任何候选方案，请调整约束。');
  };
  faux.setResponses(responses || Array.from({ length: 100 }, () => factory));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  if (!isModelType(model, 'chat')) throw new Error('Offline chat model missing');
  return { model, streamFn: models.streamSimple.bind(models) };
}
