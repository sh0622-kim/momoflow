import { createPrivateKey, sign } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createJwt(privateKey, appId, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: issuedAt - 60, exp: issuedAt + 540, iss: appId })}`;
  return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`;
}

export async function readToken(filename, minimumLifetime = 0, now = Date.now()) {
  const record = JSON.parse(await readFile(filename, 'utf8'));
  if (typeof record.token !== 'string' || !record.token.trim() ||
      !Number.isFinite(Date.parse(record.expires_at)) ||
      Date.parse(record.expires_at) <= now + minimumLifetime) {
    throw new Error('Token unavailable or expired');
  }
  return record;
}

export async function refreshToken(config, request = fetch, now = Date.now()) {
  const privateKey = createPrivateKey(await readFile(config.privateKeyFile));
  const response = await request(`https://api.github.com/app/installations/${config.installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${createJwt(privateKey, config.appId, now)}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'momoflow-app-auth',
    },
    body: JSON.stringify({ repositories: [config.repository.split('/')[1]] }),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`GitHub token issuance failed (${response.status})`);
  const record = await response.json();
  if (typeof record.token !== 'string' || !record.token.trim() ||
      !Number.isFinite(Date.parse(record.expires_at)) || Date.parse(record.expires_at) <= now + 600000) {
    throw new Error('Invalid token response');
  }
  await mkdir(dirname(config.tokenFile), { recursive: true, mode: 0o700 });
  const temporary = `${config.tokenFile}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ token: record.token, expires_at: record.expires_at, repository: config.repository, permissions: record.permissions || null }), { mode: 0o600 });
    await rename(temporary, config.tokenFile);
  } finally {
    await rm(temporary, { force: true });
  }
  return record.expires_at;
}

async function main() {
  const tokenFile = process.env.GITHUB_TOKEN_FILE || '/run/momoflow-auth/token.json';
  if (process.argv.includes('--health')) {
    await readToken(tokenFile, 60000);
    return;
  }
  if (process.argv.includes('--print-token')) {
    process.stdout.write((await readToken(tokenFile)).token);
    return;
  }
  const config = {
    appId: process.env.GITHUB_APP_ID,
    installationId: process.env.GITHUB_INSTALLATION_ID,
    repository: process.env.GITHUB_REPO,
    privateKeyFile: '/run/secrets/github-app.pem',
    tokenFile,
  };
  if (!/^\d+$/.test(config.appId || '') || !/^\d+$/.test(config.installationId || '') ||
      !/^[^\s/]+\/[^\s/]+$/.test(config.repository || '')) {
    throw new Error('Invalid GitHub App configuration');
  }
  let stopping = false;
  let timer;
  let wake;
  const stop = () => { stopping = true; clearTimeout(timer); wake?.(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  let nextRefresh = 0;
  while (!stopping) {
    if (Date.now() >= nextRefresh) {
      try {
        const expiresAt = await refreshToken(config);
        nextRefresh = Date.parse(expiresAt) - 600000;
        console.log(`GitHub App token refreshed; expires_at=${expiresAt}`);
      } catch {
        console.error('GitHub App token refresh failed; retrying in 30 seconds.');
        nextRefresh = Date.now() + 30000;
        try { await readToken(tokenFile); } catch { await rm(tokenFile, { force: true }); }
      }
    }
    if (!stopping) await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, 1000); });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('GitHub App authentication unavailable.'); process.exitCode = 1; });
}
