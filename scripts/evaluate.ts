import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runPlanner, type RunOptions } from '../src/agent.ts';
import { fingerprint, loadDataset, type Dataset } from '../src/domain.ts';
import { writeJson, type RunResult } from '../src/store.ts';
import { safeError } from '../src/model.ts';

const { values } = parseArgs({ options: { mode: { type: 'string', default: 'offline' } } });
if (values.mode !== 'offline' && values.mode !== 'real')
  throw new Error('mode must be offline or real');
const mode = values.mode;
const runId = new Date().toISOString().replaceAll(/[:.]/g, '-');
const sourceFiles = [
  'package.json',
  'package-lock.json',
  'src/agent.ts',
  'src/cli.ts',
  'src/domain.ts',
  'src/model.ts',
  'src/offline.ts',
  'src/store.ts',
  'src/tools.ts',
  'scripts/evaluate.ts',
  'data/dataset.json',
];
const sourceManifest = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (path) => [path, fingerprint(await readFile(path, 'utf8'))]),
  ),
);
const implementationHash = fingerprint(sourceManifest);
const referenceTime = '2026-10-30T12:00:00Z';
const baseInput = {
  requestId: 'placeholder',
  topic: '字幕功能推广活动',
  budget: 10,
  deadline: '2030-10-31T18:00:00+08:00',
  preferredStrategy: 'premium',
};
interface Case {
  name: string;
  input: unknown;
  status: RunResult['status'];
  options?: RunOptions;
  dataset?: Dataset;
  check?: (result: RunResult) => void;
}
const changed = await loadDataset();
changed.version += '-balanced-expensive';
changed.strategies.balanced.productionCost = 17;
const empty = await loadDataset();
empty.version += '-empty';
empty.assets = [];
const cases: Case[] = [
  {
    name: 'normal',
    input: { ...baseInput, budget: 20 },
    status: 'completed',
    check: (result) => assert.equal(result.estimate?.totalCost, 12),
  },
  {
    name: 'budget-replan',
    input: baseInput,
    status: 'completed',
    check: (result) => {
      assert.ok(result.estimate && result.estimate.totalCost <= 10);
      assert.ok(result.scripts.length >= 2);
      assert.ok(
        result.attempts.some(
          (attempt) =>
            attempt.tool === 'estimate_plan' &&
            JSON.stringify(attempt.result).includes('"overBudget":2'),
        ),
      );
    },
  },
  {
    name: 'missing-budget',
    input: { ...baseInput, budget: undefined },
    status: 'needs_input',
    check: (result) => assert.equal(result.metrics.turns, 0),
  },
  { name: 'missing-deadline', input: { ...baseInput, deadline: undefined }, status: 'needs_input' },
  {
    name: 'tool-failure',
    input: baseInput,
    status: 'completed',
    options: { failures: { generate_script: 1 } },
    check: (result) => {
      assert.ok(result.attempts.some((attempt) => attempt.status === 'failed'));
      assert.ok(
        result.attempts.some(
          (attempt) => attempt.tool === 'generate_script' && attempt.status === 'succeeded',
        ),
      );
      assert.equal(result.attempts.filter((attempt) => attempt.tool === 'search_assets').length, 1);
    },
  },
  {
    name: 'changed-prices',
    input: baseInput,
    dataset: changed,
    status: 'completed',
    check: (result) => {
      assert.equal(result.estimate?.strategy, 'economy');
      assert.equal(result.estimate?.totalCost, 4);
    },
  },
  {
    name: 'no-feasible-plan',
    input: { ...baseInput, budget: 1 },
    status: 'incomplete',
    check: (result) => assert.equal(result.constraints?.budgetShortfall, 3),
  },
  {
    name: 'deadline-failure',
    input: { ...baseInput, deadline: '2026-10-30T12:10:00Z' },
    status: 'incomplete',
  },
  {
    name: 'no-materials',
    input: baseInput,
    dataset: empty,
    status: 'incomplete',
    check: (result) => assert.equal(result.scripts.length, 0),
  },
  {
    name: 'save-failure',
    input: baseInput,
    status: 'incomplete',
    options: { failures: { save_plan: -1 } },
  },
  {
    name: 'turn-limit',
    input: baseInput,
    status: 'incomplete',
    options: { maxTurns: 1 },
    check: (result) => assert.equal(result.code, 'TURN_LIMIT'),
  },
  {
    name: 'tool-limit',
    input: baseInput,
    status: 'incomplete',
    options: { maxToolCalls: 1 },
    check: (result) => assert.equal(result.code, 'TOOL_LIMIT'),
  },
];
const selected =
  mode === 'real'
    ? cases.filter((item) =>
        [
          'normal',
          'budget-replan',
          'missing-budget',
          'missing-deadline',
          'tool-failure',
          'changed-prices',
        ].includes(item.name),
      )
    : cases;
const summaries: Record<string, unknown>[] = [];
const started = performance.now();
for (const item of selected) {
  const input = { ...(item.input as Record<string, unknown>), requestId: `${mode}-${item.name}` };
  const root = join('.runtime', 'evaluation', mode, runId, item.name);
  const options: RunOptions = {
    mode,
    root,
    clock: () => new Date(referenceTime),
    dataset: item.dataset,
    ...item.options,
  };
  const out = join('examples', mode, item.name);
  await mkdir(out, { recursive: true });
  await writeJson(join(out, 'input.json'), input);
  if (item.dataset) await writeJson(join(out, 'dataset.json'), item.dataset);
  const result = await runPlanner(input, options);
  await writeJson(join(out, 'output.json'), result);
  await writeFile(
    join(out, 'trace.jsonl'),
    result.trace.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
  if (result.savedPlan) {
    const saved: unknown = JSON.parse(await readFile(join(root, result.savedPlan.path), 'utf8'));
    await writeJson(join(out, 'saved-plan.json'), saved);
  }
  let error: string | undefined;
  try {
    assert.equal(result.status, item.status);
    if (result.status === 'completed') assert.ok(result.savedPlan && result.estimate?.feasible);
    else assert.equal(result.savedPlan, undefined);
    item.check?.(result);
    if (item.name === 'normal') {
      const repeated = await runPlanner(input, options);
      await writeJson(join(out, 'repeat-output.json'), repeated);
      assert.equal(repeated.reused, true);
      assert.equal(repeated.metrics.toolCalls, 0);
      assert.equal((await readdir(join(root, 'plans'))).length, 1);
      const conflict = await runPlanner({ ...input, budget: 99 }, options);
      await writeJson(join(out, 'conflict-output.json'), conflict);
      assert.equal(conflict.status, 'conflict');
    }
    if (item.name === 'save-failure') {
      const resumed = await runPlanner(input, { ...options, failures: {}, resume: true });
      await writeJson(join(out, 'resume-output.json'), resumed);
      assert.equal(resumed.status, 'completed');
      assert.equal(
        resumed.attempts.filter((attempt) => attempt.tool === 'generate_script').length,
        result.attempts.filter((attempt) => attempt.tool === 'generate_script').length,
      );
      if (resumed.savedPlan)
        await writeJson(
          join(out, 'resumed-saved-plan.json'),
          JSON.parse(await readFile(join(root, resumed.savedPlan.path), 'utf8')),
        );
    }
  } catch (failure) {
    error = safeError(failure);
  }
  const summary = {
    name: item.name,
    passed: !error,
    expected: item.status,
    actual: result.status,
    code: result.code,
    cost: result.estimate?.totalCost,
    turns: result.metrics.turns,
    toolCalls: result.metrics.toolCalls,
    durationMs: result.metrics.durationMs,
    error,
  };
  await writeJson(join(out, 'check.json'), summary);
  summaries.push(summary);
  console.log(JSON.stringify(summary));
}
const report = {
  implementationHash,
  sourceManifest,
  nodeVersion: process.version,
  mode,
  model: mode === 'real' ? process.env.ZHIPU_MODEL || 'glm-4.5-air' : 'deterministic-policy',
  runId,
  actualRunAt: new Date().toISOString(),
  scenarioClock: referenceTime,
  elapsedMs: Math.round(performance.now() - started),
  passed: summaries.every((item) => item.passed),
  cases: summaries,
  note:
    mode === 'offline'
      ? 'Deterministic simulation validates workflow, not real model decisions.'
      : 'Actual model calls with simulated business tools and a fixed scenario clock.',
};
await writeJson(join('examples', mode, 'summary.json'), report);
process.exitCode = report.passed ? 0 : 1;
