// Configuration query only: deliberately never sends turn/start.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';

const approvalPolicy = { granular: Object.fromEntries(['sandbox_approval', 'rules', 'mcp_elicitations', 'request_permissions', 'skill_approval'].map(k => [k, false])) };
const probeHome = await mkdtemp('/tmp/momoflow-settings-');
const model = 'gpt-6.1-sol', effort = 'medium';
{
  const child = spawn('codex', ['app-server', '--strict-config', '-c', `model="${model}"`, '-c', `model_reasoning_effort="${effort}"`, '-c', 'service_tier="default"'], { env: { ...process.env, CODEX_HOME: probeHome }, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  let id = 0;
  const threads = new Set();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const key = ++id;
    const timeout = setTimeout(() => { pending.delete(key); reject(new Error(`${method} timed out`)); }, 15000);
    pending.set(key, msg => { clearTimeout(timeout); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); });
    child.stdin.write(JSON.stringify({ id: key, method, params }) + '\n');
  });
  try {
    await request('initialize', { clientInfo: { name: 'momoflow-settings-check', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    for (const [role, model, effort] of [['plan', 'gpt-6-astra', 'high'], ['build', 'gpt-6.1-sol', 'medium'], ['review', 'gpt-6-astra', 'high'], ['build', 'gpt-6.1-sol', 'medium']]) {
    const r = await request('thread/start', { cwd: process.cwd(), model, serviceTier: 'default', config: { model_reasoning_effort: effort }, approvalPolicy, sandbox: 'workspace-write', ephemeral: true });
    assert.equal(r.model, model);
    assert.equal(r.reasoningEffort, effort);
    assert.equal(r.serviceTier, 'default');
    assert.deepEqual(r.approvalPolicy, approvalPolicy);
    assert.equal(r.sandbox.type, 'workspaceWrite');
    assert.equal(r.sandbox.networkAccess, false);
    assert.ok(r.thread.id && !threads.has(r.thread.id));
    threads.add(r.thread.id);
    console.log(JSON.stringify({ role, model: r.model, effort: r.reasoningEffort, serviceTier: r.serviceTier, thread: r.thread.id, sandbox: r.sandbox.type, networkAccess: r.sandbox.networkAccess, approvals: 'all false', modelTurn: false }));
    }
  } finally {
    lines.close();
    child.stdin.destroy();
    child.stdout.destroy();
    child.unref();
    try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
    await rm(probeHome, { recursive: true, force: true });
  }
}
