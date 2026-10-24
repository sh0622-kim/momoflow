// Trusted operator confirmation of an already delegated task, never a human-authentication parser.
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {digest, budget, list, atomic, json, keyFor, withControllerLock} from './post-pr.mjs';
const assert=(v,m)=>{if(!v)throw Error(m);};
const same=(a,b)=>digest(a)===digest(b);
async function loadDecision(c,id) {
  try{return await json(join(c.stateRoot,keyFor(c),`decision-${id}.json`));}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
}
export function decisionReceipt(c,l) {
  const limit=budget(c,l), d=l.decision, e=l.events?.at(-1);
  assert(l.issue===c.issue && l.stage==='await_decision' && l.in_flight===false && !l.active_session,'Decision checkpoint not released');
  assert(d?.repo===c.repo && d.issue===c.issue && d.generation===l.events.length && d.limit===limit && same(d.launch,l.launch ?? null) && same(d.publication,l.publication ?? null),'Decision scope/generation changed');
  assert(/^[a-f0-9]{64}$/.test(d.id) && d.content_hash===digest(d.reason) && typeof d.reason==='string' && d.reason.trim() && d.reason.length<=4000,'Invalid decision content');
  assert(['build','review','publish','await_validation'].includes(d.next) && same(d.snapshot,e.after) && /^[a-f0-9]{40}$/.test(d.snapshot.head) && /^[a-f0-9]{64}$/.test(d.snapshot.diff_sha256),'Decision snapshot/continuation missing');
  const expected=e.role==='plan'?'build':e.role==='build'?'review':e.role==='review'?(e.result.status==='changes_requested'?'build':'publish'):'await_validation';
  assert(d.next===expected && ['complete','changes_requested'].includes(e.result.status) && e.result.decision?.reason===d.reason,'Decision role outcome missing');
  return d;
}
async function released(io) {
  const s=await io.engine();
  assert(Array.isArray(s.running)&&Array.isArray(s.retrying)&&s.running.length===0&&s.retrying.length===0,'Symphony worker/claim release required');
}
async function current(c,io,d,{resume=false}={}) {
  await io.authorize();
  assert(!c.hold && (!resume || c.authority.resume===true),'Existing resume authority unavailable/hold');
  await released(io);
  const l=await io.ledger();
  assert(same(decisionReceipt(c,l),d),'Decision changed');
  const root=`/repos/${c.repo}`, issue=await io.api('GET',`${root}/issues/${c.issue}`);
  assert(issue.state==='open' && !issue.pull_request && String(issue.number)===c.issue,'Decision issue closed/scope changed');
  if(d.publication) {
    const p=d.publication,pr=await io.api('GET',`${root}/pulls/${p.pr}`);
    assert(pr.state==='open' && !pr.merged && pr.head?.sha===p.head && pr.head.repo?.full_name===c.repo && pr.base?.ref===c.base && pr.base.sha===p.base_head && pr.base.repo?.full_name===c.repo,'Decision PR head/scope changed');
    const labels=await list(io.api,`${root}/issues/${p.pr}/labels`);
    assert(!labels.some(x=>['momoflow:needs-decision','momoflow:needs-review'].includes(x.name)),'Other unresolved PR request');
  }
  const labels=await list(io.api,`${root}/issues/${c.issue}/labels`);
  if(resume)assert(!labels.some(x=>x.name==='momoflow:ready'),'Decision unexpectedly dispatchable');
  assert(!labels.some(x=>x.name==='momoflow:needs-review'),'Other unresolved review request');
  const ready=await list(io.api,`${root}/issues?state=open&labels=momoflow%3Aready`);
  assert(ready.every(x=>String(x.number)===c.issue&&!x.pull_request),'Other ready issue');
  return {l,labels};
}
async function note(c,io,d,text) {
  const root=`/repos/${c.repo}/issues`,pads=(await list(io.api,`${root}/${c.issue}/comments`)).filter(x=>x.body?.includes('<!-- momoflow:workpad -->'));
  assert(pads.length===1,'Single workpad required for decision evidence');
  const start='<!-- momoflow:decision:start -->',end='<!-- momoflow:decision:end -->';
  const section=`${start}\n**판단 요청:** ${d.id} · ${d.reason}\n${text}\n대상 ${d.repo}#${d.issue}, PR ${d.publication?.pr??'미게시'}, head ${d.publication?.head??d.snapshot.head}, generation ${d.generation}, 다음 ${d.next}.\n${end}`;
  const body=pads[0].body;
  const from=body.indexOf(start),to=body.indexOf(end);
  assert((from<0)===(to<0) && (from<0||to>from),'Invalid decision workpad section');
  const updated=from<0?`${body}\n\n${section}`:body.slice(0,from)+section+body.slice(to+end.length);
  if(updated!==body) await io.api('PATCH',`${root}/comments/${pads[0].id}`,{body:updated});
}
// A confirmed signal is already owned by the runner. Observations here are read-only:
// claim and durable consumption can occur between any two host reads.
async function dispatched(c,io,d,prior) {
  response(c,d,prior.response);
  assert(prior.response.action==='continue','Dispatch request changed');
  await io.authorize();
  assert(!c.hold && c.authority.resume===true,'Existing resume authority unavailable/hold');
  const observe=async()=>{
    const s=await io.engine();
    assert(Array.isArray(s.running)&&Array.isArray(s.retrying),'Unknown engine state');
    const workers=[...s.running,...s.retrying];
    assert(workers.every(x=>x.issue_id===c.issue),'Other Symphony worker/claim');
    const l=await io.ledger();
    budget(c,l);
    assert(l.issue===c.issue,'Decision issue scope changed');
    const consumed=l.decisions?.filter(x=>x.decision_id===d.id)??[];
    if(consumed.length) {
      const envelope={...prior.response,kind:'decision',id:d.id,repo:c.repo,issue:c.issue};
      assert(consumed.length===1 && isDeepStrictEqual(consumed[0].response,envelope),'Decision consumption changed');
      assert(Array.isArray(l.events) && l.events.length>=d.generation,'Decision generation regressed');
      decisionReceipt(c,{...l,stage:'await_decision',in_flight:false,active_session:null,decision:d,publication:d.publication,events:l.events.slice(0,d.generation)});
      return {claimed:workers.length>0,consumed:true};
    }
    assert(same(decisionReceipt(c,l),d),'Decision changed');
    return {claimed:workers.length>0,consumed:false};
  };
  let observed=await observe();
  const root=`/repos/${c.repo}`,issue=await io.api('GET',`${root}/issues/${c.issue}`);
  assert(issue.state==='open' && !issue.pull_request && String(issue.number)===c.issue,'Decision issue closed/scope changed');
  const labels=await list(io.api,`${root}/issues/${c.issue}/labels`);
  const ready=await list(io.api,`${root}/issues?state=open&labels=momoflow%3Aready`);
  assert(ready.every(x=>String(x.number)===c.issue&&!x.pull_request),'Other ready issue');
  if(!observed.consumed) {
    // Ready may disappear after the first idle/checkpoint observation. Verify a same-request
    // claim/consumption before treating that absence as an operator change.
    if(!labels.some(x=>x.name==='momoflow:ready'))observed=await observe();
    assert(observed.consumed || (!labels.some(x=>['momoflow:needs-decision','momoflow:needs-review'].includes(x.name)) &&
      (observed.claimed || labels.some(x=>x.name==='momoflow:ready'))),'Confirmed dispatch signal changed; inspect evidence, no automatic retry');
    if(!observed.consumed && d.publication) {
      const p=d.publication,pr=await io.api('GET',`${root}/pulls/${p.pr}`);
      const prLabels=await list(io.api,`${root}/issues/${p.pr}/labels`);
      // A completed continuation may already have published a new head or a new decision.
      // Only its matching durable consumption permits deferring to the next reconciliation.
      observed=await observe();
      if(!observed.consumed) {
        assert(pr.state==='open' && !pr.merged && pr.head?.sha===p.head && pr.head.repo?.full_name===c.repo && pr.base?.ref===c.base && pr.base.sha===p.base_head && pr.base.repo?.full_name===c.repo,'Decision PR head/scope changed');
        assert(!prLabels.some(x=>['momoflow:needs-decision','momoflow:needs-review'].includes(x.name)),'Other unresolved PR request');
      }
    }
  }
  return {waiting:'Confirmed decision dispatch; runner consumption pending',decisionDispatch:d};
}
export async function holdDecision(c,io,observed) {
  const d=decisionReceipt(c,observed??await io.ledger());
  const prior=await (io.loadDecision?io.loadDecision(d.id):loadDecision(c,d.id));
  if(prior?.state==='dispatched')return dispatched(c,io,d,prior);
  await current(c,io,d);
  const root=`/repos/${c.repo}/issues/${c.issue}/labels`;
  let labels=await list(io.api,root);
  if(labels.some(x=>x.name==='momoflow:ready'))await io.api('DELETE',`${root}/momoflow%3Aready`);
  labels=await list(io.api,root);
  assert(!labels.some(x=>x.name==='momoflow:ready'),'Decision ready removal failed');
  if(!labels.some(x=>x.name==='momoflow:needs-decision'))await io.api('POST',root,{labels:['momoflow:needs-decision']});
  await note(c,io,d,'대기: 역할 결과·세션·snapshot·사용량 저장 완료. 기존 위임 내 운영자 확인만 지원. 라벨/공유 계정 댓글은 승인 근거가 아님.');
  await io.preserve({actor:'engine',source:'durable-role-checkpoint',action:'await-decision',issue:c.issue,head:d.publication?.head??d.snapshot.head,result:d});
  return {waiting:'Operator decision',decision:d};
}
export function response(c,d,r) {
  assert(d && /^[a-f0-9]{64}$/.test(d.id),'Invalid request ID');
  assert(same(r.request,d) && ['continue','reject'].includes(r.action),'Stale or invalid decision response');
  assert(r.actor==='external-operator' && r.authority==='existing-scope' && r.unresolved?.length===1 && r.unresolved[0]===d.id,'Unsupported authority or other unresolved requests');
  assert(typeof r.source==='string' && new RegExp(`^https://github\\.com/${c.repo.replaceAll('.','\\.')}/issues/${c.issue}(#issuecomment-[0-9]+)?$`).test(r.source),'Original issue authorization source required');
}
export async function applyDecision(c,io,r) {
  const d=r.request;
  response(c,d,r);
  // Durable operator journal, not GitHub actor inference. Duplicate/rejected/uncertain intents never dispatch again.
  const prior=await io.loadDecision(d.id);
  if(prior) {
    assert(same(prior.response,r),'Different/reordered response for consumed request');
    assert(prior.state==='dispatched'||prior.state==='rejected','Uncertain decision dispatch; inspect evidence, no automatic retry');
    return {decision:d.id,state:prior.state,duplicate:true};
  }
  const {l,labels}=await current(c,io,d,{resume:true});
  assert(!labels.some(x=>x.name==='momoflow:ready'),'Decision already dispatchable without intent');
  if(r.action==='continue')assert(d.next!=='build'||l.iterations<budget(c,l),'Shared implementation budget exhausted');
  const record={response:r,actor:r.actor,source:r.source,action:r.action,issue:c.issue,head:d.publication?.head??d.snapshot.head,state:r.action==='reject'?'rejected':'prepared'};
  await io.saveDecision(d.id,record);
  await io.preserve(record);
  await note(c,io,d,`외부 운영자 확인: ${r.action}; source ${r.source}. 사람 인증/예산 확대 아님.`);
  if(r.action==='reject')return {decision:d.id,state:'rejected'};
  await current(c,io,d,{resume:true});
  const envelope={...r,kind:'decision',id:d.id,repo:c.repo,issue:c.issue};
  await io.resume(envelope);
  const pending=await current(c,io,d,{resume:true});
  const root=`/repos/${c.repo}/issues/${c.issue}/labels`;
  if(pending.labels.some(x=>x.name==='momoflow:needs-decision')) {
    try{await io.api('DELETE',`${root}/momoflow%3Aneeds-decision`);}
    catch(e){if(e.status!==404)throw e;} // A concurrent removal is safe only after fresh absence verification below.
  }
  const fresh=await current(c,io,d,{resume:true});
  assert(!fresh.labels.some(x=>x.name==='momoflow:needs-decision'),'Unresolved decision label');
  // Intent precedes dispatch. Lost responses are deliberately not replayed.
  record.state='dispatching';await io.saveDecision(d.id,record);
  await io.api('POST',root,{labels:['momoflow:ready']});
  assert((await list(io.api,root)).some(x=>x.name==='momoflow:ready'),'Decision ready grant unconfirmed');
  record.state='dispatched';await io.saveDecision(d.id,record);
  await io.preserve({...record,result:'ready grant confirmed; runner consumption pending'});
  await note(c,io,d,`재개 신호 부여 확인: ${r.action}; source ${r.source}. 동일 요청 소비/다음 역할의 실제 결과는 runner ledger에서 확인.`);
  return {decision:d.id,state:'dispatched'};
}
export async function connectedDecision(c,io,r) {
  const dir=join(c.stateRoot,keyFor(c));
  const ports={...io,
    loadDecision:id=>loadDecision(c,id),
    saveDecision:(id,v)=>atomic(join(dir,`decision-${id}.json`),v),
    resume:e=>atomic(join(c.inboxRoot,`${keyFor(c)}.json`),e,0o644),
    preserve:x=>atomic(join(dir,`decision-evidence-${digest(x)}.json`),x)};
  return r?applyDecision(c,ports,r):holdDecision(c,ports);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  // Reuse pinned installation, private config, manifest, authentication and runtime preflight.
  const {launchConfig,ports,inspect}=await import('./launch.mjs');
  const file=resolve(process.argv[2]),contents=await json(file),c=launchConfig({...contents,configFile:file,configContents:contents});
  const io=await ports(c);
  await withControllerLock(c,async()=>{
    await inspect(c,io,await io.load());
    const args=process.argv.slice(3),d=decisionReceipt(c,await io.ledger());
    if(!args.length || args[0]==='--show') {
      console.log(JSON.stringify({decision:d,ledger:await io.ledger(),instruction:'Use --continue|--reject REQUEST_ID --source ORIGINAL_ISSUE_OR_COMMENT_URL --only-request only after verifying existing authority and no other unresolved requests.'}));
      return;
    }
    const [action,id,sourceFlag,source,only]=args;
    assert(args.length===5 && ['--continue','--reject'].includes(action) && id===d.id && sourceFlag==='--source' && only==='--only-request','Exact request ID, source and --only-request attestation required');
    const r={request:d,action:action.slice(2)==='continue'?'continue':'reject',actor:'external-operator',authority:'existing-scope',source,unresolved:[id]};
    console.log(JSON.stringify(await connectedDecision(c,io,r)));
  });
}
