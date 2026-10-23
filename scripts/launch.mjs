// Trusted operator entrypoint. Symphony still selects/claims/workers; this CLI only prepares one explicit scope.
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, json, digest, atomic, keyFor, github, list, verifyInstall, withControllerLock, runConnected } from './post-pr.mjs';
import { validateComposeImage } from './post-pr-docker.mjs';
import { foreignOwners } from './reconcile-external.mjs';
const assert = (v, reason) => { if (!v) throw Error(reason); };
const same = (a,b) => a && b && Object.keys(a).sort().join() === Object.keys(b).sort().join() && Object.keys(a).every(k => a[k] === b[k]);
const optional = async path => { try { return await json(path); } catch(e) { if(e.code === 'ENOENT') return null; throw e; } };
export function launchConfig(c) {
  config(c);
  validateComposeImage(c);
  assert(c.authority.launch === true && !c.hold && c.authority.validate && c.authority.close && c.authority.merge, 'Explicit launch/validate/merge/close authority and no hold required');
  assert(Number.isInteger(c.iterationLimit) && c.iterationLimit >= 1 && c.iterationLimit <= 3, 'Explicit iterationLimit=1|2|3 required');
  assert(/^[a-f0-9]{64}$/.test(c.launchId), 'Explicit stable launchId required');
  assert(typeof c.launchRoot === 'string' && resolve(c.launchRoot) === c.launchRoot, 'Absolute trusted launchRoot required');
  c.launch = {v:1,id:c.launchId,repo:c.repo,issue:c.issue,base:c.base,limit:c.iterationLimit};
  return c;
}
export function runtime(c, s, allowOwn = false, expectedManifest = null) {
  const cap = s.momoflow_launch;
  assert(cap?.contract === 1 && cap.source === c.runnerSource && cap.repo === c.repo && cap.concurrency === 1 && cap.role_flow === true && cap.launch_root === '/run/momoflow-launch' && cap.inbox_root === '/run/momoflow-resume' && cap.launch_read_only === true && cap.inbox_read_only === true, 'Installed engine launch capability/config/source mismatch');
  assert(expectedManifest ? cap.manifest?.status === 'present' && same(cap.manifest.value, expectedManifest) : cap.manifest?.status === 'absent', 'Engine-visible launch manifest missing/invalid/mismatch; inspect launch bind source');
  assert(Array.isArray(s.running) && Array.isArray(s.retrying), 'Unknown engine state');
  assert([...s.running,...s.retrying].every(x => allowOwn && x.issue_id === c.issue), 'Another running/retrying execution or fresh launch already running');
}
export async function inspect(c, io, existing = null) {
  launchConfig(c);
  await io.authorize();
  runtime(c, await io.engine(), !!existing?.dispatched, existing ? c.launch : null);
  const root = `/repos/${c.repo}`;
  const repo = await io.api('GET', root);
  assert(repo.full_name === c.repo && repo.archived === false && repo.disabled === false, 'Repository unavailable/scope mismatch');
  const issue = await io.api('GET', `${root}/issues/${c.issue}`);
  assert(issue.state === 'open' && !issue.pull_request && String(issue.number) === c.issue, 'Target is closed/not the explicit issue');
  const holds = existing?.dispatched ? ['momoflow:needs-decision'] : ['momoflow:needs-decision','momoflow:needs-review'];
  assert(!issue.labels?.some(x => holds.includes(x.name)), 'Issue has unresolved hold/action');
  const branch = await io.api('GET', `${root}/branches/${encodeURIComponent(c.base)}`);
  assert(branch.name === c.base, 'Base scope mismatch');
  const eligible = await list(io.api, `${root}/issues?state=open&labels=momoflow%3Aready`);
  assert(eligible.every(x => String(x.number) === c.issue && !x.pull_request), 'Other eligible ready issue');
  if (!existing) assert(!eligible.length, 'Target already ready without launch intent; operator handoff required');
  const pads=(await list(io.api,`${root}/issues/${c.issue}/comments`)).filter(x=>x.body?.includes('<!-- momoflow:workpad -->'));
  assert(pads.length<=1,'Multiple workpads');
  if(!existing && pads.length) {
    const row=pads[0].body.split('\n').find(x=>x.includes('누적 반복'));
    const count=row?.match(/누적 반복[^\n]*?([0-9]+)\s*\/\s*([0-9]+)/);
    assert(count && count[1]==='0' && ['1','2','3'].includes(count[2]),'Existing workpad use/unknown count requires operator handoff');
  }
  const ledger = await io.ledger();
  assert(ledger || !await io.enrollment?.(), 'Enrolled ledger missing; operator recovery required');
  if (ledger) {
    assert(existing?.dispatched && same(ledger.launch, c.launch), 'Existing/legacy ledger cannot be adopted');
    assert(!['done','blocked'].includes(ledger.stage) && !(ledger.in_flight && !(await io.engine()).running.some(x=>x.issue_id===c.issue)), 'Terminal/interrupted ledger requires recovery');
  } else assert(!existing?.observed, 'Previously observed runner ledger disappeared');
  const manifest = await io.manifest();
  assert(!manifest || (existing && same(manifest, c.launch)), 'Existing launch manifest/scope requires recovery');
  if (existing) {
    assert(existing.contract === digest(c.launch) && existing.settings === io.settings && !existing.blocker && !existing.done, 'Launch journal/settings changed/terminal; operator recovery required');
    assert(same(manifest,c.launch) && existing.dispatched, 'Partial launch requires operator recovery; no automatic redispatch');
  }
  await io.controllers(existing);
  return {ledger, issue};
}
async function note(c, io, text) {
  const path = `/repos/${c.repo}/issues/${c.issue}/comments`;
  const pads = (await list(io.api,path)).filter(x=>x.body?.includes('<!-- momoflow:workpad -->'));
  assert(pads.length <= 1, 'Multiple workpads');
  const start='<!-- momoflow:launch:start -->', end='<!-- momoflow:launch:end -->';
  const blocked=text.startsWith('개입 필요:');
  const section=`${start}\n${text}\n\n**사람에게 필요한 행동:** ${blocked?'운영자가 같은 scope의 journal/manifest/ledger와 프로세스를 확인해 복구 판단':'없음'}\n**개입 라벨:** ${blocked?'momoflow:needs-decision':'없음'}\n${end}`;
  if (!pads.length) {
    await io.api('POST',path,{body:`<!-- momoflow:workpad -->\n## 현재 상태\n\n${section}\n\n| 항목 | 값 |\n| --- | --- |\n| 이슈 · PR | #${c.issue} · 미게시 |\n| 작업 · 검증 커밋 | 미검증 |\n| 누적 반복 | 0 / ${c.iterationLimit}; runner ledger만 사용량 소유 |\n| 다음 행동 | Symphony claim 후 순차 역할 실행 |\n| 대기·재개 조건 | runner ledger 대기 |\n| 최근 갱신 | ${new Date().toISOString()} |\n| 마지막 결정 | 운영자 launch ${c.launchId} |\n\n## 완료 조건 추적\n\n이슈 본문 완료 조건을 구현 단계에서 갱신한다.\n\n## 반복 기록\n\n준비 단계: 모델 실행 없음.\n\n## 개입 요청\n\n없음.`});
  } else {
    const old=pads[0].body, i=old.indexOf(start), j=old.indexOf(end);
    assert((i<0&&j<0)||(i>=0&&j>i),'Malformed launch workpad section');
    const body=i<0?old.replace('<!-- momoflow:workpad -->',`<!-- momoflow:workpad -->\n\n${section}`):old.slice(0,i)+section+old.slice(j+end.length);
    if(body!==old) await io.api('PATCH',`/repos/${c.repo}/issues/comments/${pads[0].id}`,{body});
  }
}
// Injected ports exercise the actual state machine without external dispatch/model/Docker.
export async function launch(c, io, {preflight=false}={}) {
  let intent=await io.load();
  if(preflight) {
    await inspect(c,io,intent);
    return {prepared:true,scope:`${c.repo}#${c.issue}`,limit:c.iterationLimit};
  }
  assert(!intent?.done && !intent?.blocker, 'Launch journal terminal/blocked; operator recovery required');
  try {
    await inspect(c,io,intent);
    if(!intent) {
      intent={contract:digest(c.launch),settings:io.settings,started:Date.now(),dispatched:false};
      await io.save(intent); // Durable intent BEFORE manifest/remote effects.
      await io.install(c.launch); // Immutable, exclusive creation; never overwrite another launch.
      await io.authorize();
      runtime(c,await io.engine(),false,c.launch);
      await note(c,io,`준비 완료: 승인된 ${c.repo}#${c.issue}, 한도 ${c.iterationLimit}. 다음 행동: ready 부여 후 Symphony ledger 대기. 배포 별도.`);
      await io.authorize();
      const fresh = await inspect(c,io,{...intent,dispatched:true});
      assert(!fresh.ledger && !fresh.issue.labels?.some(x=>x.name==='momoflow:ready'), 'Execution/ready appeared before dispatch');
      // Unknown response is deliberately a recovery blocker, never a fresh dispatch.
      await io.api('POST',`/repos/${c.repo}/issues/${c.issue}/labels`,{labels:['momoflow:ready']});
      const labels=await list(io.api,`/repos/${c.repo}/issues/${c.issue}/labels`);
      assert(labels.some(x=>x.name==='momoflow:ready'),'Ready grant not confirmed');
      intent.dispatched=true;
      await io.save(intent);
    }
    for(;;) {
      const {ledger}=await inspect(c,io,intent);
      if(ledger) {
        if(!intent.observed) {intent.observed=true; await io.save(intent);}
        const result=await io.reconcile();
        if(result.done) {intent.done=true;await io.save(intent);return result;}
      } else {
        assert(Date.now()-intent.started < 300000,'Runner ledger not created within preparation deadline; inspect polling/auth/mounts');
        await note(c,io,'대기: ready 부여 확인; runner ledger 생성 전 정상 준비 대기. 다음 행동: Symphony polling/claim 관찰; 5분 기한 초과 시 운영자 확인.');
      }
      await io.sleep(); // Global ownership is held while waiting.
    }
  } catch(e) {
    if(intent && intent.contract === digest(c.launch)) {
      intent.blocker=e.message;await io.save(intent);
      const path=`/repos/${c.repo}/issues/${c.issue}/labels`;
      const labels=await list(io.api,path);
      if(labels.some(x=>x.name==='momoflow:ready')) await io.api('DELETE',`${path}/momoflow%3Aready`);
      assert(!(await list(io.api,path)).some(x=>x.name==='momoflow:ready'),'Ready removal failed');
      await io.api('POST',path,{labels:['momoflow:needs-decision']});
      await note(c,io,`개입 필요: ${e.message}. 다음 행동: 같은 launch journal/manifest/ledger를 보존하고 운영자가 복구 근거 확인; 자동 재시작/ledger 편집 금지.`);
    }
    throw e;
  }
}
export function authMetadata(c, token) {
  assert(token.repository===c.repo && Date.parse(token.expires_at)>Date.now()+60000, 'Authentication scope/expiry metadata missing');
  for(const k of ['contents','issues','pull_requests']) assert(token.permissions?.[k]==='write','GitHub App token write permission missing: '+k);
  assert(['read','write'].includes(token.permissions?.checks),'GitHub App check read permission missing');
}
export async function ports(c) {
  await verifyInstall(c);
  assert(!c.trustedRoot.startsWith('/data/workspaces/'), 'Trusted checkout must be outside candidate workspace');
  for(const [path,mode] of [[c.configFile,constants.R_OK],[c.launchRoot,constants.R_OK|constants.W_OK],[c.stateRoot,constants.R_OK|constants.W_OK],[c.inboxRoot,constants.R_OK|constants.W_OK],[c.ledgerRoot,constants.R_OK],[c.tokenFile,constants.R_OK]]) {
    assert(await realpath(path)===path,'Operational symlink path forbidden');
    const stat=await lstat(path);
    assert([c.tokenFile,c.configFile].includes(path)?stat.isFile():stat.isDirectory(),'Invalid operational path');
    assert(!(stat.mode&0o022),'Operational path writable by untrusted group/others');
    await access(path,mode);
    assert(!path.startsWith(c.trustedRoot+'/')&&!path.startsWith('/data/workspaces/'),'Operational paths must be outside candidate/checkouts');
  }
  c.runnerSource=digest(await readFile(join(c.trustedRoot,'engine/role_runner.ex')));
  const settings=digest(c.configContents), dir=join(c.stateRoot,keyFor(c));
  const authorize=async()=>{
    assert(digest(await json(c.configFile))===settings,'Operator configuration changed');
    const token=await json(c.tokenFile);
    authMetadata(c,token);
  };
  return {
    settings,authorize,api:github(c),
    engine:async()=>{const r=await fetch(`${c.engineURL}/api/v1/state`,{signal:AbortSignal.timeout(5000)});assert(r.ok,'Engine unavailable');return r.json();},
    ledger:()=>optional(join(c.ledgerRoot,`${keyFor(c)}.json`)),
    enrollment:()=>optional(join(c.ledgerRoot,`${keyFor(c)}.json.enrolled`)),
    manifest:()=>optional(join(c.launchRoot,'active.json')),
    load:()=>optional(join(dir,'launch.json')),
    save:x=>atomic(join(dir,'launch.json'),x),
    install:async m=>{
      // Exclusive creation is fail closed even for partial writes/crashes.
      const {open}=await import('node:fs/promises');
      const f=await open(join(c.launchRoot,'active.json'),'wx',0o644);
      try{await f.writeFile(JSON.stringify(m));await f.sync();}finally{await f.close();}
      const d=await open(c.launchRoot,'r');try{await d.sync();}finally{await d.close();}
    },
    controllers:existing=>foreignOwners(c,{own:true,existing}),
    reconcile:()=>runConnected(c),sleep:()=>new Promise(r=>setTimeout(r,30000))
  };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const file=resolve(process.argv[2]), contents=await json(file);
  const c=launchConfig({...contents,configFile:file,configContents:contents});
  const io=await ports(c);
  const preflight=process.argv.includes('--preflight');
  try {
    if(preflight) {
      assert(!await optional(join(c.stateRoot,'controller.lock')),'Controller ownership already held');
      console.log(JSON.stringify(await launch(c,io,{preflight:true})));
    } else console.log(JSON.stringify(await withControllerLock(c,()=>launch(c,io))));
  } catch(e) {console.error(e.message);process.exitCode=1;}
}
