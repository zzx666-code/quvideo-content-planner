import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { runPlanner } from './agent.ts';
import { loadDataset } from './domain.ts';
import { safeError } from './model.ts';
import { writeJson, type ToolName } from './store.ts';

try {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      mode: { type: 'string', default: 'offline' },
      root: { type: 'string' },
      now: { type: 'string' },
      dataset: { type: 'string' },
      report: { type: 'string' },
      resume: { type: 'boolean', default: false },
      help: { type: 'boolean' },
      fail: { type: 'string', multiple: true },
      'max-turns': { type: 'string' },
      'max-tools': { type: 'string' },
      'timeout-ms': { type: 'string' },
    },
  });
  if (values.help || !values.input) {
    console.log(
      'Usage: npm start -- --input FILE [--mode offline|real] [--root DIR] [--now ISO_DATE] [--resume] [--fail TOOL:COUNT] [--dataset FILE] [--report FILE] [--max-turns N] [--max-tools N] [--timeout-ms N]\nExit: 0 completed; 2 needs_input/incomplete/conflict; 1 invalid command/environment. Offline model and all business tools are simulations.',
    );
    if (!values.help) process.exitCode = 1;
  } else {
    if (values.mode !== 'offline' && values.mode !== 'real')
      throw new Error('mode must be offline or real');
    const fixed = values.now ? new Date(values.now) : undefined;
    if (fixed && !Number.isFinite(fixed.getTime())) throw new Error('Invalid --now date');
    const failures: Partial<Record<ToolName, number>> = {};
    for (const spec of values.fail || []) {
      const [tool, count] = spec.split(':');
      if (
        !['search_assets', 'generate_script', 'estimate_plan', 'save_plan'].includes(tool || '') ||
        !Number.isSafeInteger(Number(count)) ||
        Number(count) === 0 ||
        Number(count) < -1
      )
        throw new Error('--fail requires TOOL:positive_count or TOOL:-1 (permanent)');
      failures[tool as ToolName] = Number(count);
    }
    const result = await runPlanner(JSON.parse(await readFile(values.input, 'utf8')), {
      mode: values.mode,
      root: values.root || `.runtime/${values.mode}`,
      clock: fixed ? () => new Date(fixed) : undefined,
      dataset: values.dataset ? await loadDataset(values.dataset) : undefined,
      resume: values.resume,
      failures,
      maxTurns: values['max-turns'] ? Number(values['max-turns']) : undefined,
      maxToolCalls: values['max-tools'] ? Number(values['max-tools']) : undefined,
      timeoutMs: values['timeout-ms'] ? Number(values['timeout-ms']) : undefined,
    });
    if (values.report) await writeJson(values.report, result);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'completed' ? 0 : 2;
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'error', message: safeError(error) }));
  process.exitCode = 1;
}
