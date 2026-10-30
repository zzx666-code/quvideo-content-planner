import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { runPlanner } from '../src/agent.ts';
import { loadDataset } from '../src/domain.ts';

const clock = () => new Date('2026-10-30T12:00:00Z');
const input = {
  requestId: 'case',
  topic: '字幕功能推广',
  budget: 10,
  deadline: '2026-10-31T12:00:00Z',
};
async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'quvideo-test-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir(), 'quvideo-test-')));
    await rm(root, { recursive: true, force: true });
  });
  return { root, mode: 'offline' as const, clock };
}
test('normal request saves a real plan; repeat reuses it, changed request conflicts', async (t) => {
  const options = await setup(t);
  const first = await runPlanner({ ...input, budget: 20 }, options);
  assert.equal(first.status, 'completed');
  assert.equal(first.estimate?.totalCost, 12);
  assert.ok(first.savedPlan);
  const stored = JSON.parse(await readFile(join(options.root, first.savedPlan.path), 'utf8'));
  assert.equal(stored.assessment.totalCost, 12);
  const repeat = await runPlanner({ ...input, budget: 20 }, options);
  assert.equal(repeat.reused, true);
  assert.equal(repeat.metrics.toolCalls, 0);
  assert.equal((await readdir(join(options.root, 'plans'))).length, 1);
  assert.equal((await runPlanner({ ...input, budget: 30 }, options)).status, 'conflict');
});
test('budget rejection leads to a feasible alternative using actual catalog results', async (t) => {
  const result = await runPlanner(input, await setup(t));
  assert.equal(result.status, 'completed');
  assert.equal(result.estimate?.totalCost, 8);
  assert.ok(
    result.attempts.some((x) => x.tool === 'estimate_plan' && x.summary.includes('overBudget')),
  );
  assert.equal(result.scripts.length, 2);
});
test('missing budget and missing deadline never invoke a model or save a plan', async (t) => {
  const options = await setup(t);
  for (const value of [
    { ...input, budget: undefined },
    { ...input, deadline: undefined },
  ]) {
    const result = await runPlanner(value, options);
    assert.equal(result.status, 'needs_input');
    assert.equal(result.metrics.turns, 0);
    assert.equal(result.savedPlan, undefined);
  }
});
test('one tool failure is visible, recovery preserves earlier successful retrieval', async (t) => {
  const result = await runPlanner(input, { ...(await setup(t)), failures: { generate_script: 1 } });
  assert.equal(result.status, 'completed');
  assert.equal(result.attempts.filter((x) => x.tool === 'search_assets').length, 1);
  assert.equal(result.attempts.filter((x) => x.status === 'failed').length, 1);
  assert.ok(result.attempts.some((x) => x.tool === 'generate_script' && x.status === 'succeeded'));
});
test('permanent save failure never reports completion; explicit resume reuses the script', async (t) => {
  const options = await setup(t);
  const failed = await runPlanner(input, { ...options, failures: { save_plan: -1 } });
  assert.equal(failed.status, 'incomplete');
  assert.equal(failed.savedPlan, undefined);
  const generated = failed.attempts.filter((x) => x.tool === 'generate_script').length;
  const resumed = await runPlanner(input, { ...options, resume: true });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.attempts.filter((x) => x.tool === 'generate_script').length, generated);
});
test('no feasible budget, expired deadline and no materials remain incomplete', async (t) => {
  const options = await setup(t);
  const noBudget = await runPlanner({ ...input, requestId: 'poor', budget: 1 }, options);
  assert.equal(noBudget.status, 'incomplete');
  assert.equal(noBudget.savedPlan, undefined);
  assert.equal(noBudget.constraints?.budgetShortfall, 3);
  const late = await runPlanner(
    { ...input, requestId: 'late', deadline: '2026-10-30T11:00:00Z' },
    options,
  );
  assert.equal(late.status, 'incomplete');
  const dataset = await loadDataset();
  dataset.assets = [];
  const empty = await runPlanner({ ...input, requestId: 'empty' }, { ...options, dataset });
  assert.equal(empty.status, 'incomplete');
  assert.equal(empty.scripts.length, 0);
});
test('a stalled provider is aborted at the wall-clock timeout', async (t) => {
  const result = await runPlanner(input, {
    ...(await setup(t)),
    timeoutMs: 20,
    fauxResponses: [
      (_context, options) =>
        new Promise((resolve) => {
          const finish = () =>
            resolve(
              fauxAssistantMessage('aborted', { stopReason: 'aborted', errorMessage: 'aborted' }),
            );
          if (options?.signal?.aborted) finish();
          else options?.signal?.addEventListener('abort', finish, { once: true });
        }),
    ],
  });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.code, 'TIMEOUT');
  assert.ok(result.metrics.durationMs < 2000);
});
test('model turns and actual tool executions are independently bounded', async (t) => {
  const options = await setup(t);
  const turns = await runPlanner(
    { ...input, requestId: 'turn-limit' },
    { ...options, maxTurns: 1 },
  );
  assert.equal(turns.code, 'TURN_LIMIT');
  assert.equal(turns.metrics.turns, 1);
  const tools = await runPlanner(
    { ...input, requestId: 'tool-limit' },
    { ...options, maxToolCalls: 1 },
  );
  assert.equal(tools.code, 'TOOL_LIMIT');
  assert.equal(tools.metrics.toolCalls, 1);
  assert.equal(tools.savedPlan, undefined);
});
test('an actual filesystem save error remains incomplete and retains generated scripts', async (t) => {
  const options = await setup(t);
  await writeFile(join(options.root, 'plans'), 'This file deliberately blocks the plan directory.');
  const result = await runPlanner(input, options);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.attempts.at(-1)?.result?.code, 'TOOL_ERROR');
  assert.ok(result.scripts.length > 0);
  assert.equal(result.savedPlan, undefined);
});
