import { mkdir, readFile, rename, writeFile, link, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Request, Script, Assessment } from './domain.ts';

export type ToolName = 'search_assets' | 'generate_script' | 'estimate_plan' | 'save_plan';
export interface Attempt {
  id: number;
  tool: ToolName;
  status: 'running' | 'succeeded' | 'failed';
  arguments: unknown;
  summary: string;
  result?: Record<string, unknown>;
  at: string;
}
export interface TraceEntry {
  seq: number;
  at: string;
  event: string;
  turn: number;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  reason?: string;
}
export interface Estimate extends Assessment {
  scriptId: string;
  dataHash: string;
  calculatedAt: string;
}
export interface SavedPlan {
  id: string;
  requestHash: string;
  dataHash: string;
  request: Request;
  script: Script;
  assessment: Assessment;
  savedAt: string;
  activities: {
    id: string;
    task: string;
    dependsOn: string[];
    status: 'planned';
    cost: number;
    minutes: number;
  }[];
}
export interface Metrics {
  turns: number;
  toolCalls: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  apiCost: null;
}
export interface RunResult {
  status: 'needs_input' | 'completed' | 'incomplete' | 'conflict';
  code: string;
  reason: string;
  input?: Request;
  issues?: string[];
  scripts: Script[];
  attempts: Attempt[];
  estimate?: Estimate;
  savedPlan?: { id: string; path: string; scriptId: string };
  constraints?: {
    minimumRequiredBudget: number;
    minimumDurationMinutes: number;
    budgetShortfall: number;
    timeShortfallMinutes: number;
  };
  trace: TraceEntry[];
  metrics: Metrics;
  reused?: boolean;
  resumed?: boolean;
  model: { mode: 'real' | 'offline'; provider: string; id: string };
  clock: { source: 'system' | 'fixed'; asOf: string };
  datasetVersion: string;
}
export interface RunState {
  request: Request;
  requestHash: string;
  dataHash: string;
  foundAssetIds: string[];
  scripts: Script[];
  estimates: Record<string, Estimate>;
  attempts: Attempt[];
  trace: TraceEntry[];
  savedPlan?: { id: string; path: string; scriptId: string };
  result?: RunResult;
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
export class StateStore {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  async load(id: string): Promise<RunState | undefined> {
    try {
      return JSON.parse(
        await readFile(join(this.root, 'requests', `${id}.json`), 'utf8'),
      ) as RunState;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }
  async checkpoint(state: RunState): Promise<void> {
    await writeJson(join(this.root, 'requests', `${state.request.requestId}.json`), state);
  }
  async save(plan: SavedPlan): Promise<{ id: string; path: string; scriptId: string }> {
    const relative = `plans/${plan.request.requestId}.json`;
    const target = join(this.root, relative);
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
      try {
        await link(temp, target);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        const existing = JSON.parse(await readFile(target, 'utf8')) as SavedPlan;
        if (
          existing.requestHash !== plan.requestHash ||
          existing.dataHash !== plan.dataHash ||
          existing.script.id !== plan.script.id
        )
          throw new Error('A different plan already exists for this request ID');
      }
    } finally {
      await unlink(temp).catch(() => undefined);
    }
    return { id: plan.id, path: relative, scriptId: plan.script.id };
  }
}
