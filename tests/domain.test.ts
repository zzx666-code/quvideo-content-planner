import assert from 'node:assert/strict';
import test from 'node:test';
import { assess, loadDataset, validateRequest } from '../src/domain.ts';

const now = new Date('2026-10-30T12:00:00Z');
const input = { requestId: 'normal', topic: '字幕功能推广', budget: 10, deadline: '2026-10-31T12:00:00Z' };
test('missing budget and deadline are separately identified; zero budget remains valid', () => {
  assert.match(validateRequest({ ...input, budget: undefined }).issues.join(), /budget/);
  assert.match(validateRequest({ ...input, deadline: undefined }).issues.join(), /deadline/);
  assert.equal(validateRequest({ ...input, budget: 0 }).issues.length, 0);
});
test('unsafe IDs, nonfinite budgets, invalid timezone dates and malformed bodies are rejected', () => {
  for (const value of [null, [], { ...input, requestId: '../escape' }, { ...input, budget: Infinity }, { ...input, deadline: 'tomorrow' }, { ...input, deadline: '2026-10-31T12:00:00' }]) {
    assert.ok(validateRequest(value).issues.length > 0);
  }
});
test('costs use catalog data: premium is 12 and balanced is 8; changed prices alter feasibility', async () => {
  const data = await loadDataset();
  const premium = assess('premium', ['A01'], input, data, now);
  const balanced = assess('balanced', ['A01'], input, data, now);
  assert.equal(premium.totalCost, 12);
  assert.equal(premium.overBudget, 2);
  assert.equal(balanced.totalCost, 8);
  assert.equal(balanced.feasible, true);
  data.strategies.balanced.productionCost = 10;
  assert.equal(assess('balanced', ['A01'], input, data, now).feasible, false);
});
test('deadline uses estimated sequential work duration and rejects expired deadlines', async () => {
  const data = await loadDataset();
  assert.equal(assess('premium', ['A01'], { ...input, budget: 20, deadline: '2026-10-30T12:30:00Z' }, data, now).feasible, false);
  assert.equal(assess('economy', ['A01'], { ...input, deadline: '2026-10-30T11:59:00Z' }, data, now).feasible, false);
});
