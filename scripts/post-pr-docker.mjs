// Fixed trusted host harness. Candidate scripts execute ONLY inside constrained containers.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, symlink, mkdtemp, rm, readFile, realpath } from 'node:fs/promises';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
const hash = b => createHash('sha256').update(b).digest('hex');
export async function command(file, args, { cwd, timeout = 1800000, dockerConfig } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(file, args, { cwd, env: { PATH: process.env.PATH, HOME: '/nonexistent', DOCKER_CONFIG: dockerConfig || '/nonexistent', DOCKER_HOST: process.env.DOCKER_HOST || 'unix:///var/run/docker.sock' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, overflow = false;
    const collect = b => { size += b.length; if (size <= 8 * 1024 * 1024) chunks.push(b); else { overflow = true; child.kill('SIGKILL'); } };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => { clearTimeout(timer); done({ exit: overflow || signal || code === null ? 125 : code, output: Buffer.concat(chunks) }); });
  });
}
// Only container output is eligible; no host logs/config/environment are attached.
export function diagnostic(output) {
  const clean = output.toString().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED KEY]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, '[REDACTED TOKEN]')
    .replace(/((?:authorization|token|password|secret)\s*[:=]\s*)(?:Bearer\s+)?[^\s]+/gi, '$1[REDACTED]');
  return clean.length <= 6000 ? clean : clean.slice(0, 3000) + '\n[excerpt truncated]\n' + clean.slice(-3000);
}
// Exit remains the raw process exit. A numeric exit alone never proves assertions.
export function checkOutcome(row) {
  if (!['contracts', 'node'].includes(row.name)) return row.exit === 0 ? 'passed' : 'host_failure';
  if (!Number.isSafeInteger(row.tests) || row.tests <= 0 ||
      !Number.isSafeInteger(row.failures) || row.failures < 0 || row.failures > row.tests) return 'host_failure';
  if (row.exit === 0 && row.failures === 0) return 'passed';
  if ([1, 2].includes(row.exit) && row.failures > 0) return 'code_failure';
  return 'host_failure'; // Contradictory summary, tool exit, signal, or incomplete evidence.
}
export function validationKind(checks) {
  const outcomes = checks.map(checkOutcome);
  return outcomes.includes('host_failure') ? 'host_failure' : outcomes.includes('code_failure') ? 'code_failure' : 'passed';
}
export async function materialize(api, repo, tree, dir) {
  const listing = await api('GET', `/repos/${repo}/git/trees/${tree}?recursive=1`);
  if (listing.truncated || !Array.isArray(listing.tree) || listing.sha !== tree) throw new Error('Incomplete candidate tree');
  const links = [];
  for (const entry of listing.tree) {
    if (entry.type === 'tree') continue;
    if (entry.type !== 'blob' || !['100644','100755','120000'].includes(entry.mode) ||
      entry.path.startsWith('/') || entry.path.split('/').some(x => !x || x === '.' || x === '..' || x === '.git') || entry.path.includes('\0')) throw new Error('Unsupported candidate path/mode');
    const blob = await api('GET', `/repos/${repo}/git/blobs/${entry.sha}`);
    if (blob.encoding !== 'base64') throw new Error('Unsupported blob encoding');
    const bytes = Buffer.from(blob.content, 'base64');
    const actual = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
    if (actual !== entry.sha) throw new Error('Blob identity mismatch');
    const dest = join(dir, entry.path);
    await mkdir(resolve(dest, '..'), { recursive: true });
    if (entry.mode === '120000') links.push([dest, bytes.toString()]);
    else await writeFile(dest, bytes, { mode: entry.mode === '100755' ? 0o755 : 0o644, flag: 'wx' });
  }
  // No file write can traverse a candidate symlink; links are created only after regular files.
  for (const [dest, target] of links) {
    const rel = relative(resolve(dir), resolve(dirname(dest), target));
    if (isAbsolute(target) || rel === '..' || rel.startsWith('../') || target.includes('\0')) throw new Error('Escaping candidate symlink');
    await symlink(target, dest);
  }
  // Dockerfile, .dockerignore and context walkers are host readers. Resolve chains too;
  // dangling/cyclic links fail closed rather than allowing builder-dependent host reads.
  for (const [dest] of links) {
    const rel = relative(await realpath(dir), await realpath(dest));
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Escaping candidate symlink chain');
  }
}
export function validateComposeImage(c) {
  if (!/^.+@sha256:[a-f0-9]{64}$/.test(c.composeImage || '')) throw new Error('Pinned trusted Compose image required');
}
export async function validateDocker(c, p, evidenceDir, api) {
  validateComposeImage(c);
  const scratch = await mkdtemp('/tmp/momoflow-validate-');
  const dir = join(scratch, 'candidate');
  await mkdir(dir, { mode: 0o755 });
  const { chmod } = await import('node:fs/promises');
  await chmod(scratch, 0o755);
  const dockerConfig = join(scratch, 'docker-config');
  await mkdir(dockerConfig, { mode: 0o700 });
  const docker = (args, opts = {}) => command('docker', args, { ...opts, dockerConfig });
  const checks = [], logs = join(evidenceDir, 'logs');
  await mkdir(logs, { recursive: true });
  const name = `momoflow-check-${process.pid}-${Date.now()}`;
  const run = async (name, args) => {
    const result = await docker(args);
    const log = hash(result.output);
    await writeFile(join(logs, log), result.output, { flag: 'w', mode: 0o600 });
    checks.push({ name, exit: result.exit, log, ...(result.exit !== 0 && ['contracts', 'node'].includes(name) ? { diagnostic: diagnostic(result.output) } : {}) });
    return result;
  };
  // Security profile and probes come from the installed controller version, not candidate code.
  const profile = join(c.trustedRoot, 'security/codex-seccomp.json');
  const trustedScripts = join(c.trustedRoot, 'scripts');
  const options = ['--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--security-opt', `seccomp=${profile}`, '--pids-limit', '512', '--memory', '2g', '--cpus', '2'];
  let image, tests = 0;
  try {
    await materialize(api, c.repo, p.tree, dir);
    const compose = await run('compose', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--mount', `type=bind,src=${dir},dst=/candidate,readonly`, '--workdir', '/candidate', '--entrypoint', 'docker', c.composeImage, 'compose', '-f', '/candidate/compose.yaml', 'config', '--quiet']);
    if (compose.exit !== 0) throw new Error('Compose validation failed; inspect host artifact');
    const iid = join(scratch, 'image-id');
    const build = await run('build', ['build', '--iidfile', iid, '--file', join(dir, 'Dockerfile'), dir]);
    if (build.exit !== 0) throw new Error('Build failure needs host/code classification; no automatic correction');
    image = (await readFile(iid, 'utf8')).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Missing Docker image digest');
    // Override all image entrypoints/commands and users; candidate image metadata cannot add privilege.
    const startup = await docker(['run', '--detach', '--name', name, ...options, '--user', '1000:1000',
      '--mount', `type=bind,src=${dir},dst=/candidate,readonly`,
      '--mount', `type=bind,src=${trustedScripts},dst=/trusted,readonly`,
      '--mount', `type=bind,src=${c.trustedRoot}/WORKFLOW.md,dst=/config/WORKFLOW.md,readonly`,
      '--env', 'GITHUB_REPO=smoke/fixture', '--env', 'GITHUB_TOKEN=smoke-not-a-credential',
      '--workdir', '/opt/symphony/elixir', '--entrypoint', '/opt/symphony/elixir/bin/symphony', image,
      '--i-understand-that-this-will-be-running-without-the-usual-guardrails', '--port', '4000', '--logs-root', '/tmp/log', '/config/WORKFLOW.md']);
    if (startup.exit !== 0) throw new Error('Isolated container startup failed');
    await run('readiness', ['exec', name, 'node', '/trusted/smoke-readiness.mjs']);
    await run('sandbox', ['exec', name, 'node', '/trusted/smoke-sandbox.mjs']);
    const contracts = await run('contracts', ['exec', name, 'sh', '/candidate/scripts/test-role-flow.sh']);
    // ExUnit's actual summary distinguishes assertion failures from missing tools/crashes/zero tests.
    const match = contracts.output.toString().match(/\b([1-9][0-9]*) tests, ([0-9]+) failures?\b/);
    if (!match || Number(match[1]) < 64) throw new Error('Missing baseline role contract evidence');
    if (match) {
      tests = Number(match[1]);
      checks.at(-1).tests = tests;
      checks.at(-1).failures = Number(match[2]);
    }
    const node = await run('node', ['exec', name, 'node', '/candidate/scripts/post-pr.test.mjs']);
    const tapTests = node.output.toString().match(/# tests ([1-9][0-9]*)/);
    const tapFailures = node.output.toString().match(/# fail ([0-9]+)/);
    if (!tapTests || !tapFailures) throw new Error('Missing Node test evidence');
    checks.at(-1).tests = Number(tapTests[1]);
    tests += Number(tapTests[1]);
    checks.at(-1).failures = Number(tapFailures[1]);
    const kind = validationKind(checks);
    return { origin: c.controllerVersion, request: hash(JSON.stringify(p)), head: p.head, tree: p.tree, image, tests, kind, checks };
  } finally {
    await docker(['rm', '-f', '-v', name], { timeout: 30000 });
    await rm(scratch, { recursive: true, force: true });
  }
}
