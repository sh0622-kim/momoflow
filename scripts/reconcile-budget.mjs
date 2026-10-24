// Narrow v4 external completion. No ledger writer, dispatch, deployment, or budget reset.
import {readFile,lstat,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {isDeepStrictEqual as same} from 'node:util';
import {digest,keyFor,validation} from './post-pr.mjs';
import {deploymentConfig,safeRuntime,profileIdentity} from './deploy.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const tuple=x=>({issue:x.issue,pr:x.pr,head:x.head,tree:x.tree,merge:x.merge});
const originals=['ledger','enrollment','manifest','launchJournal','controllerJournal','gate'];
export const budgetProfile=c=>c.profile==='controller-budget-exhausted-v4';
export const budgetChecks=['compose','build','contracts','node','sandbox','readiness'];
export const budgetSources=['originalIndex','authorization','recoveryAuthorization','correction','recoveryBuild','invocation','review','recoveryReview','buildNative','reviewNative','recoveryBuildNative','recoveryReviewNative','tests','testRequest','recoveryTests','recoveryTestRequest','previousRunner','actionResolution','previousBundle'];
export const budgetEvidenceNames=[...originals,'recovery','validation','ownership','ownershipRequest',...budgetSources,...['owner','recovery'].flatMap(p=>budgetChecks.map(n=>`${p}Log_${n}`))];
export async function budgetBytes(ref) {
 need(ref&&typeof ref.path==='string'&&resolve(ref.path)===ref.path&&hex(ref.hash),'Pinned v4 source reference required');
 const s=await lstat(ref.path);need(s.isFile()&&!s.isSymbolicLink()&&!(s.mode&0o022)&&await realpath(ref.path)===ref.path,'Private canonical v4 source required');
 const value=await readFile(ref.path);need(digest(value)===ref.hash,'V4 source bytes changed');return value;
}
function native(raw,session,model,effort,turn) {
 const rows=raw.toString().trim().split('\n').map(s=>JSON.parse(s));
 need(rows.find(x=>x.type==='session_meta')?.payload.id===session,'Native session identity mismatch');
 const contexts=rows.filter(x=>x.type==='turn_context'&&x.payload.turn_id===turn);
 const complete=rows.filter(x=>x.type==='event_msg'&&x.payload.type==='task_complete'&&x.payload.turn_id===turn);
 need(contexts.length===1&&complete.length===1,'One completed native invocation required');
 const c=contexts[0].payload,e=complete[0].payload;
 need(c.model===model&&c.effort===effort&&[undefined,null,'default'].includes(c.service_tier)&&typeof e.last_agent_message==='string'&&e.last_agent_message.trim()&&Number.isFinite(e.started_at)&&Number.isFinite(e.completed_at)&&e.completed_at>=e.started_at,'Native model/reasoning/completion mismatch');
 return {session,turn,model,effort,service_tier:c.service_tier??null,started:e.started_at,completed:e.completed_at,message:e.last_agent_message};
}
function recoveryTransport(raw,build,inv,success) {
 const rows=raw.toString().trim().split('\n').map(x=>JSON.parse(x)),at=Date.parse(inv.startedAt)/1000;
 const failed=rows.filter(x=>x.type==='event_msg'&&x.payload.type==='task_complete'&&x.payload.error&&x.payload.completed_at>=at&&x.payload.started_at<=success.started).map(x=>x.payload);
 const reported=build.transportInterruptions??[];
 need(Array.isArray(reported)&&same(reported.map(x=>x.turnId).sort(),failed.map(x=>x.turn_id).sort()),'All failed recovery transport turns must remain recorded');
 for(const failure of failed) {
  const refs=reported.filter(x=>x.turnId===failure.turn_id),context=rows.filter(x=>x.type==='turn_context'&&x.payload.turn_id===failure.turn_id);
  need(refs.length===1&&refs[0].code==='server_overloaded'&&failure.error.codex_error_info==='server_overloaded'&&failure.last_agent_message==null&&context.length===1&&context[0].payload.model==='gpt-6.1-sol'&&context[0].payload.effort==='medium'&&[undefined,null,'default'].includes(context[0].payload.service_tier)&&failure.completed_at<=success.started,'Same-attempt provider interruption provenance required');
 }
}
export function validateBudgetCompletion(b,ledger,data) {
 const parse=n=>JSON.parse(data[n]),p=parse('recovery'),manifest=parse('manifest'),enrollment=parse('enrollment'),launch=parse('launchJournal');
 const target=b.installation,last=ledger.events?.at(-1),index=parse('originalIndex'),gate=parse('gate');
 need(originals.every(n=>index[n]?.hash===b.evidence[n].hash&&index[n]?.source===b.evidence[n].path),'Captured original source index mismatch');
 need(gate.v===1&&hex(gate.generation)&&gate.paused===false,'Original unpaused admission gate required');
 need(b.v===4&&budgetProfile(b)&&b.originalIterations===3&&b.originalLimit===3&&b.externalIterations===2&&b.recoveryIterations===1&&b.externalBudget===undefined&&b.controllerTree===target.tree,'Normal exhaustion separate3+2+1 scope mismatch');
 need(ledger.issue===b.issue&&ledger.launch?.repo===b.repo&&ledger.launch.issue===b.issue&&ledger.launch.base===b.base&&ledger.launch.limit===3&&ledger.iterations===3&&same(manifest,ledger.launch)&&same(enrollment,manifest),'Exhausted original launch/enrollment/history mismatch');
 need(ledger.stage==='blocked'&&ledger.reason==='Shared iteration budget exhausted'&&ledger.in_flight===false&&ledger.active_session===null&&ledger.publication==null&&data.controllerJournal===null,'Normal released exhaustion with no publication/host required');
 need(last?.role==='review'&&last.iteration===3&&last.result?.status==='changes_requested'&&last.session?.result==='turn_completed'&&['session_id','thread_id','turn_id'].every(k=>typeof last.session[k]==='string'&&last.session[k]),'Last completed third review required');
 const s=last.session.effective_settings;
 need(s?.model==='gpt-6-astra'&&s.reasoningEffort==='high'&&s.serviceTier==='default','Original final review settings missing');
 need(launch.contract===digest(manifest)&&launch.dispatched===true&&launch.observed===true&&launch.done!==true&&launch.blocker==='Terminal/interrupted ledger requires recovery','Original unfinished normal-stop launch required');
 need(p.kind==='controller-budget-exhausted-package-v4'&&p.repo===b.repo&&same(p.owner,tuple(b))&&same(p.installation,target)&&same(p.originalHashes,Object.fromEntries(originals.map(n=>[n,b.evidence[n].hash])))&&p.remainingObservation==='natural-observation-pending','Prepared normal-stop package/original binding mismatch');
 const a=parse('authorization'),ra=parse('recoveryAuthorization'),inv=parse('invocation');
 need(['explicit-user-reply','explicit-user-request'].includes(a.source)&&typeof a.userRequest==='string'&&a.userRequest.trim()&&a.ownerIssue===Number(b.issue)&&a.ownerPr===b.pr&&a.originalUsed===3&&a.originalLimit===3&&a.externalAlreadyUsed===1&&a.additionalCorrectionLimit===1&&a.externalCorrectionTotalLimit===2&&a.separateRecoveryImplementationLimit===1,'Scoped external correction2 and separate recovery1 authorization required');
 need(ra.source==='explicit-user-request'&&ra.userRequest===a.userRequest&&ra.issue===Number(target.issue)&&ra.ownerIssue===Number(b.issue)&&ra.ownerPr===b.pr&&ra.implementationLimit===1&&ra.sourceAuthorization===b.evidence.authorization.path&&same(ra.originalOwnerUsage,{originalUsed:3,originalLimit:3,externalPreviouslyUsed:1,externalApprovedTotal:2}),'Separate recovery authorization mismatch');
 need(Number.isFinite(Date.parse(a.at))&&Number.isFinite(Date.parse(ra.at))&&Date.parse(ra.at)>=Date.parse(a.at),'Authorization chronology required');
 need(inv.issue===Number(target.issue)&&inv.execution==='external'&&inv.implementationUsed===1&&inv.implementationLimit===1&&sha(inv.base)&&same(inv.ownerUsage,{originalUsed:3,originalLimit:3,externalCorrectionUsed:2,externalCorrectionLimit:2})&&Number.isFinite(Date.parse(inv.startedAt))&&Date.parse(inv.startedAt)>=Date.parse(ra.at),'Actual separate recovery invocation required');
 const histories=[];
 for(const [prefix,t,buildName,reviewName,bnative,rnative] of [['owner',b,'correction','review','buildNative','reviewNative'],['recovery',target,'recoveryBuild','recoveryReview','recoveryBuildNative','recoveryReviewNative']]) {
  const build=parse(buildName),review=parse(reviewName),bs=build.session;
  need(build.frozen===true&&sha(build.baseHead)&&bs?.actualModel==='gpt-6.1-sol'&&bs.actualReasoning==='medium'&&bs.fastOffPolicy===true&&bs.fastOffRuntimeProven===false&&bs.settingsChanged===false&&[null,'default'].includes(bs.service_tier),'Actual external build policy/evidence required');
  need(build.budget?.originalUsed===3&&build.budget.originalLimit===3&&build.budget.externalCorrectionUsed===2&&build.budget.externalCorrectionLimit===2&&build.budget.separateRecoveryUsed===(prefix==='owner'?0:1),'Distinct original/correction/recovery counts required');
  need(review.status==='approved'&&review.repo===b.repo&&String(review.issue)===t.issue&&review.pr===t.pr&&review.head===t.head&&review.tree===t.tree&&review.model==='gpt-6-astra'&&review.reasoning==='high'&&review.fastOffPolicy===true&&review.fastOffRuntimeProven===false&&[null,'default'].includes(review.service_tier)&&review.buildSession===bs.id&&review.session!==bs.id&&Array.isArray(review.findings)&&review.findings.length===0,'Separate exact-head external review required');
  const bt=native(data[bnative],bs.id,'gpt-6.1-sol','medium',p.turns[prefix].build),rt=native(data[rnative],review.session,'gpt-6-astra','high',p.turns[prefix].review);
  need(bt.started>=Math.floor(Date.parse(prefix==='owner'?a.at:ra.at)/1000)&&bt.service_tier===bs.service_tier&&rt.service_tier===review.service_tier&&rt.completed>=bt.completed&&/approved/i.test(rt.message)&&rt.message.includes(t.head.slice(0,8)),'Actual settings/completed exact-head review mismatch');
  histories.push({build:bt,review:rt});
  if(prefix==='recovery'){need(build.baseHead===inv.base&&build.invocation?.issue===inv.issue&&build.invocation.startedAt===inv.startedAt&&bt.started>=Math.floor(Date.parse(inv.startedAt)/1000),'Recovery invocation must be separately scoped even when thread is reused');recoveryTransport(data[bnative],build,inv,bt);}
  const result=parse(prefix==='owner'?'tests':'recoveryTests'),request=parse(prefix==='owner'?'testRequest':'recoveryTestRequest');
  need(sha(p.validationOrigins[prefix])&&request.repo===b.repo&&String(request.issue)===t.issue&&request.head===t.head&&request.tree===t.tree&&request.base===b.base&&sha(request.base_head),'Exact raw validation request/scope required');
  validation({controllerVersion:p.validationOrigins[prefix]},request,result);
  need(result.kind==='passed'&&result.checks.length===budgetChecks.length&&budgetChecks.every(n=>result.checks.filter(r=>r.name===n&&r.exit===0).length===1),'Passed pinned Docker validation required');
  for(const name of budgetChecks)need(digest(data[`${prefix}Log_${name}`])===result.checks.find(x=>x.name===name).log,'Validation log bytes/hash mismatch');
  const contracts=result.checks.find(x=>x.name==='contracts'),node=result.checks.find(x=>x.name==='node');
  const contractSummary=[...data[`${prefix}Log_contracts`].toString().matchAll(/(\d+) tests, (\d+) failures/g)].at(-1);
  const summary=name=>[...data[`${prefix}Log_node`].toString().matchAll(new RegExp('^# '+name+' (\\d+)$','gm'))].at(-1)?.[1];
  need(contracts.tests>=125&&node.tests>=613&&Number(contractSummary?.[1])===contracts.tests&&Number(contractSummary?.[2])===0&&Number(summary('tests'))===node.tests&&Number(summary('pass'))===node.tests&&Number(summary('fail'))===0&&Number(summary('skipped'))===0,'Complete baseline role/Node assertion logs with zero skipped required');

 }
 need(histories[1].build.started>histories[0].build.started&&histories[1].build.turn!==histories[0].build.turn&&histories[1].review.turn!==histories[0].review.turn,'Distinct correction/recovery invocations required');
 const resolution=parse('actionResolution');
 need(resolution.kind==='operator-action-resolution-v4'&&resolution.actor==='external-operator'&&resolution.authority==='existing-scope'&&resolution.repo===b.repo&&same(resolution.owner,tuple(b))&&same(resolution.installation,target)&&resolution.authorizationHash===b.evidence.authorization.hash&&resolution.remainingObservation==='natural-observation-pending'&&Number.isFinite(Date.parse(resolution.at))&&Date.parse(resolution.at)/1000>=Math.max(...histories.map(h=>h.review.completed))&&Array.isArray(resolution.labels)&&resolution.labels.every(x=>[b.issue,target.issue].includes(x.issue)&&['momoflow:needs-decision','momoflow:needs-review'].includes(x.name)),'Explicit post-review operator action resolution required');
 const request=parse('ownershipRequest'),proof=parse('ownership'),install=parse('validation'),bundle=parse('previousBundle');
 deploymentConfig(request,{ownership:true});safeRuntime(request,request.current);
 need(!request.authBindProof&&request.repo===b.repo&&request.issue===b.issue&&request.base===b.base&&request.controllerVersion===target.merge&&request.dataVolume===b.dataVolume&&same(request.manifest,{status:'present',value:manifest})&&request.current.image===b.engineImage&&request.current.runnerSource===b.runnerSource&&digest(data.previousRunner)===b.runnerSource,'Verified previous bundle/source required');
 need(bundle.kind==='pinned-previous-bundle-v4'&&bundle.commit===request.current.commit&&same(Object.keys(bundle.files).sort(),Object.keys(request.current.files).sort())&&Object.entries(bundle.files).every(([path,value])=>digest(Buffer.from(value,'base64'))===request.current.files[path]),'Archived pinned previous bundle bytes required');
 need(install.kind==='observed-controller-install-v4'&&install.commit===target.merge&&install.tree===target.tree&&hex(install.runnerSource)&&install.runnerSource!==b.runnerSource&&install.ownershipHash===b.evidence.ownership.hash,'Observed new controller and unchanged old engine required');
 budgetBundlePaths(request,bundle);
 const services=proof.serviceEvidence?.services,own=proof.ledgerHashes?.filter(x=>x.file===keyFor(b)+'.json');
 need(proof.kind==='deployment-ownership-v1'&&proof.effects==='none'&&proof.repo===b.repo&&proof.base===b.base&&proof.project===request.project&&proof.controllerVersion===target.merge&&proof.engine===b.engineContainer&&proof.engineImage===b.engineImage&&proof.dataVolume===b.dataVolume&&same(proof.sourceRequest,b.evidence.ownershipRequest)&&proof.runtimeIdle===true&&proof.controllerLock===false&&proof.manifestContract===digest(manifest)&&own?.length===1&&own[0].ledgerHash===b.evidence.ledger.hash&&own[0].enrollmentHash===b.evidence.enrollment.hash,'Full previous-engine/current-controller ownership proof required');
 need(/^[a-f0-9-]{36}$/.test(proof.serviceEvidence?.kernel||'')&&Array.isArray(services)&&services.length===2&&['symphony','github-auth'].every(service=>{
  const rows=services.filter(x=>x.service===service),x=rows[0],expected=request.current.inspect[service];
  return rows.length===1&&hex(x.id)&&x.image===(service==='symphony'?b.engineImage:request.current.authImage)&&x.runtimeHash===digest({...expected,mounts:expected.mounts.map(m=>m.type==='bind'?{...m,source:null}:m)})&&Array.isArray(x.mountHashes)&&x.mountHashes.length===expected.mounts.length&&new Set(x.mountHashes.map(m=>m.destination)).size===x.mountHashes.length&&x.mountHashes.every(m=>expected.mounts.some(e=>e.type===m.type&&e.destination===m.destination&&e.rw===m.rw)&&hex(m.identityHash));
 })&&services.find(x=>x.service==='symphony').id===b.engineContainer,'Complete pinned engine/auth runtime/mount proof required');
 return p;
}
export function budgetBundlePaths(request,bundle) {
 const b=request.current;
 need(bundle.commit===b.commit&&same(Object.keys(bundle.files).sort(),Object.keys(b.files).sort())&&Object.entries(bundle.files).every(([p,v])=>digest(Buffer.from(v,'base64'))===b.files[p]),'Pinned previous bundle source bytes mismatch');
 const doc=JSON.parse(Buffer.from(bundle.files[b.composeFile],'base64'));
 need(doc.services?.symphony?.image===b.image&&doc.services?.['github-auth']?.image===b.authImage,'Previous bundle image mismatch');
 need(same(Object.keys(doc.services||{}).sort(),['github-auth','symphony']),'Exact previous service bundle required');
 const workflows=(doc.services.symphony.volumes||[]).filter(x=>x.type==='bind'&&x.target==='/config/WORKFLOW.md');
 const profiles=Object.values(doc.services).flatMap(x=>(x.security_opt||[]).filter(s=>s.startsWith('seccomp=')).map(s=>s.slice(8)));
 need(workflows.length===1&&workflows[0].read_only===true&&workflows[0].source===b.inspect.symphony.mounts.find(m=>m.destination==='/config/WORKFLOW.md')?.source&&profiles.length===1,'Fixed workflow/security bundle required');
 for(const [service,value] of Object.entries(doc.services))for(const opt of value.security_opt||[])if(opt.startsWith('seccomp=')){const raw=bundle.files[opt.slice(8)];need(typeof raw==='string'&&b.inspect[service].securityOpt.includes(profileIdentity(Buffer.from(raw,'base64').toString())),'Previous seccomp source/runtime mismatch');}
 const paths=[b.composeFile,workflows[0].source,...profiles];
 need(paths.every(p=>typeof p==='string'&&resolve(p)===p)&&new Set(paths).size===3&&same(paths.sort(),Object.keys(b.files).sort()),'No generic previous-bundle mount allowlist');
 return paths;
}
export async function budgetSourceChecks(c,{historical=false}={}) {
 const request=JSON.parse(await budgetBytes(c.evidence.ownershipRequest));
 need(request.current.image===c.engineImage&&request.current.runnerSource===c.runnerSource&&digest(await budgetBytes(c.evidence.previousRunner))===c.runnerSource,'Previous running engine source/image mismatch');
 const bundle=JSON.parse(await budgetBytes(c.evidence.previousBundle));
 budgetBundlePaths(request,bundle);
 if(!historical)for(const [path,hash] of Object.entries(request.current.files))need(digest(await budgetBytes({path,hash}))===digest(Buffer.from(bundle.files[path],'base64')),'Live previous bundle bytes changed');
 return request.current.runnerSource;
}
export async function budgetExtraMounts(c,{historical=false}={}) {
 if(historical)return [];
 const request=JSON.parse(await budgetBytes(c.evidence.ownershipRequest));deploymentConfig(request,{ownership:true});
 const bundle=JSON.parse(await budgetBytes(c.evidence.previousBundle));
 return budgetBundlePaths(request,bundle).map(path=>({path,hash:request.current.files[path]}));
}
// Read-only GitHub verification before preparation writes anything. GitHub's current
// PR base SHA can advance after merge; fixed merge parents prove the authorized chain.
export async function budgetRemoteChecks(c,data,api) {
 const rawOwner=JSON.parse(data.testRequest),rawRecovery=JSON.parse(data.recoveryTestRequest),resolution=JSON.parse(data.actionResolution);
 for(const [t,raw] of [[c,rawOwner],[c.installation,rawRecovery]]) {
  const root=`/repos/${c.repo}`,issue=await api('GET',`${root}/issues/${t.issue}`),pr=await api('GET',`${root}/pulls/${t.pr}`);
  need(['open','closed'].includes(issue.state)&&String(issue.number)===t.issue&&!issue.pull_request&&Array.isArray(issue.labels)&&!issue.labels.some(x=>x.name==='momoflow:ready')&&issue.labels.filter(x=>['momoflow:needs-decision','momoflow:needs-review'].includes(x.name)).every(x=>resolution.labels.some(r=>r.issue===t.issue&&r.name===x.name)),'Open/closed non-ready explicitly resolved issue required');
  need(pr.merged===true&&pr.state==='closed'&&pr.merge_commit_sha===t.merge&&pr.head?.sha===t.head&&pr.head.repo?.full_name===c.repo&&pr.base?.ref===c.base&&pr.base.repo?.full_name===c.repo,'Prepared exact merged PR scope mismatch');
  const head=await api('GET',`${root}/git/commits/${t.head}`),merge=await api('GET',`${root}/git/commits/${t.merge}`);
  need(head.tree?.sha===t.tree&&merge.tree?.sha===t.tree&&merge.parents?.length===2&&merge.parents[1].sha===t.head&&(t===c?merge.parents[0].sha===raw.base_head:[raw.base_head,c.merge].includes(merge.parents[0].sha)&&[rawOwner.base_head,c.merge].includes(raw.base_head)),'Prepared exact tree/base/merge parent mismatch');
 }
}
