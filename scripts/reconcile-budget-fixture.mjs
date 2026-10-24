// Credential-free file fixtures. GitHub, Docker, session metadata and worker effects are simulated.
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from './post-pr-fixture.mjs';
import {atomic,digest,keyFor,withControllerLock} from './post-pr.mjs';
import {runtimeIdentity} from './deploy.mjs';
import {reconcileExternal} from './reconcile-external.mjs';
import {prepareReconciliation} from './prepare-reconciliation.mjs';
import {budgetEvidenceNames,budgetChecks} from './reconcile-budget.mjs';
const h=n=>String(n).repeat(64),sha=n=>String(n).repeat(40);
export async function budgetFixture() {
 const root=await mkdtemp('/tmp/budget-reconcile-');
 const c={...fixture().c,profile:'controller-budget-exhausted-v4',pr:21,head:sha(1),tree:sha(2),merge:sha(3),originalIterations:3,originalLimit:3,externalIterations:2,recoveryIterations:1,installation:{issue:'36',pr:37,head:sha(6),tree:sha(7),merge:sha(8)},controllerVersion:sha(8),controllerTree:sha(7),engineContainer:h(1),engineImage:'sha256:'+h(2),productionProject:'prod',dataVolume:'live-data',runnerSource:digest('old runner source')};
 c.authority={...c.authority,reconcile:true,externalBudget:true};
 for(const k of ['stateRoot','ledgerRoot','launchRoot','gateRoot','inboxRoot','trustedRoot']){c[k]=join(root,k);await mkdir(c[k]);}
 const evidenceDir=join(root,'sources');await mkdir(evidenceDir);
 c.tokenFile=join(root,'token.json');await atomic(c.tokenFile,{token:'simulated-test-token',expires_at:new Date(Date.now()+3600000).toISOString()});
 const dir=join(c.stateRoot,keyFor(c));await mkdir(dir);
 const manifest={v:1,id:h(4),repo:c.repo,issue:c.issue,base:c.base,limit:3},gate={v:1,generation:h(5),paused:false};
 const snapshot={head:sha(0),diff_sha256:h(0)};
 const ledger={issue:c.issue,launch:Object.fromEntries(Object.entries(manifest).sort()),iterations:3,in_flight:false,active_session:null,publication:null,stage:'blocked',reason:'Shared iteration budget exhausted',events:[{role:'review',iteration:3,before:snapshot,after:snapshot,result:{status:'changes_requested'},session:{session_id:'original-review-turn',thread_id:'original-review',turn_id:'original-turn',result:'turn_completed',effective_settings:{model:'gpt-6-astra',reasoningEffort:'high',serviceTier:'default'}}}]};
 const sources={},paths={},values={ledger,enrollment:ledger.launch,manifest,gate,launchJournal:{contract:digest(manifest),dispatched:true,observed:true,blocker:'Terminal/interrupted ledger requires recovery'}};
 const originalPaths={ledger:join(c.ledgerRoot,keyFor(c)+'.json'),enrollment:join(c.ledgerRoot,keyFor(c)+'.json.enrolled'),manifest:join(c.launchRoot,'active.json'),gate:join(c.gateRoot,'active.json'),launchJournal:join(dir,'launch.json'),controllerJournal:join(dir,'journal.json')};
 const pin=async(name,value)=>{
  const path=paths[name]||originalPaths[name]||join(evidenceDir,name+'.json');paths[name]=path;
  if(value===null){sources[name]={path,hash:null};return;}
  const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));
  await writeFile(path,bytes,{mode:0o600});sources[name]={path,hash:digest(bytes)};
 };
 for(const [name,value] of Object.entries(values))await pin(name,value);await pin('controllerJournal',null);
 await pin('originalIndex',Object.fromEntries(Object.keys(originalPaths).map(n=>[n,{source:sources[n].path,hash:sources[n].hash}])));
 await pin('authorization',{source:'explicit-user-reply',at:new Date(90000).toISOString(),userRequest:'one correction and one recovery approved',ownerIssue:1,ownerPr:21,originalUsed:3,originalLimit:3,externalAlreadyUsed:1,additionalCorrectionLimit:1,externalCorrectionTotalLimit:2,separateRecoveryImplementationLimit:1});
 await pin('recoveryAuthorization',{source:'explicit-user-request',at:new Date(280000).toISOString(),userRequest:'one correction and one recovery approved',issue:36,ownerIssue:1,ownerPr:21,implementationLimit:1,sourceAuthorization:sources.authorization.path,originalOwnerUsage:{originalUsed:3,originalLimit:3,externalPreviouslyUsed:1,externalApprovedTotal:2}});
 const startedAt=new Date(300000).toISOString();
 await pin('invocation',{issue:36,execution:'external',implementationUsed:1,implementationLimit:1,base:c.head,startedAt,ownerUsage:{originalUsed:3,originalLimit:3,externalCorrectionUsed:2,externalCorrectionLimit:2}});
 const session={id:'same-sol-session',actualModel:'gpt-6.1-sol',actualReasoning:'medium',service_tier:null,fastOffPolicy:true,fastOffRuntimeProven:false,settingsChanged:false};
 const turns={owner:{build:'owner-build',review:'owner-review'},recovery:{build:'recovery-build',review:'recovery-review'}};
 for(const [prefix,t,time] of [['owner',c,100],['recovery',c.installation,300]]) {
  await pin(prefix==='owner'?'correction':'recoveryBuild',{frozen:true,baseHead:c.head,session,budget:{originalUsed:3,originalLimit:3,externalCorrectionUsed:2,externalCorrectionLimit:2,separateRecoveryUsed:prefix==='owner'?0:1},...(prefix==='recovery'?{invocation:{issue:36,startedAt}}:{}),files:{'sample.txt':digest(prefix)}});
  await pin(prefix==='owner'?'review':'recoveryReview',{repo:c.repo,issue:t.issue,pr:t.pr,head:t.head,tree:t.tree,status:'approved',model:'gpt-6-astra',reasoning:'high',service_tier:null,fastOffPolicy:true,fastOffRuntimeProven:false,session:'same-astra-session',buildSession:session.id,findings:[]});
  for(const [role,model,effort,id,name,at] of [['build','gpt-6.1-sol','medium',session.id,prefix==='owner'?'buildNative':'recoveryBuildNative',time],['review','gpt-6-astra','high','same-astra-session',prefix==='owner'?'reviewNative':'recoveryReviewNative',time+50]]) {
   await pin(name,Buffer.from([{type:'session_meta',payload:{id}},{type:'turn_context',payload:{turn_id:turns[prefix][role],model,effort}},{type:'event_msg',payload:{type:'task_complete',turn_id:turns[prefix][role],started_at:at,completed_at:at+10,last_agent_message:'approved '+t.head.slice(0,8)}}].map(x=>JSON.stringify(x)).join('\n')));
  }
  const p={repo:c.repo,issue:t.issue,base:c.base,base_head:sha(0),head:t.head,tree:t.tree};
  const checks=[];
  for(const name of budgetChecks){const value=Buffer.from(name==='contracts'?'simulated external role output\n125 tests, 0 failures':name==='node'?'simulated external Node output\n# tests 613\n# pass 613\n# fail 0\n# skipped 0':prefix+' simulated '+name);await pin(`${prefix}Log_${name}`,value);checks.push({name,exit:0,log:digest(value),...(['contracts','node'].includes(name)?{tests:name==='contracts'?125:613,failures:0}:{})});}
  await pin(prefix==='owner'?'testRequest':'recoveryTestRequest',p);
  await pin(prefix==='owner'?'tests':'recoveryTests',{origin:sha(9),request:digest(p),head:t.head,tree:t.tree,image:'sha256:'+h(6),tests:738,kind:'passed',checks});
 }
 await pin('actionResolution',{kind:'operator-action-resolution-v4',actor:'external-operator',authority:'existing-scope',repo:c.repo,owner:{issue:c.issue,pr:c.pr,head:c.head,tree:c.tree,merge:c.merge},installation:c.installation,authorizationHash:sources.authorization.hash,remainingObservation:'natural-observation-pending',at:new Date(400000).toISOString(),labels:[{issue:c.issue,name:'momoflow:needs-decision'}]});
 await pin('previousRunner',Buffer.from('old runner source'));
 const bundleDir=join(root,'bundle');await mkdir(bundleDir);const composeFile=join(bundleDir,'compose.json'),workflow=join(bundleDir,'WORKFLOW.md'),profile=join(bundleDir,'seccomp.json');
 const doc={services:{symphony:{image:c.engineImage,volumes:[{type:'bind',source:workflow,target:'/config/WORKFLOW.md',read_only:true}],security_opt:['seccomp='+profile]},'github-auth':{image:'sha256:'+h(9)}}};
 await atomic(composeFile,doc);await writeFile(workflow,'simulated workflow');await atomic(profile,{defaultAction:'SCMP_ACT_ERRNO',syscalls:[]});
 const liveData=join(root,'data'),liveAuth=join(root,'auth'),key=join(root,'key.pem');await mkdir(liveData);await mkdir(liveAuth);await writeFile(key,'SIMULATED NOT A KEY');
 const mount=(Source,Destination,RW=false,Type='bind',Name)=>({Type,Source,Destination,RW,...(Name?{Name}:{})});
 const raw=(id,image,service,mounts)=>({Id:id,Image:image,State:{Running:true,Health:{Status:'healthy'}},Config:{User:service==='symphony'?'momo':'1000:1000',Entrypoint:null,Cmd:['simulated'],Env:[],Labels:{'com.docker.compose.project':'prod','com.docker.compose.service':service}},HostConfig:{Privileged:false,CapAdd:null,CapDrop:['ALL'],SecurityOpt:['no-new-privileges','seccomp={"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}'],NetworkMode:'prod_default',ReadonlyRootfs:service==='github-auth',PortBindings:service==='symphony'?{'4000/tcp':[{HostIp:'127.0.0.1',HostPort:'4000'}]}:{}},Mounts:mounts});
 const all={symphony:raw(c.engineContainer,c.engineImage,'symphony',[mount(liveData,'/data',true,'volume',c.dataVolume),mount(workflow,'/config/WORKFLOW.md'),mount(c.launchRoot,'/run/momoflow-launch'),mount(c.inboxRoot,'/run/momoflow-resume'),mount(c.gateRoot,'/run/momoflow-admission'),mount(liveAuth,'/run/momoflow-auth',false,'volume','live-auth')]),'github-auth':raw(h(9),'sha256:'+h(9),'github-auth',[mount(liveAuth,'/run/momoflow-auth',true,'volume','live-auth'),mount(key,'/run/secrets/github-app.pem')])};
 const files={};for(const path of [composeFile,workflow,profile])files[path]=digest(await readFile(path));
 const request={ownershipVersion:1,authority:{observe:true},hold:false,repo:c.repo,issue:c.issue,base:c.base,controllerVersion:c.controllerVersion,project:'prod',dataVolume:c.dataVolume,engineURL:c.engineURL,verifyMs:1000,current:{commit:sha(0),image:c.engineImage,authImage:all['github-auth'].Image,runnerSource:c.runnerSource,composeHash:files[composeFile],composeFile,files,inspect:Object.fromEntries(Object.entries(all).map(([k,v])=>[k,runtimeIdentity(v)]))},manifest:{status:'present',value:manifest}};
 for(const k of ['stateRoot','inboxRoot','launchRoot','gateRoot','trustedRoot','ledgerRoot','tokenFile'])request[k]=c[k];
 await pin('ownershipRequest',request);
 const serviceEvidence={kernel:(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),services:Object.entries(all).map(([service,x])=>{const r=runtimeIdentity(x);return {service,id:x.Id,image:x.Image,runtimeHash:digest({...r,mounts:r.mounts.map(m=>m.type==='bind'?{...m,source:null}:m)}),mountHashes:x.Mounts.map(m=>({type:m.Type,destination:m.Destination,rw:m.RW,identityHash:digest(m.Source)})).sort((a,b)=>a.destination.localeCompare(b.destination))};})};
 await pin('ownership',{kind:'deployment-ownership-v1',effects:'none',repo:c.repo,base:c.base,project:'prod',controllerVersion:c.controllerVersion,engine:c.engineContainer,engineImage:c.engineImage,dataVolume:c.dataVolume,sourceRequest:sources.ownershipRequest,runtimeIdle:true,controllerLock:false,manifestContract:digest(manifest),ledgerHashes:[{file:keyFor(c)+'.json',ledgerHash:sources.ledger.hash,enrollmentHash:sources.enrollment.hash}],serviceEvidence});
 const calls=[],api=async(method,path)=>{
  calls.push({method,path});if(method!=='GET')throw Error('Unexpected remote mutation');
  for(const t of [c,c.installation]){
   if(path.endsWith('/issues/'+t.issue))return {state:'open',number:Number(t.issue),labels:t===c?[{name:'momoflow:needs-decision'}]:[]};
   if(path.endsWith('/pulls/'+t.pr))return {state:'closed',merged:true,merge_commit_sha:t.merge,head:{sha:t.head,repo:{full_name:c.repo}},base:{ref:c.base,sha:sha(0),repo:{full_name:c.repo}}};
   if([t.head,t.merge].some(s=>path.endsWith('/git/commits/'+s)))return {tree:{sha:t.tree},parents:[{sha:t===c?sha(0):c.merge},{sha:t.head}]};
  }
  if(path.includes('/contents/engine/role_runner.ex?ref='))return {encoding:'base64',content:Buffer.from('old runner source').toString('base64')};
  if(path.includes('/contents/sample.txt?ref='))return {encoding:'base64',content:Buffer.from(path.endsWith(c.head)?'owner':'recovery').toString('base64')};
  if(path.includes('issues?'))return [];throw Error('Unexpected API '+path);
 };
 const seen={commit:c.controllerVersion,tree:c.controllerTree,runnerSource:digest(await readFile(new URL('../engine/role_runner.ex',import.meta.url)))};
 const inputFile=join(root,'typed-input.json'),out=join(root,'prepared');
 const input={kind:'normal-exhaustion-preparation-v4',config:c,sources,turns,validationOrigins:{owner:sha(9),recovery:sha(9)}};
 const saveInput=()=>atomic(inputFile,input);
 const prepare=async()=>{await saveInput();return prepareReconciliation(inputFile,out,{api,installed:async()=>seen});};
 const prepared=await prepare(),configFile=prepared.request,configBytes=await readFile(configFile),config={...JSON.parse(configBytes),configFile,configurationHash:digest(configBytes)};
 const io={api,authorize:async()=>{},installedController:async()=>({commit:seen.commit,tree:seen.tree}),ownership:async()=>JSON.parse(await readFile(paths.ownership)),workers:async()=>true,engine:async()=>{
  const gate=JSON.parse(await readFile(paths.gate));let active=null;try{active=JSON.parse(await readFile(paths.manifest));}catch(e){if(e.code!=='ENOENT')throw e;}
  return {running:[],retrying:[],admission:{contract:1,configured:true,generation:gate.generation,paused:gate.paused,pending_dispatch:false,running:[],retrying:[],claimed:[],blocked:[]},momoflow_launch:{contract:1,repo:c.repo,source:c.runnerSource,concurrency:1,role_flow:true,launch_read_only:true,inbox_read_only:true,launch_root:'/run/momoflow-launch',inbox_root:'/run/momoflow-resume',manifest:active?{status:'present',value:active}:{status:'absent'}}};
 },ack:async()=>{}};
 return {root,c:config,input,inputFile,out,prepared,prepare,saveInput,sources,paths,dir,ledger,manifest,gate,io,seen,all,calls,pin,run:o=>withControllerLock(config,()=>reconcileExternal(config,io,o)),clean:()=>rm(root,{recursive:true,force:true})};
}
