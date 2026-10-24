// Installed and pinned by an operator OUTSIDE candidate workspaces. No shell evaluation.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, open, rm, realpath, lstat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostname } from 'node:os';
import { validateDocker, command, validationKind, checkOutcome } from './post-pr-docker.mjs';

export const digest = x => createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x) ? x : JSON.stringify(x)).digest('hex');
const assert = (v, reason) => { if (!v) throw new Error(reason); };
const sha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
export const keyFor = c => digest(`${c.repo}:${c.issue}`);
export async function atomic(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: mode === 0o644 ? 0o755 : 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const f = await open(tmp, 'w', mode);
  try { await f.writeFile(JSON.stringify(value, null, 2)); await f.sync(); } finally { await f.close(); }
  await rename(tmp, path);
  const d = await open(dirname(path), 'r');
  try { await d.sync(); } finally { await d.close(); }
}
export async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
export function config(c) {
  assert(/^[\w.-]+\/[\w.-]+$/.test(c.repo) && /^[1-9][0-9]*$/.test(c.issue), 'Invalid delegated scope');
  assert(typeof c.base === 'string' && /^[\w./-]+$/.test(c.base), 'Invalid base');
  for (const k of ['stateRoot', 'inboxRoot', 'ledgerRoot', 'tokenFile', 'trustedRoot']) {
    assert(typeof c[k] === 'string' && c[k] === resolve(c[k]), `Absolute trusted path required: ${k}`);
  }
  const bridge=c.finish?.previous && ['finish','deploy','retire','close'].every(k=>c.authority?.[k]===true) && typeof c.operatorContainer==='string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(c.operatorContainer) && /^http:\/\/host\.docker\.internal:[0-9]+$/.test(c.engineURL);
  assert(sha(c.controllerVersion) && typeof c.engineURL === 'string' && (/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+$/.test(c.engineURL) || bridge), 'Pinned controller/local engine required');
  assert(Array.isArray(c.requiredChecks) && c.requiredChecks.every(x => typeof x.name === 'string' && Number.isSafeInteger(x.appId) && x.appId > 0), 'Explicit trusted external check producers required');
  assert(new Set(c.requiredChecks.map(x => x.name)).size === c.requiredChecks.length, 'Duplicate check names');
  assert(Array.isArray(c.requiredReviewers), 'Explicit required reviewers required');
  assert(c.authority && ['validate', 'resume', 'merge', 'close'].every(x => typeof c.authority[x] === 'boolean'), 'Explicit authority required');
  assert(typeof c.hold === 'boolean', 'Explicit hold required');
  return c;
}
export function github(c, fetcher = fetch) {
  return async (method, path, body) => {
    const token = await json(c.tokenFile);
    assert(typeof token.token === 'string' && Date.parse(token.expires_at) > Date.now() + 60000, 'GitHub App authentication expired');
    const r = await fetcher(`https://api.github.com${path}`, { method, headers: {
      Authorization: `Bearer ${token.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw Object.assign(new Error(`GitHub ${method} ${path}: ${r.status}`), { status: r.status }); // Never log credentials or response bodies.
    return r.status === 204 ? null : r.json();
  };
}
export async function list(api, path, field) {
  const value = await api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100`);
  const rows = field ? value[field] : value;
  assert(Array.isArray(rows) && rows.length < 100 && (!field || value.total_count === rows.length), `Incomplete/paginated result: ${path}`);
  return rows;
}
export function budget(c, ledger) {
  const m = ledger.launch;
  if (c.launch || m) {
    assert(c.launch && m && Object.keys(m).sort().join() === Object.keys(c.launch).sort().join() && Object.keys(m).every(k => m[k] === c.launch[k]), 'Launch scope/limit changed or missing');
    assert(m.v === 1 && m.repo === c.repo && m.issue === c.issue && m.base === c.base && /^[a-f0-9]{64}$/.test(m.id), 'Invalid persisted launch');
    assert(Number.isInteger(m.limit) && m.limit >= 1 && m.limit <= 3, 'Invalid launch limit');
  }
  const limit = m ? m.limit : 3;
  assert(Number.isInteger(ledger.iterations) && ledger.iterations >= 0 && ledger.iterations <= limit, 'Invalid role budget');
  return limit;
}

export function receipt(c, ledger) {
  const p = ledger.publication;
  budget(c, ledger);
  assert(ledger.issue === c.issue && ledger.stage === 'await_validation' && ledger.in_flight === false, 'Runner is not released for validation');
  assert(Number.isInteger(ledger.iterations) && ledger.iterations >= 1 && ledger.iterations <= 3, 'Invalid role budget');
  assert(p && p.repo === c.repo && p.issue === c.issue && p.base === c.base && Number.isSafeInteger(p.pr) && p.pr > 0 && sha(p.head) && sha(p.tree) && sha(p.base_head), 'Invalid publication scope');
  assert(p.generation === ledger.events.length && p.snapshot && sha(p.snapshot.head) && /^[a-f0-9]{64}$/.test(p.snapshot.diff_sha256), 'Stale publication generation');
  const [review, publish] = ledger.events.slice(-2);
  assert(review?.role === 'review' && publish?.role === 'publish' && review.result?.status === 'complete' && publish.result?.status === 'complete', 'Missing separate review/publication');
  assert(review.session?.thread_id === p.review_thread && review.session.thread_id !== publish.session?.thread_id && JSON.stringify(review.after) === JSON.stringify(p.snapshot) && JSON.stringify(publish.after) === JSON.stringify(p.snapshot), 'Review identity/tree mismatch');
  for (const e of [review, publish]) {
    const s = e.session?.effective_settings;
    assert(s?.model === (e.role === 'review' ? 'gpt-6-astra' : 'gpt-6.1-sol') && s.reasoningEffort === (e.role === 'review' ? 'high' : 'medium') && s.serviceTier === 'default' && s.sandbox?.type === 'workspaceWrite' && s.sandbox.networkAccess === false, 'Unverified role settings');
    assert(['sandbox_approval','rules','mcp_elicitations','request_permissions','skill_approval'].every(k => s.approvalPolicy?.granular?.[k] === false), 'Unverified approval settings');
  }
  return p;
}
export function validation(c, p, result) {
  assert(result?.origin === c.controllerVersion && result.request === digest(p) && result.head === p.head && result.tree === p.tree, 'Untrusted/stale validation');
  assert(/^sha256:[a-f0-9]{64}$/.test(result.image || ''), 'Missing image identity');
  assert(Array.isArray(result.checks) && result.checks.length > 0 && new Set(result.checks.map(x => x.name)).size === result.checks.length, 'Empty/duplicate checks');
  for (const name of ['compose', 'build', 'contracts', 'node', 'sandbox', 'readiness']) {
    const row = result.checks.find(x => x.name === name);
    assert(row && Number.isInteger(row.exit) && /^[a-f0-9]{64}$/.test(row.log), `Missing check/log: ${name}`);
  }
  const contractTests = result.checks.find(x => x.name === 'contracts')?.tests;
  const nodeTests = result.checks.find(x => x.name === 'node')?.tests;
  assert(Number.isInteger(contractTests) && contractTests >= 64 && Number.isInteger(nodeTests) && nodeTests > 0 && result.tests === contractTests + nodeTests, 'Zero/incomplete test evidence');
  assert(result.kind === 'passed' || result.kind === 'code_failure', 'Host/auth/tool failure requires operator recovery');
  assert(validationKind(result.checks) === result.kind, 'Ambiguous/contradictory test evidence');
  if (result.kind === 'code_failure') for (const row of result.checks.filter(x => checkOutcome(x) === 'code_failure'))
    assert(typeof row.diagnostic === 'string' && row.diagnostic.trim() && row.diagnostic.length <= 6100, 'Missing bounded failure diagnostics');
  return result;
}
async function current(c, p, api) {
  const root = `/repos/${c.repo}`;
  const pr = await api('GET', `${root}/pulls/${p.pr}`);
  assert(pr.head?.sha === p.head && pr.head.repo?.full_name === c.repo && pr.base?.ref === c.base && pr.base.repo?.full_name === c.repo, 'PR head/base/scope changed');
  if (!pr.merged) assert(pr.base.sha === p.base_head, 'PR base commit changed; rebase/review required');
  const commit = await api('GET', `${root}/git/commits/${p.head}`);
  assert(commit.tree?.sha === p.tree, 'Remote tree changed');
  return pr;
}
async function gates(c, p, api) {
  const root = `/repos/${c.repo}`;
  const pr = await current(c, p, api);
  assert(pr.state === 'open' && !pr.draft, 'PR is closed/draft');
  assert(pr.mergeable !== false && pr.mergeable_state !== 'dirty', 'PR conflicts require correction');
  const branch = await api('GET', `${root}/branches/${encodeURIComponent(c.base)}`);
  const rules = await list(api, `${root}/rules/branches/${encodeURIComponent(c.base)}`);
  // MVP supports only positively established unprotected/no-rules repositories. Never infer from 403.
  assert(branch.protected === false && rules.length === 0, 'Protected/unsupported rules require operator handling');
  const checks = await list(api, `${root}/commits/${p.head}/check-runs`, 'check_runs');
  for (const req of c.requiredChecks) {
    const matching = checks.filter(x => x.name === req.name);
    if (matching.length === 0) return { waiting: `CI ${req.name} not yet reported` };
    assert(matching.length === 1 && matching[0].head_sha === p.head && matching[0].app?.id === req.appId, `Missing/ambiguous check producer: ${req.name}`);
    if (matching[0].status !== 'completed') return { waiting: `CI ${req.name}` };
    assert(matching[0].conclusion === 'success', `External check failed: ${req.name}`);
  }
  const statuses = await list(api, `${root}/commits/${p.head}/statuses`);
  const latest = new Map();
  for (const s of statuses) if (!latest.has(s.context)) latest.set(s.context, s);
  assert([...latest.values()].every(s => s.state !== 'failure' && s.state !== 'error'), 'Failing commit status');
  if ([...latest.values()].some(s => s.state === 'pending')) return { waiting: 'Commit status' };
  const reviews = await list(api, `${root}/pulls/${p.pr}/reviews`);
  const byUser = new Map();
  for (const r of reviews) if (r.state !== 'COMMENTED' && r.state !== 'PENDING') byUser.set(r.user?.login, r);
  assert(![...byUser.values()].some(r => r.state === 'CHANGES_REQUESTED'), 'Unresolved requested changes');
  for (const user of c.requiredReviewers) {
    const r = byUser.get(user);
    if (!r || r.state !== 'APPROVED' || r.commit_id !== p.head || r.user?.type !== 'User' || r.user.login === pr.user?.login) return { waiting: `Human review ${user}` };
    const permission = await api('GET', `${root}/collaborators/${encodeURIComponent(user)}/permission`);
    assert(['admin', 'maintain', 'write'].includes(permission.permission), 'Reviewer authority missing');
  }
  const [owner, name] = c.repo.split('/');
  const threads = await api('POST', '/graphql', { query: 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved} pageInfo{hasNextPage}}}}}', variables: { owner, name, number: p.pr } });
  const t = threads.data?.repository?.pullRequest?.reviewThreads;
  assert(!threads.errors && t && t.pageInfo?.hasNextPage === false && t.nodes.every(x => x.isResolved === true), 'Unresolved/incomplete review threads');
  if (pr.mergeable !== true || pr.mergeable_state !== 'clean') return { waiting: 'GitHub mergeability computation/requirements' };
  const issue = await api('GET', `${root}/issues/${c.issue}`);
  assert(issue.state === 'open', 'Source issue closed before merge; operator must assess completion');
  return { pr, issue, branch, rules, checks, statuses, reviews, threads: t, checkedAt: new Date().toISOString() };
}
async function report(c, p, api, text) {
  const root = `/repos/${c.repo}`;
  const comments = await list(api, `${root}/issues/${c.issue}/comments`);
  const pads = comments.filter(x => x.body?.includes('<!-- momoflow:workpad -->'));
  assert(pads.length === 1, 'Single workpad required');
  const start = '<!-- momoflow:post-pr:start -->', end = '<!-- momoflow:post-pr:end -->';
  const body = `${start}\n${text}\n${end}`;
  const old = pads[0].body;
  const i = old.indexOf(start), j = old.indexOf(end);
  assert((i < 0 && j < 0) || (i >= 0 && j > i), 'Malformed controller workpad section');
  const next = i < 0 ? old.replace('<!-- momoflow:workpad -->', `<!-- momoflow:workpad -->\n\n${body}`) : old.slice(0, i) + body + old.slice(j + end.length);
  if (next !== old) await api('PATCH', `${root}/issues/comments/${pads[0].id}`, { body: next });
  const prComments = await list(api, `${root}/issues/${p.pr}/comments`);
  const marker = `<!-- momoflow:post-pr:${digest(text)} -->`;
  if (!prComments.some(x => x.body?.includes(marker))) await api('POST', `${root}/issues/${p.pr}/comments`, { body: `${marker}\n${text}` });
}
async function actionLabels(c, p, api, journal, save, wanted) {
  const owned = journal.ownedLabels || [];
  for (const number of [c.issue, p.pr]) {
    const path = `/repos/${c.repo}/issues/${number}/labels`;
    const labels = await list(api, path);
    for (const name of ['momoflow:needs-review', 'momoflow:needs-decision']) {
      const key = `${number}:${name}`;
      if (name === wanted && !labels.some(x => x.name === name)) {
        if (!owned.includes(key)) { owned.push(key); await save({ ownedLabels: [...owned] }); }
        await api('POST', path, { labels: [name] });
      } else if (name !== wanted && owned.includes(key)) {
        if (labels.some(x => x.name === name)) await api('DELETE', `${path}/${encodeURIComponent(name)}`);
        owned.splice(owned.indexOf(key), 1);
        await save({ ownedLabels: [...owned] });
      }
    }
  }
}

async function removeReady(c, api) {
  const root = `/repos/${c.repo}/issues/${c.issue}`;
  const labels = await list(api, `${root}/labels`);
  if (labels.some(x => x.name === 'momoflow:ready')) await api('DELETE', `${root}/labels/momoflow%3Aready`);
  assert(!(await list(api, `${root}/labels`)).some(x => x.name === 'momoflow:ready'), 'Ready removal failed');
}

// Ports are injected only by tests; production CLI always uses the fixed Docker harness and GitHub API.
export async function reconcile(c, io) {
  config(c);
  const api = io.api, root = `/repos/${c.repo}`;
  const engineState = await io.engine();
  assert(Array.isArray(engineState.running) && Array.isArray(engineState.retrying), 'Unknown engine state');
  if (engineState.running.length || engineState.retrying.length) return { waiting: 'Symphony worker/claim release' };
  const ledger = await io.ledger();
  if (ledger.stage !== 'await_validation' && !['blocked', 'done'].includes(ledger.stage)) return { waiting: 'Role flow progress' };
  const p = receipt(c, ledger);
  let journal = await io.load();
  if (!journal || journal.request !== digest(p)) {
    assert(!journal?.mergeIntent || journal.done, 'Prior merge intent requires recovery before new head');
    journal = { request: digest(p), publication: p, ownedLabels: journal?.ownedLabels || [] };
    await io.save(journal);
  }
  const save = async patch => { Object.assign(journal, patch); await io.save(journal); };
  try {
    await io.authorize?.();
    assert(!c.hold, 'Explicit operator hold');
    assert(c.authority.validate, 'Validation authority missing');
    const engine = await io.engine();
    assert(Array.isArray(engine.running) && Array.isArray(engine.retrying), 'Unknown engine state');
    if (engine.running.length || engine.retrying.length) return { waiting: 'Symphony worker/claim release' };
    let pr = await current(c, p, api);
    const issue = await api('GET', `${root}/issues/${c.issue}`);
    if (pr.merged && (journal.mergeAttempt?.state !== 'confirmed' || journal.mergeAttempt.sha !== pr.merge_commit_sha)) {
      await io.preserve({ ledger, publication: p, pr, journal });
      throw new Error('Externally or ambiguously merged: preserve evidence; operator must assess completion');
    }
    if (pr.merged) {
      assert(journal.mergeAttempt.head === p.head && journal.mergeAttempt.base === p.base_head && journal.mergeAttempt.gate?.pr?.base?.sha === p.base_head, 'Merge provenance mismatch');
    }
    if (!pr.merged) assert(!['attempting', 'uncertain', 'confirmed'].includes(journal.mergeAttempt?.state), 'Prior merge attempt requires operator assessment');
    if (!pr.merged) assert(issue.state === 'open' && pr.state === 'open', 'Issue/PR closed without verified completion');
    if (!journal.validation) {
      const result = await io.validate(p);
      validation(c, p, result);
      await save({ validation: result });
    }
    validation(c, p, journal.validation);
    await io.verifyLogs?.(journal.validation);
    if (journal.validation.kind === 'code_failure') {
      assert(!pr.merged && c.authority.resume, 'Correction authority unavailable');
      const limit = budget(c, ledger);
      assert(ledger.iterations < limit, `Shared budget exhausted ${ledger.iterations}/${limit}; no further build`);
      const guardResume = async () => {
        await io.authorize?.();
        assert(!c.hold && c.authority.resume, 'Correction authority revoked/hold');
        const latestLedger = await io.ledger();
        assert(latestLedger.iterations < budget(c, latestLedger), 'Shared budget exhausted before correction');
        assert(digest(receipt(c, latestLedger)) === digest(p), 'Runner generation changed during validation');
        const released = await io.engine();
        assert(Array.isArray(released.running) && Array.isArray(released.retrying) && released.running.length === 0 && released.retrying.length === 0, 'Worker started during host validation');
        const latest = await current(c, p, api);
        assert(!latest.merged && latest.state === 'open' && (await api('GET', `${root}/issues/${c.issue}`)).state === 'open', 'Issue/PR closed before correction');
      };
      const envelope = { id: digest({ publication: p, failure: journal.validation }), repo: c.repo, issue: c.issue,
        publication: p, generation: ledger.events.length, kind: 'code_failure', evidence: JSON.stringify(journal.validation) };
      await report(c, p, api, `코드 검사 실패: ${p.head}; 누적 ${ledger.iterations}/${limit}. 같은 PR 수정 → 별도 Astra 검토 → 재검증 대기. 근거 ${journal.request}.`);
      await save({ resumeIntent: envelope.id });
      await guardResume();
      await io.resume(envelope); // Atomic host-owned inbox. Runner owns consumption/count.
      await guardResume(); // Reporting/inbox IO cannot retain revoked dispatch authority.
      await api('POST', `${root}/issues/${c.issue}/labels`, { labels: ['momoflow:ready'] });
      return { waiting: 'Budget-preserving same-PR correction', request: envelope.id };
    }
    if (!pr.merged) {
      assert(c.authority.merge && c.authority.close, 'Merge/close authority missing');
      const gate = await gates(c, p, api);
      if (gate.waiting) {
        await removeReady(c, api);
        await actionLabels(c, p, api, journal, save, gate.waiting.startsWith('Human review') ? 'momoflow:needs-review' : null);
        await report(c, p, api, `대기: ${gate.waiting}; head ${p.head}. 정상 외부 검사/리뷰 대기는 새 모델 실행을 만들지 않습니다.`);
        return gate;
      }
      await actionLabels(c, p, api, journal, save, null);
      // Preserve all evidence BEFORE merge (GitHub may auto-close linked issues).
      await io.preserve({ ledger, publication: p, validation: journal.validation, pr: gate.pr });
      await io.authorize?.();
      assert(digest(receipt(c, await io.ledger())) === digest(p), 'Runner generation changed during validation');
      const released = await io.engine();
      assert(Array.isArray(released.running) && Array.isArray(released.retrying) && released.running.length === 0 && released.retrying.length === 0, 'Worker started during host validation');
      assert(!c.hold && c.authority.merge && c.authority.close, 'Merge/close authority revoked/hold');
      // Full policy read AFTER preservation; sha alone cannot protect reviews/checks.
      const finalGate = await gates(c, p, api);
      if (finalGate.waiting) {
        await removeReady(c, api);
        await actionLabels(c, p, api, journal, save, finalGate.waiting.startsWith('Human review') ? 'momoflow:needs-review' : null);
        await report(c, p, api, `대기: ${finalGate.waiting}; head ${p.head}. 정상 외부 검사/리뷰 대기는 새 모델 실행을 만들지 않습니다.`);
        return finalGate;
      }
      await io.authorize?.();
      assert(!c.hold && c.authority.merge && c.authority.close, 'Merge/close authority revoked/hold');
      const attempt = { state: 'attempting', head: p.head, base: p.base_head, gate: finalGate };
      await save({ mergeIntent: true, mergeAttempt: attempt }); // Durable actual gate evidence.
      let response;
      try {
        response = await api('PUT', `${root}/pulls/${p.pr}/merge`, { sha: p.head, merge_method: 'merge' });
      } catch (e) {
        await save({ mergeAttempt: { ...attempt, state: Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? 'rejected' : 'uncertain' } });
        throw e;
      }
      if (response?.merged === false) await save({ mergeAttempt: { ...attempt, state: 'rejected' } });
      assert(response?.merged === true && sha(response.sha), 'Merge response not confirmed; operator assessment required');
      await save({ mergeAttempt: { ...attempt, state: 'confirmed', sha: response.sha } });
      pr = await current(c, p, api);
    }
    assert(journal.mergeAttempt?.state === 'confirmed' && journal.mergeAttempt.sha === pr.merge_commit_sha, 'Merge response/provenance mismatch');
    const mergeCommit = await api('GET', `${root}/git/commits/${pr.merge_commit_sha}`);
    assert(mergeCommit.parents?.length === 2 && mergeCommit.parents[0].sha === p.base_head && mergeCommit.parents[1].sha === p.head, 'Merge parent/base identity mismatch');
    assert(pr.merged === true && sha(pr.merge_commit_sha), 'Merge not confirmed');
    await save({ merged: pr.merge_commit_sha });
    await io.preserve({ ledger, publication: p, validation: journal.validation, pr, merge: pr.merge_commit_sha });
    const reportedIssue = await api('GET', `${root}/issues/${c.issue}`);
    const issueNote = reportedIssue.state === 'closed' && reportedIssue.state_reason && reportedIssue.state_reason !== 'completed'
      ? ` 원본 이슈 상태 closed (${reportedIssue.state_reason}); 기존 종료 사유를 보존합니다.` : '';
    const text = `${c.finish ? '병합 완료 (운영 마무리 대기)' : '완료'}: PR #${p.pr}, 검증 head ${p.head}, tree ${p.tree}, merge ${pr.merge_commit_sha}. 독립 검토·호스트/필수 검사 근거 ${journal.request} 보존. ${c.finish ? '배포·운영 확인·manifest 정리 전이며 이슈는 열어 둡니다.' : '배포는 별도입니다.'}${issueNote}`;
    await actionLabels(c, p, api, journal, save, null);
    await report(c, p, api, text);
    await removeReady(c, api);
    await io.authorize?.();
    assert(c.authority.close, 'Close authority missing');
    const issueBeforeClose = await api('GET', `${root}/issues/${c.issue}`);
    if (!c.finish && issueBeforeClose.state !== 'closed') await api('PATCH', `${root}/issues/${c.issue}`, { state: 'closed', state_reason: 'completed' });
    const closed = await api('GET', `${root}/issues/${c.issue}`);
    assert(c.finish || closed.state === 'closed', 'Issue close not confirmed');
    await save({ done: true });
    return { done: true, merge: pr.merge_commit_sha };
  } catch (e) {
    await save({ blocker: e.message });
    await removeReady(c, api);
    await actionLabels(c, p, api, journal, save, 'momoflow:needs-decision');
    await report(c, p, api, `개입 필요: ${e.message}. 대상 ${p.head}, 근거 ${journal.request}. 호스트/권한/예산을 확인한 뒤 동일 journal로 재실행; ledger 초기화 금지.`);
    throw e;
  }
}

export async function verifyIndependentOperator(c,docker) {
  assert(c.operatorContainer && process.env.HOSTNAME,'Container operator identity required');
  const self=JSON.parse(await docker(['inspect',c.operatorContainer]))[0];
  assert(self?.Id && self.State?.Running===true && self.Config.Hostname===process.env.HOSTNAME && self.Config.Hostname===hostname() && !self.HostConfig.NetworkMode.startsWith('container:') && !['host','none'].includes(self.HostConfig.NetworkMode) && !['symphony','github-auth'].includes(self.Config.Labels?.['com.docker.compose.service']), 'Operator must have an independent container lifetime/network');
  // The named container must be this process, not another helper with a copied hostname.
  const own=JSON.parse(await docker(['inspect',process.env.HOSTNAME]))[0];
  assert(own?.Id===self.Id,'Operator container is not this process');
  return self;
}
export async function verifyInstall(c) {
  assert(await realpath(join(c.trustedRoot, 'scripts/post-pr.mjs')) === await realpath(new URL(import.meta.url)), 'Controller must run from pinned trusted checkout');
  const head = await command('git', ['-C', c.trustedRoot, 'rev-parse', 'HEAD']);
  const status = await command('git', ['--no-optional-locks', '-C', c.trustedRoot, 'status', '--porcelain', '--untracked-files=all']);
  assert(head.exit === 0 && head.output.toString().trim() === c.controllerVersion && status.exit === 0 && status.output.length === 0, 'Controller checkout version/cleanliness mismatch');
  for (const path of [c.stateRoot, c.inboxRoot, c.ledgerRoot, c.tokenFile])
    assert(!resolve(path).startsWith(c.trustedRoot + '/'), 'Operational data must be outside controller checkout');
  if(c.finish && /^http:\/\/host\.docker\.internal:/.test(c.engineURL)) {
    await lstat('/.dockerenv');
    await verifyIndependentOperator(c,async args=>{const r=await command('docker',args,{dockerConfig:c.dockerConfig,timeout:5000});assert(r.exit===0,'Operator identity inspect failed');return r.output.toString();});
  }
}

// Shared by legacy reconcile/watch and launch: ownership lasts across watch sleeps.
export async function withControllerLock(c, action) {
  await mkdir(c.stateRoot, { recursive: true, mode: 0o700 });
  const path = join(c.stateRoot, 'controller.lock');
  const lock = await open(path, 'wx', 0o600);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, repo: c.repo, issue: c.issue, version: c.controllerVersion }));
    await lock.sync();
    return await action();
  } finally { await lock.close(); await rm(path); }
}
export async function runOnce(c) {
  return withControllerLock(c, () => runConnected(c));
}
export async function runConnected(c) {
  config(c);
  const key = keyFor(c), dir = join(c.stateRoot, key);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Crash leaves a lock intentionally: operator verifies no live controller before removing it.
  const lock = await open(join(dir, 'lock'), 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, version: c.controllerVersion }));
  const api = github(c);
  try {
    await verifyInstall(c);
    return await reconcile(c, {
      authorize: async () => {
        if (c.configFile) assert(JSON.stringify(await json(c.configFile)) === JSON.stringify(c.configContents), 'Operator configuration changed; restart controller');
        if (c.launch) {
          const m = await json(join(c.launchRoot, 'active.json'));
          assert(Object.keys(m).sort().join() === Object.keys(c.launch).sort().join() && Object.keys(m).every(k => m[k] === c.launch[k]), 'Trusted launch manifest changed/missing');
        }
      },
      api, ledger: () => json(join(c.ledgerRoot, `${key}.json`)),
      engine: async () => { const r = await fetch(`${c.engineURL}/api/v1/state`, { signal: AbortSignal.timeout(5000) }); assert(r.ok, 'Engine state unavailable'); return r.json(); },
      load: async () => { try { return await json(join(dir, 'journal.json')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
      save: async x => { await atomic(join(dir, `journal-${x.request}.json`), x); await atomic(join(dir, 'journal.json'), x); },
      validate: p => validateDocker(c, p, dir, api),
      verifyLogs: async result => { for (const check of result.checks) assert(digest(await readFile(join(dir, 'logs', check.log))) === check.log, 'Validation log missing/corrupt'); },
      resume: e => atomic(join(c.inboxRoot, `${key}.json`), e, 0o644),
      preserve: async x => { const path = join(dir, `evidence-${digest(x)}.json`); await atomic(path, x); }
    });
  } finally { await lock.close(); await rm(join(dir, 'lock')); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = resolve(process.argv[2]);
  const contents = await json(file);
  const c = config({ ...contents, configFile: file, configContents: contents });
  await verifyInstall(c);
  if (process.argv.includes('--preflight')) {
    // Read-only, no GitHub mutations, Docker execution, model execution or inbox writes.
    const api = github(c), ledger = await json(join(c.ledgerRoot, `${keyFor(c)}.json`));
    const p = receipt(c, ledger);
    await current(c, p, api);
    console.log(JSON.stringify({ scope: `${c.repo}#${c.issue}`, head: p.head, tree: p.tree, gates: await gates(c, p, api) }));
  } else {
    await withControllerLock(c, async () => { do {
      try {
        const result = await runConnected(c);
        console.log(JSON.stringify(result));
        if (result.done) break;
      } catch (e) { console.error(e.message); process.exitCode = 1; break; }
      if (!process.argv.includes('--watch')) break;
      await new Promise(r => setTimeout(r, 30000));
    } while (true); });
  }
}
