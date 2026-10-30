import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { realModel, requestPayload, safeError } from '../src/model.ts';

const started = Date.now();
const events: unknown[] = [];
let calls = 0;
const runtime = realModel();
const schema = Type.Object({ stage: Type.Integer(), token: Type.Optional(Type.String()) });
const probe: AgentTool<typeof schema> = {
  name: 'probe', label: 'probe', description: 'Stage 1 returns a token; stage 2 requires that token.',
  parameters: schema,
  execute: async (_id, args) => {
    calls++;
    if (args.stage === 2) assert.equal(args.token, 'observation-47');
    const result = { stage: args.stage, token: 'observation-47', ok: true };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
  },
};
const agent = new Agent({
  streamFn: runtime.streamFn, onPayload: requestPayload, toolExecution: 'sequential',
  initialState: {
    model: runtime.model,
    systemPrompt: 'Compatibility probe. Call probe with stage=1. Observe its result, then call probe with stage=2 and the observed token. After the second result, say done. Never fabricate results.',
    tools: [probe],
  },
  finishTurn: () => calls >= 2 ? { action: 'end' } : undefined,
});
const timer = setTimeout(() => agent.abort(), 90000);
agent.subscribe(event => {
  if (event.type === 'tool_execution_start') events.push({ type: event.type, tool: event.toolName, args: event.args });
  if (event.type === 'tool_execution_end') events.push({ type: event.type, result: event.result.details, error: event.isError });
});
try {
  await agent.prompt('Run the two-stage probe, one tool call per response.');
  assert.equal(calls, 2, safeError(agent.state.errorMessage || 'Two dependent tool calls required'));
  const result = { passed: true, provider: 'zhipu', model: process.env.ZHIPU_MODEL || 'glm-4.5-air', durationMs: Date.now() - started, events };
  await mkdir('examples', { recursive: true });
  await writeFile('examples/compatibility.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
