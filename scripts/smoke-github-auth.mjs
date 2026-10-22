import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJwt, readToken, refreshToken } from './github-app-auth.mjs';

const directory = await mkdtemp(join(tmpdir(), 'momoflow-auth-'));
try {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = Date.now();
  const config = {
    appId: '123', installationId: '456', repository: 'owner/repository',
    privateKeyFile: join(directory, 'key.pem'), tokenFile: join(directory, 'token.json'),
  };
  await writeFile(config.privateKeyFile, privateKey.export({ type: 'pkcs1', format: 'pem' }), { mode: 0o600 });
  const jwt = createJwt(privateKey, config.appId, now);
  const [header, payload, signature] = jwt.split('.');
  assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')), true);
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.iss, '123');
  assert.equal(claims.exp - claims.iat, 600);
  assert.equal(claims.iat, Math.floor(now / 1000) - 60);
  const expiry = new Date(now + 3600000).toISOString();
  let token = 'fixture-first';
  const request = async (url, options) => {
    assert.equal(url, 'https://api.github.com/app/installations/456/access_tokens');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { repositories: ['repository'] });
    assert.ok(options.headers.Authorization.startsWith('Bearer '));
    return { ok: true, json: async () => ({ token, expires_at: expiry }) };
  };
  await refreshToken(config, request, now);
  assert.equal((await readToken(config.tokenFile, 60000, now)).token, 'fixture-first');
  assert.equal((await stat(config.tokenFile)).mode & 0o777, 0o600);
  token = 'fixture-second';
  await refreshToken(config, request, now);
  assert.equal((await readToken(config.tokenFile, 0, now)).token, token);
  await assert.rejects(refreshToken(config, async () => ({ ok: false, status: 401 }), now));
  assert.equal((await readToken(config.tokenFile, 0, now)).token, token);
  await assert.rejects(refreshToken(config, async () => { throw new Error('network failure'); }, now));
  await assert.rejects(refreshToken(config, async () => ({ ok: true, json: async () => ({ token, expires_at: 'invalid' }) }), now));
  await assert.rejects(refreshToken(config, async () => ({ ok: true, json: async () => ({ token, expires_at: new Date(now).toISOString() }) }), now));
  assert.equal(JSON.parse(await readFile(config.tokenFile)).token, token);
  await assert.rejects(readToken(config.tokenFile, 0, now + 3600000));
  await writeFile(config.tokenFile, '{');
  await assert.rejects(readToken(config.tokenFile));
  await rm(config.tokenFile);
  await assert.rejects(readToken(config.tokenFile));
  console.log('PASS: JWT signature, repository scope, rotation, permissions, failure preservation, expiry, malformed/missing token. No network used.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
