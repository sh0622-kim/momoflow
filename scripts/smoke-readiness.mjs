import { pathToFileURL } from 'node:url';

function describeError(error) {
  const parts = [];
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    parts.push([current.name, current.code, current.message || String(current)].filter(Boolean).join(': '));
  }
  return parts.join('; caused by: ') || String(error);
}

export async function checkReadiness({ fetch = globalThis.fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = console.log, error = console.error } = {}) {
  let lastFailure;
  for (let attempt = 0; attempt < 30; attempt++) {
    let stage = 'state API connection';
    try {
      const response = await fetch('http://127.0.0.1:4000/api/v1/state', { signal: AbortSignal.timeout(2000) });
      stage = 'state API HTTP';
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      stage = 'state API JSON';
      const state = await response.json();
      stage = 'state API fields';
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('expected a JSON object');
      if (state.error) throw new Error(`state.error: ${JSON.stringify(state.error)}`);
      for (const field of ['running', 'retrying']) {
        if (!Array.isArray(state[field])) throw new Error(`${field} must be an array`);
      }
      stage = 'state API work';
      if (state.running.length || state.retrying.length) {
        throw new Error(`unexpected tasks: running=${state.running.length}, retrying=${state.retrying.length}`);
      }
      stage = 'dashboard connection';
      const page = await fetch('http://127.0.0.1:4000/', { signal: AbortSignal.timeout(2000) });
      stage = 'dashboard HTTP';
      if (!page.ok) throw new Error(`HTTP ${page.status} ${page.statusText}`.trim());
      stage = 'dashboard content';
      if (!(await page.text()).includes('Symphony')) throw new Error('missing Symphony content');
      log('PASS: Symphony state API and dashboard; no running tasks; network disabled.');
      return true;
    } catch (cause) {
      lastFailure = `${stage}: ${describeError(cause)}`;
      await sleep(500);
    }
  }
  error(`FAIL: readiness after 30 attempts; last failure: ${lastFailure}`);
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!(await checkReadiness())) process.exitCode = 1;
}
