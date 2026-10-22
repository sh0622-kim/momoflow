import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { assertMountDenied } from './smoke-sandbox.mjs';

const denied = { status: 32, signal: null, stderr: 'mount: permission denied.' };

test('normally exited mount must report permission denial', () => {
  for (const stderr of ['mount: permission denied.', 'mount: Operation not permitted', 'mount: must be superuser to use mount.']) {
    assert.doesNotThrow(() => assertMountDenied({ ...denied, stderr }));
  }
  for (const status of [0, null, undefined]) {
    assert.throws(() => assertMountDenied({ ...denied, status }));
  }
  assert.throws(() => assertMountDenied({ ...denied, stderr: 'mount: unknown filesystem type' }));
  assert.throws(() => assertMountDenied({ ...denied, error: new Error('spawn failed') }));
  assert.throws(() => assertMountDenied({ ...denied, signal: 'SIGTERM' }));
});

test('real signal termination is rejected', () => {
  const result = spawnSync(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'], { encoding: 'utf8' });
  assert.equal(result.signal, 'SIGTERM');
  assert.throws(() => assertMountDenied(result));
});

test('missing mount is rejected before any success can be reported', () => {
  const mount = spawnSync('mount', [], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
  assert.equal(mount.error?.code, 'ENOENT');
  assert.equal(mount.status, null);
  assert.throws(() => assertMountDenied(mount), /ENOENT/);
});
