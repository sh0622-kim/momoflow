// Protocol fixture only. Never invokes Codex, an API, or GitHub.
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
const reply = (id, result) => console.log(JSON.stringify({ id, result }));
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  appendFileSync('.git/mock-rpc.jsonl', JSON.stringify(m) + '\n');
  let mode = '';
  try { mode = readFileSync('.git/rpc-mode', 'utf8'); } catch {}
  if (m.method === 'initialize') reply(m.id, {});
  if (m.method === 'thread/start') reply(m.id, {
    thread: { id: `fixture-${process.pid}` },
    model: mode === 'mismatch' ? 'wrong-model' : m.params.model,
    reasoningEffort: m.params.config.model_reasoning_effort,
    serviceTier: m.params.serviceTier,
    approvalPolicy: m.params.approvalPolicy,
    sandbox: { type: 'workspaceWrite', networkAccess: false }
  });
  if (m.method === 'turn/start') {
    reply(m.id, { turn: { id: 'fixture-turn' } });
    console.log(JSON.stringify({ method: 'turn/completed', params: { turn: { status: mode === 'failed' ? 'failed' : 'completed' } } }));
  }
}
