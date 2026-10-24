// Operator-installed normal completion only. No candidate commands, crash replay or ledger writes.
import { writeSync } from 'node:fs';
import { readFile, readdir, lstat, realpath, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { config, json, atomic, digest, keyFor, receipt, validation, verifyInstall, github, list, withControllerLock } from './post-pr.mjs';
import { connectedCompletion, deploymentEvidence, deploymentConfig, runtimeOwnersIdle, DeploymentError } from './deploy.mjs';
const require=(v,m)=>{if(!v) throw new DeploymentError(m);};
const optional=async p=>{try{return await json(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const safeReason=e=>e instanceof DeploymentError?e.message:'Completion I/O/auth/evidence check failed; inspect private operator records';
export function finishConfig(c) {
  config(c);
  require(c.authority.finish===true && c.authority.deploy===true && c.authority.retire===true && c.authority.close===true && !c.hold,'Explicit finish/deploy/retire/close authority required');
  require(c.launch && same(c.launch,{v:1,id:c.launchId,repo:c.repo,issue:c.issue,base:c.base,limit:c.iterationLimit}) && /^[a-f0-9]{64}$/.test(c.launchId) && [1,2,3].includes(c.iterationLimit),'Exact launch scope/limit required');
  require(c.finish && same(Object.keys(c.finish).filter(k=>k!=='authBindProof').sort(),['dataVolume','deploymentRoot','drainMs','gateRoot','previous','project','verifyMs'].sort()),'Fixed completion bundle/operation policy required; unknown finish fields forbidden');
  for(const k of ['launchRoot', 'configFile']) require(typeof c[k]==='string' && resolve(c[k])===c[k],'Canonical completion path required: '+k);
  for(const k of ['deploymentRoot','gateRoot']) require(typeof c.finish[k]==='string' && resolve(c.finish[k])===c.finish[k],'Canonical completion root required: '+k);
  require(Number.isInteger(c.finish.drainMs) && c.finish.drainMs>=1 && c.finish.drainMs<=3600000,'Bounded completion drain deadline required');
  deploymentConfig({...c,...c.finish,ownershipVersion:1,current:c.finish.previous,previous:undefined,target:undefined,authority:{observe:true}},{ownership:true});
  return c;
}
async function privatePath(p,directory=false) {
  const s=await lstat(p);
  require((directory?s.isDirectory():s.isFile()) && !s.isSymbolicLink() && !(s.mode&0o022) && await realpath(p)===p && !p.startsWith('/data/workspaces/'),'Completion input must be canonical, private and outside candidate workspaces');
}
// Immutable generated artifacts can be re-read, never overwritten with a new contract.
async function immutable(path,bytes) {
  let f;
  try {f=await open(path,'wx',0o600);}catch(e){if(e.code!=='EEXIST')throw e;await privatePath(path);require(same(await readFile(path),bytes),'Prepared completion artifact changed');return;}
  try {await f.writeFile(bytes);await f.sync();}finally{await f.close();}
  const d=await open(resolve(path,'..'),'r');try{await d.sync();}finally{await d.close();}
}
export async function prepareCompletion(c,io) {
  const intent=await io.launch(), j=await io.host(), ledger=await io.ledger();
  require(intent?.done===true && !intent.blocker && intent.contract===digest(c.launch) && intent.settings===digest(c.configContents) && intent.finishSettings===intent.settings,'Launch did not delegate this exact completion configuration');
  require(ledger?.stage==='await_validation' && ledger.in_flight===false,'Original runner is not released for validation; inspect original ledger before completion recheck');
  let p;
  try {p=receipt(c,ledger);}catch {throw new DeploymentError('Original launch/publication/role receipt failed verification; inspect ledger scope, generation and role settings');}
  require(j?.done===true && !j.blocker && same(j.publication,p) && j.request===digest(p) && j.mergeAttempt?.state==='confirmed' && j.mergeAttempt.sha===j.merged,'Confirmed exact host merge journal required');
  try {validation(c,p,j.validation);}catch {throw new DeploymentError('Original exact-head host validation failed verification; inspect host journal and validation checks');}
  const e=await io.evidence(j,p,ledger);
  require(same(e.ledger,ledger) && same(e.publication,p) && same(e.validation,j.validation) && e.merge===j.merged,'Preserved host evidence differs from original journal/ledger');
  return {j,p,e};
}
// All methods run in one deployment/controller critical section. Test ports mock ONLY external effects.
export async function finish(c,io) {
  await io.authorize();
  let j=await io.load();
  const request=digest(c.configContents);
  require(!j || j.request===request,'Completion configuration changed');
  if(j?.phase==='complete') {
    try {
      await io.verify(false,{status:'absent'});await io.idle(null);
    } catch(e) {
      const drift={...j,recheck:{status:'blocked',reason:safeReason(e),at:new Date().toISOString()},next:'Inspect current runtime/owners; completed effects are never replayed'};
      await io.save(drift);await io.report(drift);throw e;
    }
    const checked={...j,recheck:{status:'passed',at:new Date().toISOString()}};
    await io.save(checked);await io.report(checked);return checked; // No gate, deploy, archive or unlink.
  }
  require(!j,'Partial/blocked completion requires operator recovery; no automatic replay');
  j={v:1,request,phase:'prepared',deploymentId:io.deploymentId,evidence:io.evidence,publication:io.publication,started:new Date().toISOString()};
  const save=async(phase,extra={})=>{j={...j,...extra,phase,updated:new Date().toISOString()};await io.save(j);};
  await save('prepared');
  try {
    await io.idle(c.launch);
    await io.authorize();
    const d=await io.deploy();
    await save('deployment_result',{deploymentPhase:d.phase,target:d.target,previous:d.previous,verification:d.resumedVerification,deploymentReason:d.reason,rollbackVerification:d.rollbackVerification,rollbackReason:d.rollbackReason});
    require(d.phase==='complete','Target deployment failed or rolled back; manifest preserved');
    await io.authorize();
    await save('retirement_pause_intent');await io.gate(true);
    await io.drain();
    await io.verify(true,{status:'present',value:c.launch});
    await io.idle(c.launch);
    await io.authorize();
    await save('retirement_intent');
    const archive=await io.retire(); // preserves/fsyncs exact bytes, then removes ONLY active.json
    await save('retired',{archive});
    await io.idle(null); // actual engine + mount + full owner observation after unlink
    await io.verify(true,{status:'absent'});
    await io.authorize();
    await save('resume_intent');await io.gate(false);
    const verification=await io.verify(false,{status:'absent'});
    await save('complete',{outcome:'complete',verification,next:'Normal completion verified; no successor dispatch'});
    await io.report(j);return j;
  } catch(e) {
    // Never delete on a deployment failure, retry effects, or auto-recover an uncertain resume.
    if(['retirement_pause_intent','retirement_intent','retired','resume_intent'].includes(j.phase)) {await io.authorize();await io.gate(true);}
    if(j.phase!=='complete') await save('blocked',{outcome:j.deploymentPhase && j.deploymentPhase!=='complete'?'deployment_failed':'completion_blocked',reason:safeReason(e),next:'Inspect completion/deployment journal, actual engine and exact manifest; preserve originals; operator recovery required'});
    await io.report(j);throw e;
  }
}
// Shared by the isolated harness; production still uses only the fixed GitHub connection.
export function completionPorts(c,request,ports,{journalFile,authorize,report,publication}) {
  const dir=resolve(journalFile,'..'),target=request.target,previous=request.previous,deploymentId=request.deploymentId;
  const auth=async()=>{await authorize();await ports.authorize();};
  const idle=async manifest=>{
    await auth();
    const existing=await optional(join(request.deploymentRoot,deploymentId,'journal.json'));
    const bundle=existing?.phase==='complete'?target:previous;
    await ports.files(bundle);await ports.match(bundle);
    const s=await ports.state(),o=await ports.observeOwners();
    if(request.completionOwner) {
      const owner=o.rows.filter(x=>x.file===request.completionOwner.file);
      require(owner.length===1 && digest(Buffer.from(owner[0].bytes,'base64'))===request.completionOwner.ledgerHash && owner[0].enrollment!==null && digest(Buffer.from(owner[0].enrollment,'base64'))===request.completionOwner.enrollmentHash,'Live completion ledger/enrollment differs from original launch owner');
    }
    require(runtimeOwnersIdle(s) && same(o.manifest,manifest) && await ports.ownersIdle(),'Active/unknown owner or different manifest; completion forbidden');
    require(same(s.momoflow_launch?.manifest,manifest?{status:'present',value:manifest}:{status:'absent'}),'Engine-visible manifest mismatch');
  };
  return {
    authorize:auth,load:()=>optional(journalFile),save:x=>atomic(journalFile,x),deploymentId,evidence:request.evidence,publication,
    deploy:ports.execute,gate:ports.gate,idle,
    drain:async()=>{const end=Date.now()+request.drainMs;while(true){await auth();const s=await ports.state();if(s.admission?.paused===true && s.admission.generation===deploymentId && runtimeOwnersIdle(s) && await ports.ownersIdle())return;require(Date.now()<end,'Retirement drain timeout; manifest preserved');await ports.sleep();}},
    verify:(paused,m)=>ports.verify(target,paused,m),
    retire:async()=>{
      const path=join(c.launchRoot,'active.json');await privatePath(path);
      const bytes=await readFile(path);require(same(JSON.parse(bytes),c.launch),'Exact manifest required');
      const archive=join(dir,`completed-manifest-${deploymentId}.json`);await immutable(archive,bytes);
      await idle(c.launch);await auth();require(same(await readFile(path),bytes),'Manifest changed before retirement');
      await rm(path);const d=await open(c.launchRoot,'r');try{await d.sync();}finally{await d.close();}
      return {path:archive,hash:digest(bytes)};
    },report
  };
}
async function workpad(c,j) {
  const api=github(c),path=`/repos/${c.repo}/issues/${c.issue}/comments`;
  const pads=(await list(api,path)).filter(x=>x.body?.includes('<!-- momoflow:workpad -->'));
  require(pads.length===1,'Exactly one completion workpad required');
  const start='<!-- momoflow:finish:start -->',end='<!-- momoflow:finish:end -->';
  const text=`${start}\n**사람에게 필요한 행동:** ${j.phase==='complete' && j.recheck?.status!=='blocked'?'없음':'운영자가 고정 설정·정확한 head·journal을 확인하고 제외 변경의 별도 배포 또는 복구를 판단; 같은 workpad에 결과 기록'}\n\n운영 마무리: ${j.phase}${j.recheck?.status==='blocked'?' (현재 재검사 차단)':''}. 배포 ${j.deploymentId || '미준비'}, 근거 ${j.evidence?.hash || '미준비'}.\n배포 결과 ${j.deploymentPhase || '미실행'}; 복구 ${j.deploymentPhase==='rolled_back'?'검증 완료':j.rollbackReason?'실패':'배포 journal 확인'}.\n대상 ${j.target?.commit || '미준비'} / ${j.target?.image || '미준비'}, head ${j.publication?.head || '미준비'}, tree ${j.publication?.tree || '미준비'}.\n${j.reason || j.recheck?.reason || ''}\n다음 행동: ${j.recheck?.next || j.next || '고정 설정으로 배포 및 exact manifest 정리'}\n${end}`;
  const old=pads[0].body,i=old.indexOf(start),k=old.indexOf(end);
  require((i<0&&k<0)||(i>=0&&k>i),'Malformed completion workpad section');
  const body=i<0?old.replace('<!-- momoflow:workpad -->','<!-- momoflow:workpad -->\n\n'+text):old.slice(0,i)+text+old.slice(k+end.length);
  if(body!==old) await api('PATCH',`/repos/${c.repo}/issues/comments/${pads[0].id}`,{body});
  if(j.phase==='blocked' || j.phase==='excluded' || j.recheck?.status==='blocked') {
    const labels=`/repos/${c.repo}/issues/${c.issue}/labels`;
    if((await list(api,labels)).some(x=>x.name==='momoflow:ready'))await api('DELETE',labels+'/momoflow%3Aready');
    require(!(await list(api,labels)).some(x=>x.name==='momoflow:ready'),'Completion ready removal not confirmed');
    for(const n of new Set([c.issue,...(j.publication?.pr?[String(j.publication.pr)]:[])]))await api('POST',`/repos/${c.repo}/issues/${n}/labels`,{labels:['momoflow:needs-decision']});
  }
  if(j.phase==='complete' && j.recheck?.status!=='blocked') {
    const issuePath=`/repos/${c.repo}/issues/${c.issue}`,issue=await api('GET',issuePath);
    if(issue.state!=='closed') await api('PATCH',issuePath,{state:'closed',state_reason:'completed'});
    require((await api('GET',issuePath)).state==='closed','Completion issue close not confirmed');
  }
}
export async function finishConnected(c) {
  config(c);await verifyInstall(c);
  require(!c.trustedRoot.startsWith('/data/workspaces/'),'Completion controller must be independently installed');
  const dir=join(c.stateRoot,keyFor(c)), journalFile=join(dir,'completion.json');
  await privatePath(c.configFile);
  for(const p of [c.stateRoot,c.inboxRoot,c.launchRoot,dir]) await privatePath(p,true);
  const authorize=async()=>require(same(await json(c.configFile),c.configContents),'Operator completion configuration changed');
  await authorize();
  let prepared={};
  try {
    const preparedRequest=await withControllerLock(c,async()=>{
    finishConfig(c);await privatePath(c.finish.gateRoot,true);
    const {j,p,e}=await prepareCompletion(c,{
      launch:()=>json(join(dir,'launch.json')),host:()=>json(join(dir,'journal.json')),ledger:()=>json(join(c.ledgerRoot,keyFor(c)+'.json')),
      evidence:async(j,p,ledger)=>{
        // PR mutable fields may differ: locate by preserved stable identity, never synthesize a receipt.
        const matches=[];
        for(const name of await readdir(dir)) if(/^evidence-[a-f0-9]{64}\.json$/.test(name)) {
          const x=await json(join(dir,name));if(x.merge===j.merged && same(x.publication,p)) {require(name===`evidence-${digest(x)}.json`,'Evidence filename mismatch');matches.push(x);}
        }
        require(matches.length===1,'Unique preserved merge evidence required');return matches[0];}
    });
    const ledgerFile=join(c.ledgerRoot,keyFor(c)+'.json'),enrolledFile=ledgerFile+'.enrolled';
    await privatePath(ledgerFile);await privatePath(enrolledFile);
    const ledgerBytes=await readFile(ledgerFile),enrollmentBytes=await readFile(enrolledFile);
    require(same(JSON.parse(ledgerBytes),e.ledger) && same(JSON.parse(enrollmentBytes),c.launch),'Original launch ledger/enrollment changed');
    const completionOwner={file:keyFor(c)+'.json',ledgerHash:digest(ledgerBytes),enrollmentHash:digest(enrollmentBytes)};
    const previous=c.finish.previous, image=j.validation.image;
    const deploymentId=digest({launch:c.launch,settings:digest(c.configContents),publication:p,merge:j.merged,image});
    const composeFile=join(dir,`finish-compose-${deploymentId}.json`);
    const doc=await json(previous.composeFile);require(digest(await readFile(previous.composeFile))===previous.composeHash,'Previous Compose changed');
    doc.services.symphony.image=image;
    const bytes=Buffer.from(JSON.stringify(doc,null,2));await immutable(composeFile,bytes);
    const target={...previous,commit:j.merged,image,composeFile,composeHash:digest(bytes),files:{...previous.files,[composeFile]:digest(bytes)},inspect:{...previous.inspect,symphony:{...previous.inspect.symphony,image}}};
    delete target.files[previous.composeFile];
    const evidencePath=join(dir,`evidence-${digest(e)}.json`);
    const request={...c.finish,repo:c.repo,issue:c.issue,base:c.base,authority:{deploy:true},hold:false,compatibility:'unchanged-data',exceptional:false,
      trustedRoot:c.trustedRoot,controllerVersion:c.controllerVersion,validationOrigin:c.controllerVersion,stateRoot:c.stateRoot,inboxRoot:c.inboxRoot,ledgerRoot:c.ledgerRoot,tokenFile:c.tokenFile,launchRoot:c.launchRoot,engineURL:c.engineURL,
      requiredChecks:c.requiredChecks,requiredReviewers:c.requiredReviewers,...(c.operatorContainer?{operatorContainer:c.operatorContainer}:{}),...(c.dockerConfig?{dockerConfig:c.dockerConfig}:{}),
      deploymentId,completionOwner,target,manifest:{status:'present',value:c.launch},evidence:{path:evidencePath,hash:digest(e)}};
    prepared={deploymentId,evidence:request.evidence,target:{commit:target.commit,image:target.image,runnerSource:target.runnerSource},publication:p};
    deploymentConfig(request);
    // Fresh exact GitHub gate BEFORE deployment connection or pause/backup/replace effects.
    await deploymentEvidence(request,e,github(c),h=>readFile(join(dir,'logs',h)));
    const requestFile=join(dir,`finish-request-${deploymentId}.json`);await immutable(requestFile,Buffer.from(JSON.stringify(request,null,2)));
    return {request,requestFile,publication:p};
    }); // Preparation lock is returned before deployment acquires deployment.lock → controller.lock.
    const {request,requestFile,publication}=preparedRequest;
    return await connectedCompletion(request,requestFile,ports=>finish(c,completionPorts(c,request,ports,{journalFile,authorize,publication,report:async x=>{await authorize();return workpad(c,x);}})));

  } catch(e) {
    if(e.code==='EEXIST')throw new DeploymentError('Controller/deployment ownership held; defer completion without replay');
    await authorize();
    // Preparation and connected preflight can fail before finish() rechecks a completed run.
    // Reacquire ownership before updating its single record; never rewrite completed effects.
    await withControllerLock(c,async()=>{
      await authorize();
      const old=await optional(journalFile);
      require(!old || old.request===digest(c.configContents),'Completion configuration changed');
      if(old?.phase==='complete') {
        const blocked={...old,recheck:{status:'blocked',reason:safeReason(e),at:new Date().toISOString(),next:'Inspect original launch/host/ledger evidence and current runtime; completed effects are never replayed'}};
        await atomic(journalFile,blocked);await workpad(c,blocked);
      } else if(!old) {
        const blocked={...prepared,request:digest(c.configContents),phase:e instanceof DeploymentError && e.message.includes('separate exceptional deployment')?'excluded':'blocked',outcome:'excluded_or_invalid',reason:safeReason(e),next:'Inspect prepared host evidence and operator authority; no deployment or manifest replay'};
        await atomic(journalFile,blocked);await workpad(c,blocked);
      }
    });
    throw e;
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    require(process.argv.length===3,'Usage: node scripts/finish.mjs /operator/launch.json');
    const file=resolve(process.argv[2]),contents=await json(file);
    const c={...contents,configFile:file,configContents:contents,launch:{v:1,id:contents.launchId,repo:contents.repo,issue:contents.issue,base:contents.base,limit:contents.iterationLimit}};
    const result=await finishConnected(c);writeSync(1,JSON.stringify({phase:result.phase,deploymentId:result.deploymentId})+'\n');
  } catch(e) {writeSync(2,safeReason(e)+'\n');process.exitCode=1;}
}
