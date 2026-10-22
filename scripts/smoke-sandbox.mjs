import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function assertMountDenied(mount) {
  assert.ifError(mount.error);
  assert.equal(mount.signal, null, 'Mount probe terminated by signal');
  assert.ok(Number.isInteger(mount.status) && mount.status > 0,
    'Mount probe must exit normally with a nonzero status');
  assert.match(mount.stderr, /permission denied|operation not permitted|must be superuser/i,
    'Mount probe failed without evidence of permission denial');
}

async function smoke() {
const workspace = await mkdtemp('/data/workspaces/sandbox-check-');
const outside = await mkdtemp('/home/momo/sandbox-check-');
const canary = join(outside, 'canary');
const server = createServer(socket => { socket.on('error', () => {}); socket.end(); });
try {
  await writeFile(canary, 'unchanged');
  await mkdir(join(workspace, 'mount-target'));
  const mount = spawnSync('mount', ['-t', 'tmpfs', 'tmpfs', join(workspace, 'mount-target')], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  assertMountDenied(mount);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
  });
  const probe = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const net = require('node:net');
    fs.writeFileSync('inside', 'allowed');
    assert.equal(fs.readFileSync('inside', 'utf8'), 'allowed');
    assert.equal(fs.readFileSync(${JSON.stringify(canary)}, 'utf8'), 'unchanged');
    assert.throws(() => fs.writeFileSync(${JSON.stringify(canary)}, 'forbidden'), error => ['EROFS','EACCES','EPERM'].includes(error.code));
    fs.symlinkSync(${JSON.stringify(canary)}, 'outside-link');
    assert.throws(() => fs.writeFileSync('outside-link', 'forbidden'), error => ['EROFS','EACCES','EPERM'].includes(error.code));
    const socket = net.connect(${port}, '127.0.0.1');
    const timeout = setTimeout(() => { socket.destroy(); console.log('PASS: network isolated'); }, 1500);
    socket.once('connect', () => { clearTimeout(timeout); socket.destroy(); console.error('Network boundary failed'); process.exitCode = 1; });
    socket.once('error', () => { clearTimeout(timeout); console.log('PASS: network blocked'); });
  `;
  const status = await new Promise((resolve, reject) => {
    const child = spawn('codex', ['sandbox', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=false', '--', 'node', '-e', probe], { cwd: workspace, stdio: 'inherit' });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Sandbox test timed out')); }, 20000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(status, 0, 'Sandbox probe failed');
  assert.equal(await readFile(join(workspace, 'inside'), 'utf8'), 'allowed');
  assert.equal(await readFile(canary, 'utf8'), 'unchanged');
  console.log('PASS: real Codex sandbox executes; workspace writes allowed; outside/symlink writes and network blocked; outer mount privileges absent. No model call.');
} finally {
  server.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await smoke();
}
