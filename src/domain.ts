import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const strategies = ['premium', 'balanced', 'economy'] as const;
export type Strategy = typeof strategies[number];
export interface Request {
  requestId: string; topic: string; budget: number; deadline: string; preferredStrategy?: Strategy;
}
export interface Asset { id: string; title: string; tags: string[]; facts: string[]; licenseCost: number }
export interface Rate { label: string; scriptCost: number; productionCost: number; scriptMinutes: number; productionMinutes: number }
export interface Dataset { synthetic: true; version: string; budgetUnit: string; assets: Asset[]; strategies: Record<Strategy, Rate> }
export interface Assessment {
  strategy: Strategy; lines: { item: string; cost: number; minutes: number }[];
  totalCost: number; durationMinutes: number; projectedFinish: string;
  overBudget: number; lateMinutes: number; feasible: boolean;
}
export interface Script {
  id: string; title: string; strategy: Strategy; assetIds: string[];
  scenes: { order: number; assetId: string; visual: string; narration: string }[];
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function validateRequest(value: unknown): { input?: Request; issues: string[] } {
  if (!isRecord(value)) return { issues: ['input must be a JSON object'] };
  const issues: string[] = [];
  if (typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.requestId)) issues.push('requestId: use 1-80 letters, digits, underscores or hyphens');
  if (typeof value.topic !== 'string' || !value.topic.trim() || value.topic.length > 500) issues.push('topic: a nonempty topic of at most 500 characters is required');
  if (typeof value.budget !== 'number' || !Number.isSafeInteger(value.budget) || value.budget < 0) issues.push('budget: a nonnegative integer in simulated units is required');
  if (typeof value.deadline !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value.deadline) || !Number.isFinite(Date.parse(value.deadline))) issues.push('deadline: an ISO date with explicit timezone is required');
  if (value.preferredStrategy !== undefined && !strategies.includes(value.preferredStrategy as Strategy)) issues.push('preferredStrategy must be premium, balanced or economy');
  if (issues.length) return { issues };
  const input = value as unknown as Request;
  return { input: { requestId: input.requestId, topic: input.topic.trim(), budget: input.budget, deadline: new Date(input.deadline).toISOString(), preferredStrategy: input.preferredStrategy || 'premium' }, issues };
}

export async function loadDataset(path?: string): Promise<Dataset> {
  const raw: unknown = JSON.parse(await readFile(path || new URL('../data/dataset.json', import.meta.url), 'utf8'));
  if (!isRecord(raw) || raw.synthetic !== true || typeof raw.version !== 'string' || !Array.isArray(raw.assets) || !isRecord(raw.strategies)) throw new Error('Invalid synthetic dataset');
  const nonnegative = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
  const ids = new Set<string>();
  for (const asset of raw.assets) {
    if (!isRecord(asset) || typeof asset.id !== 'string' || ids.has(asset.id) || typeof asset.title !== 'string' || !Array.isArray(asset.tags) || !asset.tags.every(x => typeof x === 'string') || !Array.isArray(asset.facts) || !asset.facts.length || !asset.facts.every(x => typeof x === 'string') || !nonnegative(asset.licenseCost)) throw new Error('Invalid or duplicate asset');
    ids.add(asset.id);
  }
  for (const name of strategies) {
    const rate = raw.strategies[name];
    if (!isRecord(rate) || typeof rate.label !== 'string' || !['scriptCost', 'productionCost', 'scriptMinutes', 'productionMinutes'].every(key => nonnegative(rate[key]))) throw new Error('Invalid strategy rates');
  }
  return raw as unknown as Dataset;
}

export function assess(strategy: Strategy, assetIds: string[], input: Request, data: Dataset, now: Date): Assessment {
  const rate = data.strategies[strategy];
  const assets = [...new Set(assetIds)].map(id => {
    const asset = data.assets.find(asset => asset.id === id);
    if (!asset) throw new Error(`Unknown asset: ${id}`);
    return asset;
  });
  if (!assets.length) throw new Error('At least one asset is required');
  const lines = [
    ...assets.map(asset => ({ item: `素材 ${asset.id}`, cost: asset.licenseCost, minutes: 0 })),
    { item: '脚本制作', cost: rate.scriptCost, minutes: rate.scriptMinutes },
    { item: rate.label, cost: rate.productionCost, minutes: rate.productionMinutes },
  ];
  const totalCost = lines.reduce((sum, line) => sum + line.cost, 0);
  const durationMinutes = lines.reduce((sum, line) => sum + line.minutes, 0);
  const finish = now.getTime() + durationMinutes * 60000;
  const overBudget = Math.max(0, totalCost - input.budget);
  const lateMinutes = Math.max(0, Math.ceil((finish - Date.parse(input.deadline)) / 60000));
  return { strategy, lines, totalCost, durationMinutes, projectedFinish: new Date(finish).toISOString(), overBudget, lateMinutes, feasible: overBudget === 0 && lateMinutes === 0 };
}
