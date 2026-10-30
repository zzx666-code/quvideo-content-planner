import { Type, type Static, type TSchema } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { assess, fingerprint, strategies, type Dataset } from './domain.ts';
import { safeError } from './model.ts';
import { StateStore, type RunState, type ToolName } from './store.ts';

const explanation = Type.String({
  minLength: 1,
  maxLength: 300,
  description: 'Brief public action reason based on observed results, not private reasoning.',
});
const strategySchema = Type.Union(strategies.map((name) => Type.Literal(name)));
const assetIdsSchema = Type.Array(Type.String(), { minItems: 1, maxItems: 3, uniqueItems: true });

export function createTools(
  state: RunState,
  data: Dataset,
  store: StateStore,
  clock: () => Date,
  failures: Partial<Record<ToolName, number>> = {},
) {
  const remaining = { ...failures };
  function tool<T extends TSchema>(
    name: ToolName,
    description: string,
    parameters: T,
    execute: (args: Static<T>) => Promise<Record<string, unknown>>,
  ): AgentTool<T, Record<string, unknown>> {
    return {
      name,
      label: name,
      description,
      parameters,
      executionMode: 'sequential',
      execute: async (_callId, args, signal) => {
        signal?.throwIfAborted();
        const attempt = {
          id: state.attempts.length + 1,
          tool: name,
          status: 'running' as const,
          arguments: args,
          summary: '',
          at: new Date().toISOString(),
        };
        state.attempts.push(attempt);
        await store.checkpoint(state);
        let details: Record<string, unknown>;
        try {
          const injected = remaining[name] || 0;
          if (injected !== 0) {
            if (injected > 0) remaining[name] = injected - 1;
            details = {
              ok: false,
              code: 'INJECTED_TOOL_FAILURE',
              retryable: injected > 0,
              message: `Simulated ${name} failure; earlier successful artifacts remain available.`,
            };
          } else details = await execute(args);
        } catch (error) {
          details = { ok: false, code: 'TOOL_ERROR', retryable: false, message: safeError(error) };
        }
        const entry = state.attempts[state.attempts.length - 1]!;
        entry.status = details.ok === false ? 'failed' : 'succeeded';
        entry.result = details;
        entry.summary = JSON.stringify(details);
        await store.checkpoint(state);
        return {
          content: [{ type: 'text', text: entry.summary }],
          details,
          isError: details.ok === false,
        };
      },
    };
  }
  const search = tool(
    'search_assets',
    'Search synthetic assets by keyword. Returns facts and IDs; an empty result is not evidence of invented assets. Rewrite query or stop if needed.',
    Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }), reason: explanation }),
    async (args) => {
      const query = args.query.toLowerCase();
      const assets = data.assets.filter((asset) =>
        [asset.id, asset.title, ...asset.tags].some(
          (tag) => query.includes(tag.toLowerCase()) || tag.toLowerCase().includes(query),
        ),
      );
      state.foundAssetIds = [
        ...new Set([...state.foundAssetIds, ...assets.map((asset) => asset.id)]),
      ];
      return { ok: true, assets, count: assets.length, synthetic: true, dataVersion: data.version };
    },
  );
  const generate = tool(
    'generate_script',
    'Generate an editable draft from retrieved asset facts using a local template. Choose a production strategy; its cost is unknown until estimate_plan. Existing successful drafts can be reused.',
    Type.Object({
      assetIds: assetIdsSchema,
      strategy: strategySchema,
      title: Type.String({ minLength: 1, maxLength: 120 }),
      reason: explanation,
    }),
    async (args) => {
      const selected = args.assetIds.map((id) => {
        const asset = data.assets.find((asset) => asset.id === id);
        if (!asset || !state.foundAssetIds.includes(id))
          throw new Error(`Asset ${id} must be retrieved before use`);
        return asset;
      });
      const id = `S-${fingerprint({ assetIds: args.assetIds, strategy: args.strategy, title: args.title }).slice(0, 12)}`;
      const existing = state.scripts.find((script) => script.id === id);
      if (existing) return { ok: true, script: existing, reused: true };
      const script = {
        id,
        title: args.title,
        strategy: args.strategy,
        assetIds: args.assetIds,
        scenes: selected
          .flatMap((asset) =>
            asset.facts.map((fact) => ({
              order: 0,
              assetId: asset.id,
              visual: `${asset.title}：展示功能操作`,
              narration: fact,
            })),
          )
          .map((scene, index) => ({ ...scene, order: index + 1 })),
      };
      state.scripts.push(script);
      return {
        ok: true,
        script,
        simulatedTool: true,
        note: 'Local template draft; no video was rendered or published. Title is a creative label, narration facts are verbatim synthetic sources.',
      };
    },
  );
  const estimate = tool(
    'estimate_plan',
    'Calculate proposed plan cost and sequential production time from the catalog. Returns actual constraint checks plus alternatives. An infeasible result requires replanning or stopping, not saving.',
    Type.Object({ scriptId: Type.String(), reason: explanation }),
    async (args) => {
      const script = state.scripts.find((script) => script.id === args.scriptId);
      if (!script) throw new Error('Script must be generated first');
      const calculatedAt = clock();
      const assessment = {
        ...assess(script.strategy, script.assetIds, state.request, data, calculatedAt),
        scriptId: script.id,
        dataHash: fingerprint(data),
        calculatedAt: calculatedAt.toISOString(),
      };
      state.estimates[script.id] = assessment;
      return {
        ok: true,
        assessment,
        alternatives: strategies.map((strategy) =>
          assess(strategy, script.assetIds, state.request, data, calculatedAt),
        ),
        budgetUnit: data.budgetUnit,
      };
    },
  );
  const save = tool(
    'save_plan',
    'Save a plan only after generating and estimating this exact script. Rechecks budget and deadline. Success means a local plan file exists; it does not mean content was produced or published.',
    Type.Object({ scriptId: Type.String(), reason: explanation }),
    async (args) => {
      const script = state.scripts.find((script) => script.id === args.scriptId);
      const previous = state.estimates[args.scriptId];
      if (!script || !previous)
        throw new Error('This exact script needs a successful estimate before save');
      if (previous.dataHash !== fingerprint(data) || previous.dataHash !== state.dataHash)
        throw new Error('Dataset changed; estimate is stale');
      const assessment = assess(script.strategy, script.assetIds, state.request, data, clock());
      if (!previous.feasible || !assessment.feasible)
        return {
          ok: false,
          code: 'CONSTRAINT_VIOLATION',
          retryable: false,
          assessment,
          message: 'Cannot save an over-budget or late plan. Replan or return incomplete.',
        };
      const saved = await store.save({
        id: `P-${state.request.requestId}`,
        request: state.request,
        requestHash: state.requestHash,
        dataHash: state.dataHash,
        script,
        assessment,
        savedAt: clock().toISOString(),
        activities: assessment.lines.map((line, index) => ({
          id: `activity-${index + 1}`,
          task: line.item,
          status: 'planned',
          dependsOn: index ? [`activity-${index}`] : [],
          cost: line.cost,
          minutes: line.minutes,
        })),
      });
      state.savedPlan = saved;
      state.estimates[script.id] = { ...previous, ...assessment };
      return {
        ok: true,
        saved,
        assessment,
        note: 'Plan saved locally. Production activities remain planned.',
      };
    },
  );
  return [search, generate, estimate, save];
}
