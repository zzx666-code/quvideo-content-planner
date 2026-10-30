import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai';
import { runPlanner } from '../src/agent.ts';
import { fingerprint, loadDataset } from '../src/domain.ts';

const input = { requestId: 'guard', topic: '字幕', budget: 20, deadline: '2026-10-30T13:40:00Z' };
async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'quvideo-guard-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir(), 'quvideo-guard-')));
    await rm(root, { recursive: true, force: true });
  });
  return { root, mode: 'offline' as const, clock: () => new Date('2026-10-30T12:00:00Z') };
}
const call = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage(fauxToolCall(name, { ...args, reason: '测试业务约束是否由代码执行。' }), {
    stopReason: 'toolUse',
  });
const scriptArgs = { assetIds: ['A01'], strategy: 'premium', title: '字幕推广' };
const scriptId = `S-${fingerprint(scriptArgs).slice(0, 12)}`;
const prefix = () => [
  call('search_assets', { query: '字幕' }),
  call('generate_script', scriptArgs),
];

test('model text claiming success never marks an unsaved task completed', async (t) => {
  const result = await runPlanner(input, {
    ...(await setup(t)),
    fauxResponses: [fauxAssistantMessage('所有任务已完成，方案已保存。')],
  });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.savedPlan, undefined);
});
test('direct saving without estimating is rejected', async (t) => {
  const result = await runPlanner(input, {
    ...(await setup(t)),
    fauxResponses: [...prefix(), call('save_plan', { scriptId }), fauxAssistantMessage('停止')],
  });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.attempts.at(-1)?.status, 'failed');
});
test('even an explicit model save call cannot override budget constraints', async (t) => {
  const result = await runPlanner(
    { ...input, budget: 1 },
    {
      ...(await setup(t)),
      fauxResponses: [
        ...prefix(),
        call('estimate_plan', { scriptId }),
        call('save_plan', { scriptId }),
        fauxAssistantMessage('停止'),
      ],
    },
  );
  assert.equal(result.status, 'incomplete');
  assert.equal(result.attempts.at(-1)?.result?.code, 'CONSTRAINT_VIOLATION');
});
test('save rechecks deadline after time advances beyond a previously valid estimate', async (t) => {
  const options = await setup(t);
  let now = new Date('2026-10-30T12:00:00Z');
  const advance: FauxResponseStep = () => {
    now = new Date('2026-10-30T12:30:00Z');
    return call('save_plan', { scriptId });
  };
  const result = await runPlanner(input, {
    ...options,
    clock: () => now,
    fauxResponses: [
      ...prefix(),
      call('estimate_plan', { scriptId }),
      advance,
      fauxAssistantMessage('停止'),
    ],
  });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.attempts.at(-1)?.result?.code, 'CONSTRAINT_VIOLATION');
});
test('tool cap also applies to multiple calls emitted in one model response', async (t) => {
  const batch = fauxAssistantMessage(
    [
      fauxToolCall('search_assets', { query: '字幕', reason: '检索' }),
      fauxToolCall('generate_script', { ...scriptArgs, reason: '生成' }),
    ],
    { stopReason: 'toolUse' },
  );
  const result = await runPlanner(input, {
    ...(await setup(t)),
    maxToolCalls: 1,
    fauxResponses: [batch],
  });
  assert.equal(result.code, 'TOOL_LIMIT');
  assert.equal(result.metrics.toolCalls, 1);
  assert.equal(result.scripts.length, 0);
});
test('offline cache cannot masquerade as a real model run in the same storage', async (t) => {
  const options = await setup(t);
  await runPlanner(input, options);
  const result = await runPlanner(input, { ...options, mode: 'real' });
  assert.equal(result.status, 'conflict');
  assert.equal(result.metrics.turns, 0);
});
test('saved plan and reported estimate refer to the same selected script', async (t) => {
  const options = await setup(t);
  const result = await runPlanner(input, {
    ...options,
    fauxResponses: [
      ...prefix(),
      call('estimate_plan', { scriptId }),
      call('generate_script', { ...scriptArgs, strategy: 'balanced' }),
      call('save_plan', { scriptId }),
    ],
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.estimate?.scriptId, scriptId);
  assert.equal(result.estimate?.totalCost, 12);
  assert.equal((await readdir(join(options.root, 'plans'))).length, 1);
});
test('premature stop with a known feasible candidate gets validation feedback and a model-selected correction', async (t) => {
  const options = await setup(t);
  const dataset = await loadDataset();
  dataset.strategies.balanced.productionCost = 17;
  const economyArgs = { ...scriptArgs, strategy: 'economy' };
  const economyId = `S-${fingerprint(economyArgs).slice(0, 12)}`;
  const result = await runPlanner(
    { ...input, budget: 10 },
    {
      ...options,
      dataset,
      fauxResponses: [
        ...prefix(),
        call('estimate_plan', { scriptId }),
        fauxAssistantMessage('没有合适的方案。'),
        call('generate_script', economyArgs),
        call('estimate_plan', { scriptId: economyId }),
        call('save_plan', { scriptId: economyId }),
      ],
    },
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.estimate?.totalCost, 4);
  assert.equal(result.trace.filter((entry) => entry.event === 'validation_feedback').length, 1);
});
