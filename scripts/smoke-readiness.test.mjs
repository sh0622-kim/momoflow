import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { checkReadiness } from './smoke-readiness.mjs';

const valid = () => Response.json({ running: [], retrying: [] });
const dashboard = () => new Response('<title>Symphony</title>');
const refused = () => new TypeError('fetch failed', { cause: Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }) });
const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

async function probe(api = valid, page = dashboard) {
  const calls = [], delays = [], output = [], errors = [];
  const ready = await checkReadiness({
    fetch: async (url, { signal }) => {
      assert.ok(signal instanceof AbortSignal);
      calls.push(url);
      return url.endsWith('/state') ? api() : page();
    },
    sleep: async ms => delays.push(ms), log: message => output.push(message), error: message => errors.push(message),
  });
  return { ready, calls, delays, output, errors };
}

test('healthy API and dashboard retain success with no retries', async () => {
  const result = await probe();
  assert.equal(result.ready, true);
  assert.deepEqual(result.calls, ['http://127.0.0.1:4000/api/v1/state', 'http://127.0.0.1:4000/']);
  assert.deepEqual(result.delays, []);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.output, ['PASS: Symphony state API and dashboard; no running tasks; network disabled.']);
});

const failures = [
  ['connection cause', () => { throw refused(); }, dashboard, /state API connection:.*fetch failed; caused by:.*ECONNREFUSED.*connect refused/],
  ['API timeout', () => { throw timeout(); }, dashboard, /state API connection: TimeoutError:.*timeout/],
  ['HTTP before JSON', () => new Response('not JSON', { status: 503, statusText: 'Unavailable' }), dashboard, /state API HTTP:.*HTTP 503 Unavailable/],
  ['malformed JSON', () => new Response('{'), dashboard, /state API JSON: SyntaxError:/],
  ['null JSON', () => Response.json(null), dashboard, /state API fields:.*expected a JSON object/],
  ['array JSON', () => Response.json([]), dashboard, /state API fields:.*expected a JSON object/],
  ['primitive JSON', () => Response.json(1), dashboard, /state API fields:.*expected a JSON object/],
  ['state error', () => Response.json({ error: { message: 'engine unavailable' } }), dashboard, /state API fields:.*state.error:.*engine unavailable/],
  ['missing running', () => Response.json({ retrying: [] }), dashboard, /state API fields:.*running must be an array/],
  ['invalid running', () => Response.json({ running: {}, retrying: [] }), dashboard, /state API fields:.*running must be an array/],
  ['missing retrying', () => Response.json({ running: [] }), dashboard, /state API fields:.*retrying must be an array/],
  ['invalid retrying', () => Response.json({ running: [], retrying: null }), dashboard, /state API fields:.*retrying must be an array/],
  ['running tasks', () => Response.json({ running: [{}], retrying: [] }), dashboard, /state API work:.*running=1, retrying=0/],
  ['retrying tasks', () => Response.json({ running: [], retrying: [{}] }), dashboard, /state API work:.*running=0, retrying=1/],
  ['dashboard connection', valid, () => { throw refused(); }, /dashboard connection:.*ECONNREFUSED/],
  ['dashboard timeout', valid, () => { throw timeout(); }, /dashboard connection: TimeoutError:/],
  ['dashboard HTTP', valid, () => new Response('Symphony', { status: 502 }), /dashboard HTTP:.*HTTP 502/],
  ['dashboard content', valid, () => new Response('other app'), /dashboard content:.*missing Symphony content/],
  ['dashboard body read', valid, () => ({ ok: true, text: async () => { throw timeout(); } }), /dashboard content: TimeoutError:/],
  ['API body read', () => ({ ok: true, json: async () => { throw timeout(); } }), dashboard, /state API JSON: TimeoutError:/],
];
for (const [name, api, page, diagnostic] of failures) {
  test(`${name}: last diagnostic after all 30 attempts`, async () => {
    const result = await probe(api, page);
    assert.equal(result.ready, false);
    assert.deepEqual(result.delays, Array(30).fill(500));
    assert.equal(result.calls.filter(url => url.endsWith('/state')).length, 30);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /FAIL: readiness after 30 attempts; last failure:/);
    assert.match(result.errors[0], diagnostic);
    assert.deepEqual(result.output, []);
  });
}

test('transient failures still become ready', async () => {
  let attempt = 0;
  const result = await probe(() => { if (++attempt < 3) throw refused(); return valid(); });
  assert.equal(result.ready, true);
  assert.deepEqual(result.delays, [500, 500]);
  assert.deepEqual(result.errors, []);
});

test('latest failing stage replaces an earlier failure', async () => {
  let attempt = 0;
  const result = await probe(() => { if (++attempt < 30) throw refused(); return valid(); }, () => new Response('wrong page'));
  assert.equal(result.ready, false);
  assert.match(result.errors[0], /dashboard content:.*missing Symphony/);
  assert.doesNotMatch(result.errors[0], /ECONNREFUSED/);
});

// A command fake validates only shell control flow. It cannot validate Docker or the sandbox.
async function shellSmoke(mode, logsFail = false) {
  const dir = await mkdtemp(join(tmpdir(), 'momoflow-smoke-test-'));
  try {
    await writeFile(join(dir, 'docker'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TRACE, JSON.stringify(args) + '\\n');
if (args[0] === 'run' && process.env.MODE === 'startup') {
  console.error('daemon unavailable'); process.exit(125);
}
if (args[0] === 'exec' && args.includes('/checks/scripts/smoke-readiness.mjs')) {
  if (process.env.MODE.startsWith('actual-')) {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(process.execPath, ['--import', process.env.FETCH_FIXTURE, process.env.PROBE], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  }
  else if (['SIGINT', 'SIGTERM'].includes(process.env.MODE)) { process.kill(process.ppid, process.env.MODE); }
  else if (process.env.MODE === 'launch') { console.error('node executable missing'); process.exit(127); }
  else if (process.env.MODE === 'probe') { console.error('FAIL: readiness after 30 attempts; last failure: dashboard HTTP: HTTP 503'); process.exit(1); }
}
if (args[0] === 'exec' && args.includes('/checks/smoke-sandbox.mjs') && process.env.MODE === 'sandbox') process.exit(42);
if (args[0] === 'exec' && args.includes('/checks/scripts/test-role-flow.sh') && process.env.MODE === 'roles') process.exit(43);
if (args[0] === 'logs') { console.error('container diagnostic'); if (process.env.LOGS_FAIL === '1') process.exit(9); }
`, { mode: 0o755 });
    // .mjs syntax is enabled for the extensionless command without changing the real environment.
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    await writeFile(join(dir, 'fetch-fixture.mjs'), `
globalThis.fetch = async url => process.env.MODE === 'actual-failure'
  ? new Response('unavailable', { status: 503 })
  : url.endsWith('/state') ? Response.json({ running: [], retrying: [] }) : new Response('Symphony');
globalThis.setTimeout = callback => { queueMicrotask(callback); };
`);
    const stdout = await open(join(dir, 'stdout'), 'w');
    const stderr = await open(join(dir, 'stderr'), 'w');
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        const child = spawn('sh', ['scripts/smoke.sh'], {
          cwd: new URL('..', import.meta.url), timeout: 10000,
          stdio: ['ignore', stdout.fd, stderr.fd],
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TRACE: join(dir, 'trace'), MODE: mode,
            LOGS_FAIL: logsFail ? '1' : '0', FETCH_FIXTURE: join(dir, 'fetch-fixture.mjs'),
            PROBE: new URL('./smoke-readiness.mjs', import.meta.url).pathname },
        });
        child.on('error', reject);
        child.on('close', (status, signal) => resolve({ status, signal }));
      });
    } finally { await stdout.close(); await stderr.close(); }
    result.stdout = await readFile(join(dir, 'stdout'), 'utf8');
    result.stderr = await readFile(join(dir, 'stderr'), 'utf8');
    const calls = (await readFile(join(dir, 'trace'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.at(-1)[0], 'rm');
    assert.equal(calls.at(-1)[1], '-f');
    assert.equal(calls.at(-1)[2], calls[0][calls[0].indexOf('--name') + 1]);
    return { ...result, calls };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('mock Docker success preserves security flags and all subsequent checks', async () => {
  const result = await shellSmoke('success');
  assert.equal(result.status, 0);
  const run = result.calls[0];
  for (const flag of ['none', 'ALL', 'no-new-privileges']) assert.ok(run.includes(flag));
  assert.ok(run.some(arg => arg.endsWith('security/codex-seccomp.json')));
  assert.deepEqual(result.calls.filter(call => call[0] === 'exec').map(call => call.slice(2)), [
    ['node', '/checks/scripts/smoke-readiness.mjs'], ['codex', '--version'],
    ['node', '/checks/smoke-sandbox.mjs'], ['sh', '/checks/scripts/test-role-flow.sh'],
  ]);
});
test('actual probe CLI with mocked fetch exits zero and lets subsequent checks run', async () => {
  const result = await shellSmoke('actual-success');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /PASS: Symphony state API and dashboard/);
  assert.ok(result.calls.some(call => call.includes('/checks/scripts/test-role-flow.sh')));
});
test('actual probe CLI with mocked fetch prints final diagnostic and exits nonzero', async () => {
  const result = await shellSmoke('actual-failure');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL: readiness after 30 attempts; last failure: state API HTTP: Error: HTTP 503/);
  assert.ok(!result.calls.some(call => call.includes('codex')));
});
for (const [mode, diagnostic, detail] of [
  ['startup', /startup: docker run exited 125/, /daemon unavailable/],
  ['launch', /readiness command: docker exec\/node exited 127/, /node executable missing/],
  ['probe', /readiness command: docker exec\/node exited 1/, /dashboard HTTP: HTTP 503/],
]) {
  test(`mock Docker ${mode}: nonzero, original error, logs and cleanup even if logs fail`, async () => {
    const result = await shellSmoke(mode, true);
    assert.equal(result.status, 1);
    assert.match(result.stderr, diagnostic);
    assert.match(result.stderr, detail);
    assert.match(result.stderr, /container logs unavailable/);
    assert.deepEqual(result.calls.find(call => call[0] === 'logs').slice(0, 3), ['logs', '--tail', '60']);
    assert.ok(!result.calls.some(call => call.includes('codex')));
  });
}
for (const [mode, status] of [['sandbox', 42], ['roles', 43], ['SIGINT', 130], ['SIGTERM', 130]]) {
  test(`mock Docker ${mode} preserves exit and cleanup`, async () => {
    const result = await shellSmoke(mode);
    assert.equal(result.status, status);
  });
}
