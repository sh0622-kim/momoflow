// Local contracts: fake external effects, real deployment state machine. No Docker/auth/model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deploy, deploymentConfig, drained, activeContract, deploymentEvidence, DeploymentError, safeRuntime, withDeploymentLock, controllersIdle } from './deploy.mjs';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { withControllerLock } from './post-pr.mjs';
import { digest } from './post-pr.mjs';
import { fixture as controllerFixture } from './post-pr-fixture.mjs';
const h=n=>String(n).repeat(64), sha=n=>String(n).repeat(40);
function fixture() {
  const bundle=n=>({commit:sha(n),image:'sha256:'+h(n),authImage:'sha256:'+h(9),runnerSource:h(n),composeFile:`/operator/${n}/compose.json`,composeHash:h(n),files:{[`/operator/${n}/compose.json`]:h(n)},inspect:{symphony:{},'github-auth':{}}});
  const c={repo:'fixture/repo',issue:'1',base:'main',deploymentId:h(4),authority:{deploy:true},hold:false,compatibility:'unchanged-data',exceptional:false,project:'isolated-test',dataVolume:'test-data',controllerVersion:sha(1),validationOrigin:sha(1),target:bundle(2),previous:bundle(1),manifest:{status:'absent'},evidence:{path:'/operator/evidence.json',hash:h(3)},drainMs:3,verifyMs:3,engineURL:'http://127.0.0.1:4000',...Object.fromEntries(['stateRoot','deploymentRoot','gateRoot','trustedRoot','tokenFile','inboxRoot','ledgerRoot'].map(k=>[k,'/operator/'+k]))};
  let journal=null,time=0,paused=false,actual=c.previous, active=false,owned=false;
  const calls=[];
  const io={load:async()=>structuredClone(journal),save:async j=>{journal=structuredClone(j);calls.push('save:'+j.phase);},authorize:async()=>{calls.push('authorize');},preflight:async()=>{calls.push('preflight');},
    now:()=>time,sleep:async()=>{time++;},gate:async p=>{paused=p;calls.push('gate:'+p);},
    state:async()=>({admission:{contract:1,configured:true,paused,generation:c.deploymentId,running:active?['1']:[],retrying:[],claimed:[],blocked:[],pending_dispatch:false}}),
    ownersIdle:async()=>!owned,backup:async()=>{calls.push('backup');},preReplace:async()=>{calls.push('preReplace');},
    replace:async b=>{calls.push('replace:'+b.commit);actual=b;},verify:async(b,p)=>{calls.push('verify:'+b.commit+':'+p);assert.equal(paused,p);assert.equal(actual,b);},
    observe:async()=>{calls.push('observe');return {image:actual.image};},report:async()=>{calls.push('report');}};
  return {c,io,calls,get journal(){return journal;},set journal(x){journal=x;},get paused(){return paused;},set active(x){active=x;},set owned(x){owned=x;}};
}
test('deployment preflight has no lock/journal/gate/remote writes',async()=>{
 const f=fixture(); assert.equal((await deploy(f.c,f.io,{preflight:true})).prepared,true);assert.deepEqual(f.calls,['authorize','preflight']);assert.equal(f.journal,null);
});
test('deployment success persists intent before each effect and duplicate only verifies/reports',async()=>{
 const f=fixture(); assert.equal((await deploy(f.c,f.io)).phase,'complete');
 for(const [intent,effect] of [['pause_intent','gate:true'],['backup_intent','backup'],['replace_intent','replace:'+f.c.target.commit],['verify_intent','verify:'+f.c.target.commit+':true'],['resume_intent','gate:false']]) assert.ok(f.calls.indexOf('save:'+intent)<f.calls.indexOf(effect));
 assert.equal(f.paused,false);await deploy(f.c,f.io);assert.equal(f.calls.filter(x=>x.startsWith('replace:')).length,1);assert.ok(f.calls.includes('observe'));
});
for(const kind of ['running','retrying','claimed','blocked','pending_dispatch','controller']) test(`deployment defers ${kind} without stopping work`,async()=>{
 const f=fixture();if(kind==='controller') f.owned=true;else {const orig=f.io.state;f.io.state=async()=>{const s=await orig();s.admission[kind]=kind==='pending_dispatch'?true:['busy'];return s;};}
 assert.equal((await deploy(f.c,f.io)).phase,'deferred');assert.equal(f.paused,true);assert.ok(!f.calls.includes('backup'));assert.ok(!f.calls.some(x=>x.startsWith('replace:')));
});
test('deployment waits for active work and then replaces at a proven idle boundary',async()=>{
 const f=fixture();f.active=true;f.io.sleep=async()=>{f.active=false;};assert.equal((await deploy(f.c,f.io)).phase,'complete');
});
for(const kind of ['replace','verify']) test(`deployment ${kind} failure restores and verifies previous bundle before resume`,async()=>{
 const f=fixture(),orig=f.io[kind];f.io[kind]=async b=>{if(b===f.c.target)throw Error('candidate failure');return orig(b,true);};
 if(kind==='verify') f.io.verify=async(b,p)=>{if(b===f.c.target)throw Error('candidate failure');return orig(b,p);};
 assert.equal((await deploy(f.c,f.io)).phase,'rolled_back');assert.equal(f.paused,false);assert.ok(f.calls.includes('verify:'+f.c.previous.commit+':true'));
});
test('failed rollback holds admission and records a concrete next action',async()=>{
 const f=fixture();f.io.replace=async()=>{throw new DeploymentError('Docker unavailable');};assert.equal((await deploy(f.c,f.io)).phase,'blocked');assert.equal(f.paused,true);assert.match(f.journal.rollbackReason,/unavailable/);assert.match(f.journal.next,/Do not reset ledgers/);
});
test('owner race at final boundary never replaces',async()=>{
 const f=fixture();f.io.preReplace=async()=>{f.active=true;};assert.equal((await deploy(f.c,f.io)).phase,'deferred');assert.ok(!f.calls.some(x=>x.startsWith('replace:')));
});
test('uncertain resume never kills a newly started worker to roll back',async()=>{
 const f=fixture(),orig=f.io.gate;f.io.gate=async p=>{await orig(p);if(!p){f.active=true;throw Error('lost resume response');}};
 assert.equal((await deploy(f.c,f.io)).phase,'blocked');assert.equal(f.paused,true);assert.equal(f.calls.filter(x=>x.startsWith('replace:')).length,1);assert.match(f.journal.rollbackReason,/rollback deferred/);
});
for(const phase of ['intent','pause_intent','draining','backup_intent','preserved','replace_intent','verify_intent','verified','resume_intent','failure','rollback_intent','rollback_verify_intent','rollback_verified','rollback_resume_intent','deferred','blocked']) test(`restart at ${phase} re-queries and holds; does not replay`,async()=>{
 const f=fixture();f.journal={request:digest(f.c),phase,events:[]};await assert.rejects(deploy(f.c,f.io),/operator recovery/i);assert.equal(f.paused,true);assert.ok(f.calls.includes('observe'));assert.ok(!f.calls.some(x=>x.startsWith('replace:')));
});
test('lost reporting response retries only reporting and verification',async()=>{
 const f=fixture();f.io.report=async()=>{throw Error('GitHub offline');};await assert.rejects(deploy(f.c,f.io),/offline/);assert.equal(f.journal.phase,'complete');f.io.report=async()=>{};await deploy(f.c,f.io);assert.equal(f.calls.filter(x=>x.startsWith('replace:')).length,1);
});
for(const mutate of [c=>{c.authority.deploy=false;},c=>{c.hold=true;},c=>{c.compatibility='migration';},c=>{c.exceptional=true;},c=>{c.target.image='latest';},c=>{c.target.authImage='sha256:'+h(8);},c=>{c.target.composeHash=h(6);},c=>{c.drainMs=Infinity;}]) test('invalid authority/image/config/compatibility/deadline fails before effects',async()=>{
 const f=fixture();mutate(f.c);await assert.rejects(deploy(f.c,f.io));assert.equal(f.calls.length,0);
});
test('deployment ID cannot adopt another request',async()=>{
 const f=fixture();f.journal={phase:'complete',request:h(8)};await assert.rejects(deploy(f.c,f.io),/reused/);assert.ok(!f.calls.some(x=>x.startsWith('replace:')));
});
test('admission ack rejects unsupported, malformed and mismatched states',()=>{
 for(const a of [undefined,{}, {contract:1,configured:true,paused:true,generation:h(3)}, {contract:1,configured:true,paused:true,generation:h(4),running:[],retrying:[],claimed:[],blocked:[]}]) assert.throws(()=>drained({admission:a},h(4)));
});
function evidenceFixture() {
 const f=controllerFixture();f.merged=true;
 f.result.checks.find(x=>x.name==='contracts').tests=87;f.result.checks.find(x=>x.name==='node').tests=126;f.result.tests=213;
 for(const row of f.result.checks) row.log=digest('log');
 f.responses.set('GET /repos/fixture/repo/pulls/2/files?per_page=100',[{filename:'app.js'}]);
 const e={ledger:f.ledger,publication:f.p,validation:f.result,merge:sha('f')};
 const c={...f.c,validationOrigin:f.c.controllerVersion,target:{commit:e.merge,image:f.result.image,runnerSource:digest('source')},evidence:{hash:digest(e)}};
 f.responses.set(`GET /repos/fixture/repo/contents/engine/role_runner.ex?ref=${e.merge}`,{encoding:'base64',content:Buffer.from('source').toString('base64')});
 f.responses.set(`GET /repos/fixture/repo/git/commits/${e.merge}`,{tree:{sha:f.p.tree},parents:[{sha:f.p.base_head},{sha:f.p.head}]});
 return {f,c,e};
}
test('deployment binds trusted role receipt, exact merge tree/parents, tests, logs and actual tested image',async()=>{
 const {f,c,e}=evidenceFixture();assert.equal((await deploymentEvidence(c,e,f.io.api,async()=>Buffer.from('log'))).image,f.result.image);
});
for(const [name,change] of [
 ['merge',({c})=>{c.target.commit=sha(2);}],['image',({c})=>{c.target.image='sha256:'+h(2);}],
 ['review',({e})=>{e.ledger.events[0].session.effective_settings.model='wrong';}],
 ['baseline',({e})=>{e.validation.checks.find(x=>x.name==='node').tests=125;e.validation.tests=212;}],
 ['failed exact check',({f})=>{f.responses.set(`GET /repos/fixture/repo/commits/${f.p.head}/check-runs?per_page=100`,{total_count:1,check_runs:[{name:'ci',head_sha:f.p.head,app:{id:42},status:'completed',conclusion:'failure'}]});}],
 ['merge tree',({f,e})=>{f.responses.set(`GET /repos/fixture/repo/git/commits/${e.merge}`,{tree:{sha:sha(1)},parents:[{sha:f.p.base_head},{sha:f.p.head}]});}]
]) test(`deployment rejects ${name} mismatch without any remote mutation`,async()=>{
 const x=evidenceFixture();change(x);x.c.evidence.hash=digest(x.e);await assert.rejects(deploymentEvidence(x.c,x.e,x.f.io.api,async()=>Buffer.from('log')));assert.ok(x.f.calls.every(x=>x.method==='GET'));
});
test('deployment rejects corrupt host logs',async()=>{
 const {f,c,e}=evidenceFixture();await assert.rejects(deploymentEvidence(c,e,f.io.api,async()=>Buffer.from('changed')),/log corrupt/);
});

test('deployment never copies raw parser/auth errors to the durable journal',async()=>{
 const f=fixture();f.io.backup=async()=>{throw Error('Unexpected token SECRET-CREDENTIAL');};await deploy(f.c,f.io);assert.doesNotMatch(JSON.stringify(f.journal),/SECRET-CREDENTIAL/);assert.match(f.journal.reason,/privately/);
});
for(const [name,change] of [
 ['policy file',({f})=>{f.responses.set('GET /repos/fixture/repo/pulls/2/files?per_page=100',[{filename:'WORKFLOW.md'}]);}],
 ['runner source',({c})=>{c.target.runnerSource=h(7);}]
]) test(`deployment refuses ${name}`,async()=>{const x=evidenceFixture();change(x);await assert.rejects(deploymentEvidence(x.c,x.e,x.f.io.api,async()=>Buffer.from('log')));});

test('real filesystem deployment lock excludes concurrent deployments and existing launch/watch owners',async()=>{
 const root=await mkdtemp('/tmp/momoflow-deploy-lock-');
 const c={stateRoot:join(root,'state'),deploymentRoot:join(root,'deploy'),deploymentId:h(1)};
 await mkdir(c.stateRoot);
 try {
  await withControllerLock(c,async()=>{
   await assert.rejects(withDeploymentLock(c,async()=>assert.fail('stole controller lock')),/EEXIST/);
  });
  await withDeploymentLock(c,async()=>{
   await assert.rejects(withDeploymentLock(c,async()=>assert.fail('concurrent deployment')),/EEXIST/);
   await assert.rejects(withControllerLock(c,async()=>assert.fail('new launch during deploy')),/EEXIST/);
   await access(join(c.deploymentRoot,'deployment.lock'));
  });
  await writeFile(join(c.deploymentRoot,'deployment.lock'),'crashed ownership');
  await assert.rejects(withDeploymentLock(c,async()=>assert.fail('stole stale lock')),/EEXIST/);
 } finally {await rm(root,{recursive:true,force:true});}
});
function runtimeFixture() {
 const f=fixture(),c=f.c,b=c.target;c.dataVolume='test-data';
 const common={privileged:false,capAdd:null,capDrop:['ALL'],securityOpt:['no-new-privileges'],networkMode:'isolated_default',environmentHash:h(1)};
 const mount=(destination,source=destination,rw=false,type='bind')=>({destination,source,rw,type});
 b.inspect.symphony={...common,image:b.image,user:'momo',securityOpt:['no-new-privileges','seccomp=/operator/seccomp.json'],mounts:[mount('/data',c.dataVolume,true,'volume'),mount('/config/WORKFLOW.md'),mount('/run/momoflow-launch'),mount('/run/momoflow-resume'),mount('/run/momoflow-admission',c.gateRoot),mount('/run/momoflow-auth')],ports:{'4000/tcp':[{HostIp:'127.0.0.1',HostPort:'4000'}]}};
 b.inspect['github-auth']={...common,image:b.authImage,readonly:true,mounts:[mount('/run/secrets/github-app.pem'),mount('/run/momoflow-auth','auth',true,'volume')]};
 return f;
}
test('deployment runtime accepts pinned custody, read-only gate and independent host publish',()=>{const f=runtimeFixture();safeRuntime(f.c,f.c.target);});
for(const [name,mutate] of [
 ['Docker socket',e=>e.mounts.push({source:'/var/run/docker.sock',destination:'/var/run/docker.sock'})],
 ['key mount',e=>e.mounts.push({source:'/key',destination:'/run/secrets/key.pem'})],
 ['extra write mount',e=>e.mounts.push({source:'/operator',destination:'/operator',rw:true})],
 ['writable gate',e=>{e.mounts.find(x=>x.destination==='/run/momoflow-admission').rw=true;}],
 ['host network',e=>{e.networkMode='host';}],['engine network lifetime',e=>{e.networkMode='container:engine';}],
 ['privileged',e=>{e.privileged=true;}],['seccomp removed',e=>{e.securityOpt=['no-new-privileges'];}],
 ['open public port',e=>{e.ports['4000/tcp'][0].HostIp='0.0.0.0';}]
]) test(`deployment runtime refuses ${name}`,()=>{const f=runtimeFixture();mutate(f.c.target.inspect.symphony);assert.throws(()=>safeRuntime(f.c,f.c.target));});
test('active contract verifies source, repo, concurrency, read-only mounts and unchanged manifest/limit',()=>{
 const f=fixture(),c=f.c,b=c.target;
 const s={admission:{contract:1,configured:true,paused:true,generation:c.deploymentId},momoflow_launch:{contract:1,source:b.runnerSource,repo:c.repo,concurrency:1,role_flow:true,launch_read_only:true,inbox_read_only:true,launch_root:'/run/momoflow-launch',inbox_root:'/run/momoflow-resume',manifest:c.manifest}};
 activeContract(c,b,s,true);
 for(const [key,value] of [['source',h(8)],['repo','wrong/repo'],['concurrency',2],['launch_read_only',false],['manifest',{status:'present',value:{limit:3}}]]) {
  const x=structuredClone(s);x.momoflow_launch[key]=value;assert.throws(()=>activeContract(c,b,x,true));
 }
});

test('live owner directory check includes partial launch journals and stale per-issue locks',async()=>{
 const root=await mkdtemp('/tmp/momoflow-deploy-owners-'), dir=join(root,h(1));await mkdir(dir);
 try {
  assert.equal(await controllersIdle(root),true);
  await writeFile(join(dir,'launch.json'),JSON.stringify({dispatched:true}));assert.equal(await controllersIdle(root),false);
  await writeFile(join(dir,'launch.json'),JSON.stringify({done:true}));assert.equal(await controllersIdle(root),true);
  await writeFile(join(dir,'journal.json'),JSON.stringify({blocker:'unresolved'}));assert.equal(await controllersIdle(root),false);
  await writeFile(join(dir,'journal.json'),JSON.stringify({done:true}));assert.equal(await controllersIdle(root),true);
  await writeFile(join(dir,'lock'),'stale owner');assert.equal(await controllersIdle(root),false);
 } finally {await rm(root,{recursive:true,force:true});}
});

// These regressions invoke the same file/Compose validator used by connected()
// before replacement; only Docker inspection/rendering are simulated.
import { bundleFiles, readRoleRows, deploymentOwnersIdle, runtimeIdentity } from './deploy.mjs';
import fs from 'node:fs';
import { reconcile } from './post-pr.mjs';
async function composeFixture() {
 const f=runtimeFixture(), c=f.c,b=c.target,root=await mkdtemp('/tmp/momoflow-compose-');
 const workflow=join(root,'WORKFLOW.md'),seccomp=join(root,'seccomp.json');
 const profile={defaultAction:'SCMP_ACT_ERRNO',syscalls:[]};
 await writeFile(workflow,'workflow');await writeFile(seccomp,JSON.stringify(profile,null,2));
 b.composeFile=join(root,'compose.json');
 const images={};const doc={name:c.project,services:{},networks:{default:{name:c.project+'_default'}},volumes:{data:{name:c.dataVolume,external:true},auth:{name:'auth',external:true}}};
 for(const name of ['symphony','github-auth']) {
  const x=b.inspect[name];x.entrypoint=null;x.command=['node',name];x.readonly=name==='github-auth';x.user=name==='symphony'?'momo':'node';x.ports ||= {};x.networkMode=c.project+'_default';
  if(name==='symphony') {x.mounts.find(m=>m.destination==='/config/WORKFLOW.md').source=workflow;x.mounts.find(m=>m.destination==='/run/momoflow-auth').source='auth';x.mounts.find(m=>m.destination==='/run/momoflow-auth').type='volume';x.securityOpt=['no-new-privileges','seccomp='+JSON.stringify(profile)];}
  x.mounts.sort((a,b)=>a.destination.localeCompare(b.destination));
  const environment=name==='symphony'?{MOMOFLOW_ADMISSION_ROOT:'/run/momoflow-admission',MOMOFLOW_ROLE_FLOW:'1',GITHUB_REPO:c.repo,GITHUB_TOKEN_FILE:'/run/momoflow-auth/token.json'}:{};
  x.environmentHash=digest(['BASE=1',...Object.entries(environment).map(([k,v])=>k+'='+v)].sort());
  images[x.image]={Id:x.image,Config:{User:x.user,Env:['BASE=1'],Entrypoint:null,Cmd:x.command}};
  const volumes=x.mounts.map(m=>({type:m.type,source:m.type==='volume'?(m.source===c.dataVolume?'data':'auth'):m.source,target:m.destination,read_only:!m.rw,...(m.type==='bind'?{bind:{create_host_path:false}}:{volume:{nocopy:true}})}));
  doc.services[name]={image:x.image,init:true,restart:'unless-stopped',networks:{default:null},volumes,environment,cap_drop:['ALL'],security_opt:name==='symphony'?['no-new-privileges','seccomp='+seccomp]:x.securityOpt,read_only:x.readonly,...(name==='symphony'?{ports:[{target:4000,published:'4000',host_ip:'127.0.0.1',protocol:'tcp',mode:'ingress'}]}:{})};
 }
 const persist=async()=>{await writeFile(b.composeFile,JSON.stringify(doc));b.files={[b.composeFile]:digest(JSON.stringify(doc)),[workflow]:digest('workflow'),[seccomp]:digest(await fs.promises.readFile(seccomp))};b.composeHash=b.files[b.composeFile];};
 const dockerCalls=[];
 const docker=async args=>{dockerCalls.push(args);if(args[0]==='inspect') return JSON.stringify([images[args[1]]]);assert.ok(args.includes('config'));return JSON.stringify(doc);};
 return {...f,root,c,b,doc,images,persist,docker,dockerCalls,seccomp,profile};
}
test('connected bundle validator binds resolved services to pinned image defaults and expected runtime before up',async()=>{
 const x=await composeFixture();try {await x.persist();await bundleFiles(x.c,x.b,x.docker);assert.equal(x.dockerCalls.length,3);} finally {await rm(x.root,{recursive:true,force:true});}
});

test('Docker inline seccomp and pinned Compose file compare by effective profile content',async()=>{
 const x=await composeFixture();try {
  await x.persist();await bundleFiles(x.c,x.b,x.docker);
  // Same content with different object order/whitespace also survives runtime inspection.
  const raw={Image:x.b.image,Config:x.images[x.b.image].Config,Mounts:[],HostConfig:{SecurityOpt:['no-new-privileges:true','seccomp='+JSON.stringify({syscalls:[],defaultAction:'SCMP_ACT_ERRNO'},null,2)]}};
  assert.deepEqual(runtimeIdentity(raw).securityOpt,['no-new-privileges','seccomp='+JSON.stringify({defaultAction:'SCMP_ACT_ERRNO',syscalls:[]})]);
  x.b.inspect.symphony.securityOpt=runtimeIdentity(raw).securityOpt;
  await bundleFiles(x.c,x.b,x.docker);
  // Inspect drift is rejected even when Compose/file bytes are unchanged.
  x.b.inspect.symphony.securityOpt=['no-new-privileges','seccomp={"defaultAction":"SCMP_ACT_ALLOW","syscalls":[]}'];
  await assert.rejects(bundleFiles(x.c,x.b,x.docker),/runtime contract/);
  x.b.inspect.symphony.securityOpt=runtimeIdentity(raw).securityOpt;
  await writeFile(x.seccomp,JSON.stringify({defaultAction:'SCMP_ACT_ALLOW',syscalls:[]}));
  await assert.rejects(bundleFiles(x.c,x.b,x.docker),/Pinned bundle file changed/);
  // Re-pin changed file bytes: content must still match the independently observed runtime.
  await x.persist();
  const f=fixture();f.io.preflight=()=>bundleFiles(x.c,x.b,x.docker);
  await assert.rejects(deploy(x.c,f.io),/runtime contract/);
  assert.ok(!f.calls.some(v=>v.startsWith('gate:')||v.startsWith('replace:')||v==='backup'));
 } finally {await rm(x.root,{recursive:true,force:true});}
});
for(const value of ['unconfined','/operator/seccomp.json','null','[]','{malformed']) test(`Docker seccomp rejects non-profile inspect value ${value}`,()=>{
 assert.throws(()=>runtimeIdentity({Config:{},Mounts:[],HostConfig:{SecurityOpt:['seccomp='+value]}}));
});
test('changed inline Docker seccomp content differs during runtime verification',()=>{
 const raw={Config:{},Mounts:[],HostConfig:{SecurityOpt:['seccomp={"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}']}};
 const expected=runtimeIdentity(raw);
 raw.HostConfig.SecurityOpt=['seccomp={"defaultAction":"SCMP_ACT_ALLOW","syscalls":[]}'];
 assert.notDeepEqual(runtimeIdentity(raw),expected);
});

for(const [name,change] of [
 ['root user',s=>{s.user='root';}],['privileged',s=>{s.privileged=true;}],['capability',s=>{s.cap_add=['SYS_ADMIN'];}],
 ['socket',s=>s.volumes.push({type:'bind',source:'/var/run/docker.sock',target:'/var/run/docker.sock'})],
 ['data source',s=>{s.volumes.find(m=>m.target==='/data').source='auth';}],
 ['admission source',s=>{s.volumes.find(m=>m.target==='/run/momoflow-admission').source='/wrong';}],
 ['launch source',s=>{s.volumes.find(m=>m.target==='/run/momoflow-launch').source='/wrong';}],
 ['inbox write',s=>{s.volumes.find(m=>m.target==='/run/momoflow-resume').read_only=false;}],
 ['auth source',s=>{s.volumes.find(m=>m.target==='/run/momoflow-auth').source='data';}],
 ['network',s=>{s.network_mode='host';}],['device',s=>{s.devices=['/dev/kvm'];}],['pid',s=>{s.pid='host';}],
 ['command',s=>{s.command=['sh','-c','echo changed'];}],['entrypoint',s=>{s.entrypoint=['sh'];}],
 ['environment',s=>{s.environment.HOME='/root';}],['seccomp',s=>{s.security_opt=['no-new-privileges','seccomp=unconfined'];}],
 ['port',s=>{s.ports[0].host_ip='0.0.0.0';}],['bind creation',s=>{s.volumes.find(m=>m.type==='bind').bind.create_host_path=true;}],
 ['build hook',s=>{s.build='.';}]
]) test(`connected bundle ${name} mismatch prevents any deployment effect`,async()=>{
 const x=await composeFixture();try {
  change(x.doc.services.symphony);await x.persist();
  const f=fixture();f.io.preflight=()=>bundleFiles(x.c,x.b,x.docker);
  await assert.rejects(deploy(x.c,f.io));
  assert.ok(!f.calls.some(v=>v.startsWith('gate:')||v.startsWith('replace:')||v==='backup'));
  assert.ok(x.dockerCalls.every(v=>v[0]==='inspect')); // fails before config, create or up
 } finally {await rm(x.root,{recursive:true,force:true});}
});
test('image inherited entrypoint and anonymous volumes cannot bypass Compose binding',async()=>{
 const x=await composeFixture();try {
  await x.persist();x.images[x.b.image].Config.Entrypoint=['sh'];await assert.rejects(bundleFiles(x.c,x.b,x.docker),/runtime contract/);
  x.images[x.b.image].Config.Entrypoint=null;x.images[x.b.image].Config.Volumes={'/unexpected':{}};await assert.rejects(bundleFiles(x.c,x.b,x.docker),/default volumes/);
 } finally {await rm(x.root,{recursive:true,force:true});}
});
test('valid pristine data volume has no roles yet; corrupt existing state remains blocking',async()=>{
 const root=await mkdtemp('/tmp/momoflow-fresh-data-');
 try {
  assert.throws(()=>readRoleRows(fs,root));await mkdir(join(root,'log'));await mkdir(join(root,'workspaces'));
  assert.deepEqual(readRoleRows(fs,root),[]);
  await mkdir(join(root,'log/roles'));await writeFile(join(root,'log/roles',h(1)+'.json'),'{broken');assert.throws(()=>readRoleRows(fs,root));
  await rm(join(root,'log/roles'),{recursive:true});await writeFile(join(root,'log/roles'),'invalid');assert.throws(()=>readRoleRows(fs,root));
 } finally {await rm(root,{recursive:true,force:true});}
});
test('completed actual host reconcile releases await_validation ledger only with matching durable evidence',async()=>{
 const f=controllerFixture(),root=await mkdtemp('/tmp/momoflow-completed-owner-');
 try {
  assert.equal((await reconcile(f.c,f.io)).done,true);
  assert.equal(f.ledger.stage,'await_validation');assert.equal(f.ledger.in_flight,false);
  const key=digest(`${f.c.repo}:${f.c.issue}`),dir=join(root,key);await mkdir(dir);
  const row={file:key+'.json',issue:f.ledger.issue,stage:f.ledger.stage,in_flight:false,active_session:false,publication:f.ledger.publication};
  const c={...f.c,stateRoot:root};
  assert.equal(await deploymentOwnersIdle(c,[row]),false); // unresolved/no host completion
  await writeFile(join(dir,'journal.json'),JSON.stringify(f.journal));
  assert.equal(await deploymentOwnersIdle(c,[row]),true);
  for(const patch of [{in_flight:true},{active_session:true},{issue:'2'},{file:h(9)+'.json'},{publication:{...row.publication,head:sha(2)}}]) assert.equal(await deploymentOwnersIdle(c,[{...row,...patch}]),false);
  for(const patch of [{done:false},{merged:sha(2)},{request:h(2)},{publication:{...row.publication,head:sha(2)}},{validation:{...f.journal.validation,kind:'code_failure'}}]) {
   await writeFile(join(dir,'journal.json'),JSON.stringify({...f.journal,...patch}));assert.equal(await deploymentOwnersIdle(c,[row]),false);
  }
 } finally {await rm(root,{recursive:true,force:true});}
});
test('API manifest object order is immaterial while fields and limit remain strict',()=>{
 const f=fixture(),c=f.c,b=c.target;
 c.manifest={status:'present',value:{v:1,id:h(2),repo:c.repo,issue:c.issue,base:c.base,limit:3}};
 const manifest={value:{repo:c.repo,limit:3,issue:c.issue,id:h(2),base:c.base,v:1},status:'present'};
 const s={admission:{contract:1,configured:true,paused:true,generation:c.deploymentId},momoflow_launch:{contract:1,source:b.runnerSource,repo:c.repo,concurrency:1,role_flow:true,launch_read_only:true,inbox_read_only:true,launch_root:'/run/momoflow-launch',inbox_root:'/run/momoflow-resume',manifest}};
 activeContract(c,b,JSON.parse(JSON.stringify(s)),true);
 s.momoflow_launch.manifest.value.limit=2;assert.throws(()=>activeContract(c,b,s,true),/changed/);
 c.manifest.value.extra=true;assert.throws(()=>activeContract(c,b,s,true),/Invalid/);
});
test('runtime environment identity ignores Docker Env ordering without exposing values',()=>{
 const x={Image:'id',Config:{User:'momo',Entrypoint:null,Cmd:['cmd'],Env:['B=2','A=1']},Mounts:[],HostConfig:{}};
 const a=runtimeIdentity(x);x.Config.Env.reverse();assert.deepEqual(runtimeIdentity(x),a);assert.equal(a.environmentHash,digest(['A=1','B=2']));
});
test('role reader rejects symlinks and unreadable existing roles',async()=>{
 const root=await mkdtemp('/tmp/momoflow-role-layout-');try {
  await mkdir(join(root,'log'));await mkdir(join(root,'workspaces'));await mkdir(join(root,'log/roles'));
  const unreadable={...fs,readdirSync:()=>{throw Object.assign(Error('unreadable'),{code:'EACCES'});}};
  assert.throws(()=>readRoleRows(unreadable,root),/unreadable/);
  fs.symlinkSync(join(root,'workspaces'),join(root,'log/roles',h(1)+'.json'));assert.throws(()=>readRoleRows(fs,root));
 } finally {await rm(root,{recursive:true,force:true});}
});

test('asynchronous gate acknowledgement waits for matching generation before drain/backup',async()=>{
 const f=fixture(),state=f.io.state;let acknowledged=false;
 f.io.state=async()=>{const s=await state();if(!acknowledged) {s.admission.generation=h(8);s.admission.paused=false;}return s;};
 f.io.sleep=async()=>{assert.ok(!f.calls.includes('backup'));acknowledged=true;};
 assert.equal((await deploy(f.c,f.io)).phase,'complete');
 assert.equal(f.journal.pauseAdmission.generation,h(8));assert.equal(f.journal.drainedAdmission.generation,f.c.deploymentId);
});
test('unacknowledged generation times out without replacement and leaves admission held',async()=>{
 const f=fixture(),state=f.io.state;
 f.io.state=async()=>{const s=await state();s.admission.generation=h(8);return s;};
 assert.equal((await deploy(f.c,f.io)).phase,'deferred');assert.equal(f.paused,true);assert.ok(!f.calls.includes('backup'));
});

// Include isolated provenance regressions in the existing host/CI test entrypoint.
import './deploy-fixture.test.mjs';
