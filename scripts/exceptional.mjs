// Trusted installed host only. No candidate imports, shell hooks, auth migration or policy editor.
import { readFile, readdir, mkdir, open, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { writeSync } from 'node:fs';
import { json, atomic, digest, keyFor, github, list, verifyInstall, withControllerLock } from './post-pr.mjs';
import { DeploymentError, deploymentConfig, deploymentEvidence, deploymentExclusions, connectedExceptionalCompletion } from './deploy.mjs';
import { finishConfig, prepareCompletion, privatePath, immutable, finish, completionPorts, observeCompletion } from './finish.mjs';
const need=(v,m)=>{if(!v)throw new DeploymentError(m);};
const keys=(x,ks)=>x && same(Object.keys(x).sort(),ks.split(' ').sort());
const optional=async p=>{try{return await json(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
export const exceptionalScope=Object.freeze(['deploy-tested-image','verify-or-rollback','archive-retire-exact-manifest','resume-admission','report-and-close']);
const supported=new Map([
 ...['engine/admission.ex','engine/work_status.ex','patches/admission.patch','patches/work-status.patch'].map(p=>[p,'engine-dashboard']),
 ...['deploy','finish','launch','decision','exceptional','work-status','reconcile-external','prepare-reconciliation'].flatMap(n=>[[`scripts/${n}.mjs`,'host-controller'],[`scripts/${n}.test.mjs`,'regression-test']])
]);
// Classify every path, including paths ordinary deployment would allow. Unknown data paths
// cannot silently become an unchanged-data assertion. No caller-provided allowlist.
export function classifyChanges(files) {
 need(Array.isArray(files) && files.length>0,'Complete changed paths required');
 const rows=files.map(f=>{
  let kind=supported.get(f.filename),blocker;
  if(f.previous_filename || f.status==='renamed')blocker='rename unsupported; inspect both original and new paths';
  else if(!['modified','added','removed'].includes(f.status))blocker='unknown change status';
  else if(!kind && /^docs\/(?!agent-policy\.md$|constitution\.md$|deployment\.md$|deployment-fixture\.md$|post-pr\.md$|github-flow\.md$|human-actions\.md$|records\.md$)[\w/-]+\.md$/.test(f.filename))kind='documentation';
  else if(!kind)blocker='unsupported auth/data/permission/model/budget/policy or unclassified path';
  return {path:f.filename,...(f.previous_filename?{previous:f.previous_filename}:{}),kind:kind || 'unsupported',...(blocker?{blocker}:{})};
 });
 need(new Set(rows.map(x=>x.path)).size===rows.length,'Duplicate changed paths');
 return {rows,exclusions:deploymentExclusions(files),blockers:rows.filter(x=>x.blocker)};
}
export function requireSupported(files,expected) {
 const r=classifyChanges(files);
 need(r.blockers.length===0,'Unsupported exceptional paths: '+r.blockers.map(x=>`${x.path}: ${x.blocker}`).join('; '));
 need(r.exclusions.length>0,'No ordinary exclusion; use ordinary completion');
 if(expected)need(same(r,expected),'Changed path classification differs from prepared request');
 return r;
}
export function exceptionalPlan(p) {
 need(keys(p,'v kind config controllerVersion validationOrigin unchanged') && p.v===1 && p.kind==='exceptional-completion-v1','Fixed exceptional plan fields required; unknown fields forbidden');
 need(typeof p.config==='string' && resolve(p.config)===p.config && /^[a-f0-9]{40}$/.test(p.controllerVersion) && /^[a-f0-9]{40}$/.test(p.validationOrigin),'Pinned canonical config/controller/validation origin required');
 need(keys(p.unchanged,'auth permissions rolePolicy data checks') && Object.values(p.unchanged).every(x=>x===true),'Reviewed unchanged auth/permissions/rolePolicy/data/checks declaration required; migrations/expanded authority unsupported');
 return p;
}
async function originalContext(planFile) {
 await privatePath(planFile);const plan=exceptionalPlan(await json(planFile));
 await privatePath(plan.config);const contents=await json(plan.config);
 const original={...contents,configFile:plan.config,configContents:contents,launch:{v:1,id:contents.launchId,repo:contents.repo,issue:contents.issue,base:contents.base,limit:contents.iterationLimit}};
 finishConfig(original);
 const c={...original,controllerVersion:plan.controllerVersion};
 await verifyInstall(c);need(!c.trustedRoot.startsWith('/data/workspaces/'),'Independent host installation required');
 const dir=join(c.stateRoot,keyFor(c));
 for(const p of [c.stateRoot,c.inboxRoot,c.launchRoot,dir,c.finish.gateRoot])await privatePath(p,true);
 return {plan,c,original,dir};
}
export async function pinOriginals(paths) {
 const result=[];
 for(const path of paths) {await privatePath(path);result.push({path,hash:digest(await readFile(path))});}
 return result;
}
export async function verifyOriginals(rows) {
 for(const x of rows) {await privatePath(x.path);need(digest(await readFile(x.path))===x.hash,'Original evidence/config changed: '+x.path);}
}
async function evidenceFor(dir,j,p) {
 const matches=[];
 for(const name of await readdir(dir))if(/^evidence-[a-f0-9]{64}\.json$/.test(name)) {
  const path=join(dir,name);await privatePath(path);const e=await json(path);
  if(e.merge===j.merged && same(e.publication,p)) {need(name===`evidence-${digest(e)}.json`,'Evidence filename mismatch');matches.push({path,e});}
 }
 need(matches.length===1,'Unique original merge evidence required');return matches[0];
}
export async function prepareExceptional(planFile) {
 const {plan,c,original,dir}=await originalContext(planFile);
 return withControllerLock(c,async()=>{
  await verifyInstall(c);
  const excluded=await json(join(dir,'completion.json'));
  need(excluded.phase==='excluded' && excluded.request===digest(original.configContents),'Original excluded completion required; never reset or adopt partial completion');
  let evidencePath;
  const {j,p,e}=await prepareCompletion(original,{
   launch:()=>json(join(dir,'launch.json')),host:()=>json(join(dir,'journal.json')),ledger:()=>json(join(c.ledgerRoot,keyFor(c)+'.json')),
   evidence:async(j,p)=>{const found=await evidenceFor(dir,j,p);evidencePath=found.path;return found.e;}
  });
  need(plan.validationOrigin===e.validation.origin && plan.validationOrigin===original.controllerVersion,'Preserve original validation producer; do not rewrite receipts');
  need(excluded.publication && same(excluded.publication,p) && excluded.evidence?.hash===digest(e),'Excluded completion does not identify this preserved publication/evidence');
  const api=github(c),source=await api('GET',`/repos/${c.repo}/contents/engine/role_runner.ex?ref=${j.merged}`);
  need(source.encoding==='base64','Exact merged runner source required');
  const ledgerFile=join(c.ledgerRoot,keyFor(c)+'.json');
  need(same(await json(ledgerFile+'.enrolled'),c.launch),'Original enrollment differs from launch');
  const previous=c.finish.previous,doc=await json(previous.composeFile);
  need(digest(await readFile(previous.composeFile))===previous.composeHash,'Previous bundle changed');
  doc.services.symphony.image=e.validation.image;
  const id=digest({kind:plan.kind,plan:digest(await readFile(planFile)),publication:p,merge:j.merged,evidence:digest(e),excluded:digest(await readFile(join(dir,'completion.json')))});
  const root=join(dir,'exceptional-'+id);await mkdir(root,{mode:0o700,recursive:true});await privatePath(root,true);
  const composeFile=join(root,'compose.json'),bytes=Buffer.from(JSON.stringify(doc,null,2));await immutable(composeFile,bytes);
  const target={...previous,commit:j.merged,image:e.validation.image,runnerSource:digest(Buffer.from(source.content,'base64')),composeFile,composeHash:digest(bytes),files:{...previous.files,[composeFile]:digest(bytes)},inspect:{...previous.inspect,symphony:{...previous.inspect.symphony,image:e.validation.image}}};
  delete target.files[previous.composeFile];
  const originalFiles=await pinOriginals([planFile,plan.config,join(dir,'completion.json'),join(dir,'launch.json'),join(dir,'journal.json'),ledgerFile,ledgerFile+'.enrolled',evidencePath,...e.validation.checks.map(x=>join(dir,'logs',x.log))]);
  const request={...c.finish,repo:c.repo,issue:c.issue,base:c.base,authority:{deploy:true},hold:false,compatibility:'unchanged-data',exceptional:false,
   ...Object.fromEntries(['trustedRoot','controllerVersion','stateRoot','inboxRoot','ledgerRoot','tokenFile','launchRoot','engineURL','requiredChecks','requiredReviewers'].map(k=>[k,c[k]])),
   ...(c.operatorContainer?{operatorContainer:c.operatorContainer}:{}),...(c.dockerConfig?{dockerConfig:c.dockerConfig}:{}),validationOrigin:plan.validationOrigin,deploymentId:id,
   completionOwner:{file:keyFor(c)+'.json',ledgerHash:originalFiles.find(x=>x.path===ledgerFile).hash,enrollmentHash:originalFiles.find(x=>x.path===ledgerFile+'.enrolled').hash},
   target,previous,manifest:{status:'present',value:c.launch},evidence:{path:evidencePath,hash:digest(e)}};
  deploymentConfig(request);
  let classification;
  const gate=await deploymentEvidence(request,e,api,h=>readFile(join(dir,'logs',h)),{classifyExceptional:files=>{classification=requireSupported(files);}});
  await verifyOriginals(originalFiles);
  const prepared={v:1,kind:plan.kind,id,scope:exceptionalScope,publication:p,gate,classification,request,launch:c.launch,originals:originalFiles,
   controllerVersion:plan.controllerVersion,validationOrigin:plan.validationOrigin,roleEvidence:e.ledger.events.slice(-2),checks:e.validation.checks,
   rollback:{previous,backup:'images.tar + data.tar + immutable bundle files; data.tar never restored over live records',failure:'fence, restore previous image/config, verify; keep admission paused if recovery/authority uncertain'},
   instruction:'External operator must verify the specific user judgment/source and unchanged declaration. Labels, shared-account comments, app replies and this proposal do not authenticate a human.'};
  const preparedFile=join(root,'prepared.json');await immutable(join(root,'request.json'),Buffer.from(JSON.stringify(request,null,2)));
  await immutable(preparedFile,Buffer.from(JSON.stringify(prepared,null,2)));
  await exceptionalReport(c,prepared,{phase:'awaiting_approval',request:digest(prepared)},root,{close:false});
  return {preparedFile,digest:digest(prepared),prepared};
 });
}
// Uses the same external-operator attestation boundary as decision.mjs, not a human ID claim.
export function approvalResponse(prepared,r,now=Date.now(),{historical=false}={}) {
 need(keys(r,'prepared scope actor authority source action at expiresAt') && r.prepared===digest(prepared) && same(r.scope,prepared.scope),'Exact prepared digest/scope required; unknown response fields forbidden');
 need(r.actor==='external-operator' && r.authority==='existing-scope' && ['approve','reject','revoke'].includes(r.action),'Existing-scope external operator confirmation required');
 const repo=prepared.request.repo.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 need(typeof r.source==='string' && new RegExp(`^https://github\\.com/${repo}/issues/${prepared.request.issue}(#issuecomment-[0-9]+)?$`).test(r.source),'Original issue judgment source required; source is not human authentication');
 const at=Date.parse(r.at),expiry=Date.parse(r.expiresAt);
 need(Number.isFinite(at) && at<=now && (historical || at>=now-86400000) && expiry>at && expiry<=at+86400000,'Bounded operator response time/expiry required (24h maximum)');
 if(r.action==='approve' && !historical)need(expiry>now,'Approval expired');
 return r;
}
async function readPrepared(file,{execution=false}={}) {
 await privatePath(file);const p=await json(file);
 need(p.v===1 && p.kind==='exceptional-completion-v1' && same(p.scope,exceptionalScope) && p.id===p.request?.deploymentId,'Invalid exceptional preparation');
 const c=execution?{...p.request,launch:p.launch}:(await originalContext(p.originals?.[0]?.path)).c;
 deploymentConfig(p.request);await verifyInstall(c);await privatePath(dirname(file),true);
 need(c.controllerVersion===p.controllerVersion && same(c.launch,p.launch),'Prepared installation/launch differs');
 need(file===join(c.stateRoot,keyFor(c),'exceptional-'+p.id,'prepared.json'),'Prepared path/identity mismatch');
 if(!execution)await verifyOriginals(p.originals);
 need(same(await json(join(dirname(file),'request.json')),p.request),'Prepared deployment request changed');
 return {p,c,root:dirname(file)};
}
async function withRecordLock(root,name,action) {
 const path=join(root,name+'.lock'),f=await open(path,'wx',0o600);
 try {await f.writeFile(JSON.stringify({pid:process.pid}));await f.sync();return await action();}finally{await f.close();await rm(path);}
}
export async function respondExceptional(file,responseFile) {
 const {p,c,root}=await readPrepared(file);await privatePath(responseFile);
 const r=approvalResponse(p,await json(responseFile));
 const result=await recordResponse(p,root,r);
 await exceptionalReport(c,p,{phase:result.result},root,{close:false});return result;
}
// Shared with the explicitly credential-free isolated harness. Production still
// reaches this only after readPrepared verifies the installed/original contracts.
export async function recordResponse(p,root,r) {
 await privatePath(root,true);
 approvalResponse(p,r);
 return withRecordLock(root,'response',async()=>{
  const path=join(root,'approval.json'),old=await optional(path);
  if(old && same(old.response,r))return old;
  need(!old || r.action==='revoke' && old.response.action==='approve','Decision already processed; no replacement approval, rejection or reordered response');
  const record={prepared:digest(p),response:r,processedAt:new Date().toISOString(),result:r.action==='approve'?'approved':r.action==='reject'?'rejected':'revoked',previous:old?digest(old):null};
  await immutable(join(root,`response-${digest(record)}.json`),Buffer.from(JSON.stringify(record,null,2)));await atomic(path,record);return record;
 });
}
export async function requireApproval(p,root,now=Date.now()) {
 await privatePath(root,true);
 const path=join(root,'approval.json');await privatePath(path);const a=await json(path);
 approvalResponse(p,a.response,now);
 need(a.prepared===digest(p) && a.result==='approved' && a.response.action==='approve','Approval rejected or revoked');
 const history=join(root,`response-${digest(a)}.json`);await privatePath(history);
 need(same(await json(history),a),'Approval processing history differs');
 need(Date.parse(a.response.expiresAt)>now,'Approval expired');return a;
}
// Both workpad and PR reporting precede issue closure. A retry replaces only this section.
export async function exceptionalReport(c,p,result,root,{close=true}={}) {
 return withRecordLock(root,'report',async()=>{
 // Serialize all publishers and derive presentation from durable execution and
 // the current decision, never from an older prepare/respond caller's hint.
 const previous=await optional(join(root,'report.json'));
 need(!previous || previous.prepared===digest(p),'Report belongs to another preparation');
 const completion=await optional(join(root,'completion.json'));
 if(completion) {
  need(completion.request===digest(p),'Completion belongs to another preparation');
  result=completion;
 } else if(['awaiting_approval','approved','rejected','revoked'].includes(result.phase)) {
  result=previous?.execution || result;
 }
 const api=github(c),marker=`<!-- momoflow:exceptional:${p.id} -->`,end=`<!-- momoflow:exceptional:${p.id}:end -->`;
 const approval=await optional(join(root,'approval.json'));
 if(!completion && !previous?.execution && ['awaiting_approval','approved','rejected','revoked'].includes(result.phase)) {
  let phase=approval?.result || 'awaiting_approval';
  if(phase==='approved' && Date.parse(approval.response.expiresAt)<=Date.now())phase='expired';
  result={phase};
 }
 const success=result.phase==='complete' && result.recheck?.status!=='blocked';
 const body=`${marker}\n**예외 배포 판단:** ${success?'해결 · 검증 및 exact manifest 퇴역 완료':result.phase}. 대상 head ${p.publication.head}, tree ${p.publication.tree}, merge ${p.request.target.commit}, image ${p.request.target.image}.\n준비 digest ${digest(p)}; controller ${p.controllerVersion}; validation producer ${p.validationOrigin}.\n일반 제외: ${p.classification.exclusions.map(x=>x.path).join(', ')}.\n승인 출처 ${approval?.response.source || '미입력'}; 처리 ${approval?.result || '대기'}, 시각 ${approval?.processedAt || '미입력'}; 실행 연결 ${result.approval?.hash || '미실행'}. 사람 인증 아님.\n결과 ${result.phase}; ${result.reason || result.recheck?.reason || ''}\n다음 행동: ${success?'후속 자동 실행 없음; 운영 관찰 기록 보존':'검토 자료와 exact digest/scope 확인 후 기존 권한 안의 운영자 응답 또는 보존된 journal 복구'}.\n${end}`;
 const pads=(await list(api,`/repos/${c.repo}/issues/${c.issue}/comments`)).filter(x=>x.body?.includes('<!-- momoflow:workpad -->'));
 need(pads.length===1,'Exactly one workpad required');const pad=pads[0],i=pad.body.indexOf(marker),k=pad.body.indexOf(end);
 need(i<0 && k<0 || i>=0 && k>i,'Malformed exceptional workpad section');
 const updated=i<0?pad.body+'\n\n'+body:pad.body.slice(0,i)+body+pad.body.slice(k+end.length);
 if(updated!==pad.body)await api('PATCH',`/repos/${c.repo}/issues/comments/${pad.id}`,{body:updated});
 const path=`/repos/${c.repo}/issues/${p.publication.pr}/comments`,comments=(await list(api,path)).filter(x=>x.body?.includes(marker));
 need(comments.length<=1,'Duplicate exceptional PR report');
 await api(comments.length?'PATCH':'POST',comments.length?`/repos/${c.repo}/issues/comments/${comments[0].id}`:path,{body});
 // Conservative shared labels: resolve this request's section, preserve other requests' indications.
 if(result.phase==='awaiting_approval')for(const n of [c.issue,p.publication.pr])await api('POST',`/repos/${c.repo}/issues/${n}/labels`,{labels:['momoflow:needs-decision']});
 const report={prepared:digest(p),phase:result.phase,workpad:pad.id,pr:p.publication.pr,at:new Date().toISOString(),closed:previous?.closed===true,
  decision:approval || null,...(!['awaiting_approval','approved','rejected','revoked','expired'].includes(result.phase)?{execution:result}:{})};
 // Closure is an independently observed receipt; a duplicate decision cannot erase it.
 if(success && close)report.closed=(await api('GET',`/repos/${c.repo}/issues/${c.issue}`)).state==='closed';
 await atomic(join(root,'report.json'),report);
 if(success && close) {
  const path=`/repos/${c.repo}/issues/${c.issue}`;
  if((await api('GET',path)).state!=='closed') {
   await requireApproval(p,root); // Reporting prior effects does not grant a new close effect after withdrawal/expiry.
   await api('PATCH',path,{state:'closed',state_reason:'completed'});
  }
  need((await api('GET',path)).state==='closed','Exceptional issue close not confirmed');
  await atomic(join(root,'report.json'),{...report,closed:true});
 }
 });
}
// Shared authorization boundary; no deployment effects.
export async function authorizeExceptional(p,root,file) {
 const request=p.request,journalFile=join(root,'completion.json');
 const classifyExceptional=files=>requireSupported(files,p.classification);
  await verifyOriginals(p.originals);await privatePath(file);need(digest(await json(file))===digest(p),'Prepared material changed');
  const completed=await optional(journalFile);
  if(completed?.phase==='complete') {
   // Reporting/verification after success performs no deployment/retirement effects.
   // Expiry/revocation cannot erase a previously persisted approval/effect receipt.
   const receipt=completed.approval;
   need(receipt?.hash,'Completed execution approval receipt missing');
   const a=await json(join(root,`response-${receipt.hash}.json`));
   need(digest(a)===receipt.hash && a.result==='approved','Execution approval receipt changed');
   approvalResponse(p,a.response,Date.now(),{historical:true});
  } else await requireApproval(p,root);
  await deploymentEvidence(request,await json(request.evidence.path),github(request),h=>readFile(join(dirname(request.evidence.path),'logs',h)),{classifyExceptional});
  // Fresh GitHub evidence is slow; withdrawal/expiry during it must win.
  if(completed?.phase!=='complete')await requireApproval(p,root);
}
export async function executeExceptional(file) {
 const {p,c,root}=await readPrepared(file,{execution:true}),request=p.request;
 const journalFile=join(root,'completion.json');
 const classifyExceptional=files=>requireSupported(files,p.classification);
 const authorize=()=>authorizeExceptional(p,root,file);
 try {return await connectedExceptionalCompletion(request,join(root,'request.json'),async ports=>{
  await authorize();
  const old=await optional(journalFile),approved=old?.approval || {hash:digest(await requireApproval(p,root))};
  const runtime={...c,configContents:p}; // New record identity; original launch config remains byte-for-byte intact.
  const io=completionPorts(runtime,request,ports,{journalFile,authorize,publication:p.publication,
   report:async result=>{await observeCompletion(c,result,p.publication);await exceptionalReport(c,p,result,root);}});
  const save=io.save;io.save=x=>{x.approval ||= approved;return save(x);};
  return finish(runtime,io);
 },{authorize,classifyExceptional});}
 catch(e) {
  if(e.code==='EEXIST')throw e; // Another owner is not evidence about its execution.
  // A fresh GitHub/installation check can fail before finish() loads a saved
  // completion. Invalidate that observation under ownership; never replay effects.
  await withControllerLock(c,async()=>{
   const old=await optional(journalFile);
   if(old?.phase==='complete' && old.request===digest(p)) {
    const updated={...old,recheck:{status:'blocked',at:new Date().toISOString(),reason:e instanceof DeploymentError?e.message:'Fresh exceptional check/report failed; inspect private records'}};
    await atomic(journalFile,updated);await observeCompletion(c,updated,p.publication);
    try {await exceptionalReport(c,p,updated,root,{close:false});}catch {} // Durable observation survives reporting failure.
   }
  });
  throw e;
 }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 try {
  const [action,input,response,...extra]=process.argv.slice(2);
  need(!extra.length && ['prepare','show','respond','execute'].includes(action) && input && (action==='respond'?!!response:!response),'Usage: node scripts/exceptional.mjs prepare PLAN | show PREPARED | respond PREPARED RESPONSE | execute PREPARED');
  const file=resolve(input);
  const result=action==='prepare'?await prepareExceptional(file):action==='show'?(await readPrepared(file)).p:action==='respond'?await respondExceptional(file,resolve(response)):await executeExceptional(file);
  writeSync(1,JSON.stringify(result)+'\n');
 } catch(e) {writeSync(2,(e instanceof DeploymentError?e.message:'Exceptional operation failed; preserve original/approval/deployment/completion records; inspect private operator evidence')+'\n');process.exitCode=1;}
}
