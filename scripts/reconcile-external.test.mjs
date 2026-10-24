// Real temporary files/atomic archives; engine, processes and GitHub are simulated.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir,lstat,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from './post-pr-fixture.mjs';
import {atomic,digest,keyFor,withControllerLock} from './post-pr.mjs';
import {reconcileExternal,verifiedExternalReceipt,foreignOwners,observedWorkersIdle,observeReconciliationWorkers,verifyReconciliationOperator,historicalReceiptEvidence} from './reconcile-external.mjs';
import {controllersIdle,deploymentOwnersIdle,runtimeOwnersIdle} from './deploy.mjs';
import {inspect,launchConfig} from './launch.mjs';
const hex=n=>String(n).repeat(64),sha=n=>String(n).repeat(40);
test('worker observation accepts only complete known idle engine processes',()=>{
 assert.equal(observedWorkersIdle('PID COMMAND\n1 docker-init\n2 beam.smp\n3 erl_child_setup\n4 inet_gethost\n5 epmd\n'),true);
 for(const command of ['codex','node','sh','unknown'])assert.equal(observedWorkersIdle('PID COMMAND\n2 beam.smp\n3 '+command),false);
 for(const output of ['','PID COMMAND','unexpected\n2 beam.smp'])assert.throws(()=>observedWorkersIdle(output),/incomplete/);
 for(const row of ['0 beam.smp','x beam.smp','99999999999999999999 beam.smp','2 beam.smp\n2 epmd','1 beam.smp extra'])assert.throws(()=>observedWorkersIdle('PID COMMAND\n'+row),/malformed/);
});
async function setup() {
 const root=await mkdtemp('/tmp/reconcile-external-');
 const c={...fixture().c,pr:21,head:sha(1),tree:sha(2),merge:sha(3),originalIterations:3,externalIterations:4,engineContainer:hex(1),engineImage:'sha256:'+hex(2),productionProject:'prod',runnerSource:hex(3)};
 c.authority={...c.authority,reconcile:true};
 for(const key of ['stateRoot','ledgerRoot','launchRoot','gateRoot','inboxRoot','trustedRoot']){c[key]=join(root,key);await mkdir(c[key]);}
 c.tokenFile=join(root,'token');const dir=join(c.stateRoot,keyFor(c));await mkdir(dir);
 const manifest={v:1,id:hex(4),repo:c.repo,issue:c.issue,base:c.base,limit:3};
 const ledger={issue:c.issue,launch:manifest,iterations:3,in_flight:true,active_session:{thread_id:'interrupted',turn_id:'old'},stage:'blocked',events:[{role:'build',result:'failed'}]};
 const gate={v:1,generation:hex(5),paused:false};
 const values={ledger,enrollment:{enrolled:true},manifest,gate,launchJournal:{contract:digest(manifest),dispatched:true,observed:true,blocker:'original interrupted'},
  recovery:{issue:1,pr:21,head:c.head,tree:c.tree,previous_iterations:3,additional_iterations_used:4,status:'fourth-complete-validated',original_ledger_unchanged:true,docker_tests:{tests:270,failed:0}},
  validation:{status:'deployed',commit:c.merge,head:c.head,tree:c.tree,image:c.engineImage,original_interrupted_ledger_preserved:true}};
 const paths={ledger:join(c.ledgerRoot,keyFor(c)+'.json'),enrollment:join(c.ledgerRoot,keyFor(c)+'.json.enrolled'),manifest:join(c.launchRoot,'active.json'),gate:join(c.gateRoot,'active.json'),launchJournal:join(dir,'launch.json'),controllerJournal:join(dir,'journal.json'),recovery:join(root,'recovery.json'),validation:join(root,'validation.json')};
 c.evidence={};for(const [name,path] of Object.entries(paths)) {
  if(name==='controllerJournal'){c.evidence[name]={path,hash:null};continue;}
  await atomic(path,values[name],name==='gate'||name==='manifest'?0o644:0o600);c.evidence[name]={path,hash:digest(await readFile(path))};
 }
 const f={root,c,dir,manifest,ledger,gate,paths,calls:[],workers:true,mutateState:s=>s};
 f.io={authorize:async()=>{},workers:async()=>f.workers,api:async(method,path)=>{
  f.calls.push({method,path});assert.equal(method,'GET');
  if(path.endsWith('/issues/1'))return {state:'closed',number:1,labels:[]};
  if(path.endsWith('/pulls/21'))return {state:'closed',merged:true,merge_commit_sha:c.merge,head:{sha:c.head,repo:{full_name:c.repo}},base:{ref:c.base,repo:{full_name:c.repo}}};
  if(path.includes('/git/commits/'))return {tree:{sha:c.tree},parents:[{sha:c.head}]};
  if(path.includes('issues?'))return [];throw Error('Unexpected API');
 },engine:async()=>{
  let manifest;try{manifest=JSON.parse(await readFile(paths.manifest));}catch(e){if(e.code!=='ENOENT')throw e;}
  const g=JSON.parse(await readFile(paths.gate));
  return f.mutateState({running:[],retrying:[],admission:{contract:1,configured:true,generation:g.generation,paused:g.paused,running:[],retrying:[],claimed:[],blocked:[],pending_dispatch:false},momoflow_launch:{contract:1,repo:c.repo,source:c.runnerSource,concurrency:1,role_flow:true,launch_read_only:true,inbox_read_only:true,launch_root:'/run/momoflow-launch',inbox_root:'/run/momoflow-resume',manifest:manifest?{status:'present',value:manifest}:{status:'absent'}}});
 },ack:async()=>{}};
 f.run=options=>withControllerLock(c,()=>reconcileExternal(c,f.io,options));
 f.clean=()=>rm(root,{recursive:true,force:true});return f;
}
async function snapshot(root) {
 const result={};async function visit(path){for(const item of await readdir(path,{withFileTypes:true})){const p=join(path,item.name);if(item.isDirectory())await visit(p);else result[p.slice(root.length)]=digest(await readFile(p));}}await visit(root);return result;
}
test('external reconciliation check is effect-free and reports separate original/external history',async()=>{
 const f=await setup();try {
  const before=await snapshot(f.root);const result=await reconcileExternal(f.c,f.io,{check:true});
  assert.equal(result.status,'eligible');assert.equal(result.originalIterations,3);assert.equal(result.externalIterations,4);assert.equal(result.effects,'none');
  assert.deepEqual(await snapshot(f.root),before);assert.ok(f.calls.every(c=>c.method==='GET'));
 }finally{await f.clean();}
});
test('reconciliation archives exact originals, retires only old manifest, restores gate; launch and deployment accept only the verified historical owner',async()=>{
 const f=await setup();try {
  const before=await snapshot(f.root);await assert.rejects(foreignOwners({...f.c,issue:'2'}),/unfinished/);
  assert.equal((await f.run()).status,'externally-reconciled');
  for(const name of ['ledger','enrollment','launchJournal','recovery','validation','gate'])assert.equal(digest(await readFile(f.paths[name])),before[f.paths[name].slice(f.root.length)]);
  await assert.rejects(lstat(f.paths.manifest),{code:'ENOENT'});assert.equal(await verifiedExternalReceipt(f.c,keyFor(f.c)),true);
  await foreignOwners({...f.c,issue:'2',gateRoot:undefined});assert.equal(await controllersIdle(f.c.stateRoot),false);
  const observation=await liveObservation(f);
  assert.equal(await deploymentOwnersIdle(f.c,observation.rows,observation),true);
  const after=await snapshot(f.root);assert.equal((await f.run()).unchanged,true);assert.deepEqual(await snapshot(f.root),after);
  assert.equal(f.calls.filter(c=>c.method!=='GET').length,0);
 }finally{await f.clean();}
});
for(const phase of ['intent','fence-written','fenced','manifest-retired','gate-restored','receipt'])test('identical reconciliation retry after crash at '+phase,async()=>{
 const f=await setup();try {
  const original=digest(await readFile(f.paths.ledger));let crashed=false;
  f.io.checkpoint=async name=>{if(name===phase && !crashed){crashed=true;throw Error('simulated crash');}};
  await assert.rejects(f.run(),/simulated crash/);assert.equal(crashed,true);
  if(['fence-written','fenced','manifest-retired'].includes(phase))assert.equal(JSON.parse(await readFile(f.paths.gate)).paused,true);
  await f.run();assert.equal(await verifiedExternalReceipt(f.c,keyFor(f.c)),true);assert.equal(digest(await readFile(f.paths.ledger)),original);
  assert.deepEqual(JSON.parse(await readFile(f.paths.gate)),f.gate);
 }finally{await f.clean();}
});
for(const [name,mutate] of [
 ['authority',f=>{f.c.authority.reconcile=false;}],['wrong scope',f=>{f.c.issue='2';}],['stale ledger',async f=>writeFile(f.paths.ledger,'changed')],
 ['active workers',f=>{f.workers=false;}],['unknown workers',f=>{f.workers=null;}],
 ['active engine',f=>{f.mutateState=s=>({...s,running:[{issue_id:'1'}]});}],
 ['claimed',f=>{f.mutateState=s=>({...s,admission:{...s.admission,claimed:['owner']}});}],
 ['unknown admission',f=>{f.mutateState=s=>({...s,admission:{...s.admission,pending_dispatch:undefined}});}],
 ['wrong head',f=>{const api=f.io.api;f.io.api=async(m,p)=>p.endsWith('/pulls/21')?{...await api(m,p),head:{sha:sha(9),repo:{full_name:f.c.repo}}}:api(m,p);}],
 ['ready',f=>{const api=f.io.api;f.io.api=async(m,p)=>p.includes('issues?')?[{number:2}]:api(m,p);}],
 ['other ledger',async f=>atomic(join(f.c.ledgerRoot,hex(9)+'.json'),{stage:'build',in_flight:true})],
 ['unknown ledger state',async f=>atomic(join(f.c.ledgerRoot,hex(9)+'.json'),{stage:'blocked'})],
 ['other controller',async f=>{await mkdir(join(f.c.stateRoot,hex(9)));await atomic(join(f.c.stateRoot,hex(9),'launch.json'),{done:false});}],
 ['per issue lock',async f=>atomic(join(f.dir,'lock'),{pid:999})],
 ['symlink evidence',async f=>{const target=f.paths.recovery+'.target';await renameForTest(f.paths.recovery,target);await symlink(target,f.paths.recovery);}],
])test('reconciliation rejects '+name+' before archive/fence/retirement',async()=>{
 const f=await setup();try {
  await mutate(f);const before=await snapshot(f.root);await assert.rejects(f.run());assert.deepEqual(await snapshot(f.root),before);
  await assert.rejects(lstat(join(f.dir,'external-reconciliation-intent.json')),{code:'ENOENT'});
 }finally{await f.clean();}
});
async function renameForTest(from,to){const {rename}=await import('node:fs/promises');await rename(from,to);}
test('receipt never excuses changed records, foreign locks, or same-issue adoption',async()=>{
 const f=await setup();try {
  await f.run();
  const c=launchConfig({...f.c,authority:{...f.c.authority,launch:true},launchId:f.manifest.id,iterationLimit:3,composeImage:'docker:cli@sha256:'+hex(0)});
  const api=f.io.api;
  const io={...f.io,api:async(m,p)=>{
   if(p==='/repos/'+c.repo)return {full_name:c.repo,archived:false,disabled:false};
   if(p.endsWith('/issues/1'))return {number:1,state:'open',labels:[]};
   if(p.endsWith('/branches/main'))return {name:'main'};
   if(p.includes('/comments?'))return [];
   return api(m,p);
  },ledger:async()=>f.ledger,manifest:async()=>null,controllers:async()=>{throw Error('must reject before foreign receipt');}};
  await assert.rejects(inspect(c,io),/cannot be adopted/);
  await atomic(join(f.dir,'lock'),{pid:123});await assert.rejects(foreignOwners({...f.c,issue:'2'}),/lock/);await rm(join(f.dir,'lock'));
  await writeFile(f.paths.launchJournal,'changed');await assert.rejects(foreignOwners({...f.c,issue:'2'}),/bytes changed/);
 }finally{await f.clean();}
});
test('a remote head change while fenced prevents manifest retirement',async()=>{
 const f=await setup();try {
  const api=f.io.api;f.io.checkpoint=async name=>{if(name==='fenced')f.io.api=async(m,p)=>p.endsWith('/pulls/21')?{...await api(m,p),head:{sha:sha(9),repo:{full_name:f.c.repo}}}:api(m,p);};
  await assert.rejects(f.run(),/PR mismatch/);assert.deepEqual(JSON.parse(await readFile(f.paths.manifest)),f.manifest);
  assert.equal(JSON.parse(await readFile(f.paths.gate)).paused,true);
 }finally{await f.clean();}
});
test('shared controller ownership excludes reconciliation and changed evidence blocks crash retry',async()=>{
 const f=await setup();try {
  await withControllerLock(f.c,async()=>{await assert.rejects(f.run(),{code:'EEXIST'});});
  f.io.checkpoint=async name=>{if(name==='fenced')throw Error('crash');};await assert.rejects(f.run(),/crash/);
  await writeFile(f.paths.recovery,'changed');await assert.rejects(f.run(),/bytes changed/);
  assert.equal(JSON.parse(await readFile(f.paths.gate)).paused,true);assert.deepEqual(JSON.parse(await readFile(f.paths.manifest)),f.manifest);
 }finally{await f.clean();}
});

function operatorFixture() {
 const c={repo:'fixture/repo',productionProject:'prod',engineContainer:hex(1),engineImage:'sha256:'+hex(2),operatorContainer:hex(3),operatorImage:'sha256:'+hex(4),operatorSocketGroup:'1001',trustedRoot:'/operator/controller',configFile:'/operator/config/reconcile.json',stateRoot:'/operator/state',inboxRoot:'/operator/inbox',launchRoot:'/operator/launch',gateRoot:'/operator/admission',ledgerRoot:'/engine-data/log/roles',tokenFile:'/run/momoflow-auth/token.json',evidence:{recovery:{path:'/evidence/recovery.json'},validation:{path:'/evidence/validation.json'}}};
 const volume=(name,destination,rw)=>({Type:'volume',Name:name,Source:'/daemon/volumes/'+name,Destination:destination,RW:rw});
 const engine={Id:c.engineContainer,Image:c.engineImage,Name:'/prod-engine',State:{Running:true,Health:{Status:'healthy'}},Config:{Labels:{'com.docker.compose.project':'prod','com.docker.compose.service':'symphony'}},Mounts:[volume('live-data','/data',true),volume('live-auth','/run/momoflow-auth',false),...['/run/momoflow-launch','/run/momoflow-admission','/run/momoflow-resume'].map(path=>({Type:'bind',Source:'/daemon/opaque'+path,Destination:path,RW:false}))]};
 const bind=(path,rw)=>({Type:'bind',Source:path,Destination:path,RW:rw});
 const operator={Id:c.operatorContainer,Image:c.operatorImage,State:{Running:true},Config:{Hostname:'actual-helper',User:'1000:1000',Env:['HOME=/home/node'],Labels:{'com.docker.compose.service':'controller'}},HostConfig:{ReadonlyRootfs:true,Privileged:false,CapAdd:null,CapDrop:['ALL'],GroupAdd:['1001'],SecurityOpt:['no-new-privileges:true'],NetworkMode:'container:'+c.engineContainer},Mounts:[bind(c.trustedRoot,false),bind('/operator/config',false),bind(c.stateRoot,true),bind(c.inboxRoot,true),bind(c.launchRoot,true),bind(c.gateRoot,true),bind('/tmp',true),bind('/var/run/docker.sock',true),bind(c.evidence.recovery.path,false),bind(c.evidence.validation.path,false),volume('live-data','/engine-data',false),volume('live-auth','/run/momoflow-auth',false)]};
 const f={c,engine,operator,image:{Id:c.operatorImage,Config:{Env:['HOME=/home/node']}},calls:[],processes:'PID COMMAND\n1 docker-init\n2 beam.smp\n3 erl_child_setup\n4 inet_gethost\n'};
 f.docker=async a=>{
  f.calls.push(a);
  if(a[0]==='inspect')return JSON.stringify([a[1]===c.engineContainer?engine:a[1]===c.operatorContainer?operator:f.image]);
  assert.deepEqual(a,['top',c.engineContainer,'-eo','pid,comm']);return f.processes;
 };
 f.context={mounted:new Map(),host:async path=>({identity:path})};
 const controls={'/run/momoflow-launch':c.launchRoot,'/run/momoflow-admission':c.gateRoot,'/run/momoflow-resume':c.inboxRoot};
 for(const x of [engine,operator])for(const m of x.Mounts)f.context.mounted.set(m,m.Type==='volume'?{identity:m.Name}:{identity:controls[m.Destination] || m.Destination.replace('/var/run/docker.sock','/run/docker.sock')});
 f.verify=()=>verifyReconciliationOperator(c,{docker:f.docker,containerized:true,hostname:async()=>f.hostname || 'actual-helper',contextFor:async(docker,containers)=>{
  f.contextCalls=(f.contextCalls || 0)+1;
  assert.equal(docker,f.docker);assert.deepEqual(containers,[engine,operator]);
  // Docker parsing returns distinct objects, as it does for the real adapter.
  return {host:f.context.host,mounted:new Map(containers.flatMap(x=>x.Mounts.map(m=>[m,f.context.mounted.get([engine,operator].flatMap(x=>x.Mounts).find(old=>old.Destination===m.Destination && old.Source===m.Source && old.RW===m.RW))]))) };
 },historicalEvidence:async()=>f.historical || [],canonical:async path=>{assert.equal(path,'/var/run/docker.sock');return '/run/docker.sock';}});
 return f;
}
test('worker Docker adapter requests PID column and validates engine before and after observation',async()=>{
 const f=operatorFixture();assert.equal(await observeReconciliationWorkers(f.c,f.docker),true);
 assert.deepEqual(f.calls,[['inspect',f.c.engineContainer],['top',f.c.engineContainer,'-eo','pid,comm'],['inspect',f.c.engineContainer]]);
 f.processes='PID COMMAND\n1 codex';assert.equal(await observeReconciliationWorkers(f.c,f.docker),false);
 const docker=async a=>{const r=await f.docker(a);if(a[0]==='top')f.engine.State.Running=false;return r;};
 await assert.rejects(observeReconciliationWorkers(f.c,docker),/identity changed/);
});
test('trusted existing helper adapter proves current read-only ledger/auth backing and bind authority',async()=>{
 const f=operatorFixture();await f.verify();assert.ok(f.calls.every(a=>a[0]==='inspect'));
 await verifyReconciliationOperator(f.c,{containerized:false,docker:async()=>assert.fail('host must not adopt a helper')});
});
test('interrupted-review helper adds only the exact immutable evidence RO mounts',async()=>{
 const f=operatorFixture();f.c.profile='controller-review-interrupted-v3';
 for(const name of ['correction','review','tests','authorization','recoveryAuthorization','recoveryReview','recoveryTests','ownership','ownershipRequest']) {
  const path='/evidence/'+name+'.json',m={Type:'bind',Source:path,Destination:path,RW:false};f.c.evidence[name]={path,hash:hex(7)};f.operator.Mounts.push(m);f.context.mounted.set(m,{identity:path});
 }
 await f.verify();const auth=f.operator.Mounts.find(m=>m.Destination===f.c.evidence.authorization.path);
 auth.RW=true;await assert.rejects(f.verify(),/source\/authority/);auth.RW=false;
 auth.Source='/copied-authorization';await assert.rejects(f.verify(),/source\/authority/);auth.Source=auth.Destination;
 f.operator.Mounts.push({Type:'bind',Source:'/private-key',Destination:'/private-key',RW:false});await assert.rejects(f.verify(),/Unexpected operator mounts/);
});
test('alternate state bind with copied journals and self-consistent helper backing is rejected before context or effects',async()=>{
 const f=operatorFixture(),state=f.operator.Mounts.find(m=>m.Destination===f.c.stateRoot),originalHost=f.context.host;
 state.Source='/another-operator-state';f.context.mounted.set(state,{identity:state.Source});
 f.context.host=async path=>path===f.c.stateRoot?{identity:state.Source}:originalHost(path);
 await assert.rejects(f.verify(),/bind.*(source|authority)/i);
 assert.equal(f.contextCalls || 0,0);
 assert.ok(f.calls.every(a=>a[0]==='inspect'));
});
for(const destination of ['/run/momoflow-launch','/run/momoflow-admission','/run/momoflow-resume'])test('helper controls must match independent live engine backing '+destination,async()=>{
 const f=operatorFixture(),m=f.engine.Mounts.find(m=>m.Destination===destination);
 f.context.mounted.set(m,{identity:'different-live-engine-backing'});
 await assert.rejects(f.verify(),/control.*correspondence/i);
 assert.ok(f.calls.every(a=>a[0]==='inspect'));
});
for(const [name,change] of [
 ['coding engine identity',f=>{f.c.operatorContainer=f.c.engineContainer;}],['unproven self',f=>{f.hostname='coding-engine';}],
 ['wrong image',f=>{f.operator.Image='sha256:'+hex(9);}],['engine as service',f=>{f.operator.Config.Labels['com.docker.compose.service']='symphony';}],
 ['writable root',f=>{f.operator.HostConfig.ReadonlyRootfs=false;}],['root user',f=>{f.operator.Config.User='0:0';}],['privilege',f=>{f.operator.HostConfig.Privileged=true;}],
 ['capability',f=>{f.operator.HostConfig.CapAdd=['SYS_ADMIN'];}],['socket group',f=>{f.operator.HostConfig.GroupAdd=['0'];}],
 ['host network',f=>{f.operator.HostConfig.NetworkMode='host';}],['wrong network engine',f=>{f.operator.HostConfig.NetworkMode='container:other';}],
 ['credential environment',f=>{f.operator.Config.Env.push('OPENAI_API_KEY=private');}],
 ['writable controller',f=>{f.operator.Mounts.find(m=>m.Destination===f.c.trustedRoot).RW=true;}],
 ['writable evidence',f=>{f.operator.Mounts.find(m=>m.Destination==='/evidence/recovery.json').RW=true;}],
 ['writable ledger',f=>{f.operator.Mounts.find(m=>m.Destination==='/engine-data').RW=true;}],
 ['wrong live ledger',f=>{f.operator.Mounts.find(m=>m.Destination==='/engine-data').Name='stale-copy';}],
 ['wrong auth source',f=>{f.operator.Mounts.find(m=>m.Destination==='/run/momoflow-auth').Source='/other';}],
 ['unproven bind',f=>{f.context.host=async()=>({identity:'wrong'});}],
 ['extra mount',f=>{f.operator.Mounts.push({Type:'bind',Source:'/other',Destination:'/other',RW:true});}],
])test('operator helper adapter rejects '+name,async()=>{const f=operatorFixture();change(f);await assert.rejects(f.verify());});

// Simulated live transport; exact source/archive bytes use real temporary files.
async function liveObservation(f) {
 return {rows:[{file:keyFor(f.c)+'.json',...JSON.parse(await readFile(f.paths.ledger)),
  bytes:(await readFile(f.paths.ledger)).toString('base64'),enrollment:(await readFile(f.paths.enrollment)).toString('base64')}],manifest:null};
}
for(const [name,mutate] of [
 ['missing receipt',async f=>rm(join(f.dir,'external-reconciliation.json'))],
 ['incomplete receipt',async f=>{const p=join(f.dir,'external-reconciliation.json'),r=JSON.parse(await readFile(p));r.done=false;await atomic(p,r);}],
 ['wrong repo',(f,o)=>{f.c.repo='other/repo';}],
 ['wrong base',(f,o)=>{f.c.base='other';}],
 ['wrong ledger path',f=>{f.c.ledgerRoot+='/other';}],
 ['wrong journal root',f=>{f.c.stateRoot+='/other';}],
 ['wrong launch path',f=>{f.c.launchRoot+='/other';}],
 ['wrong gate path',f=>{f.c.gateRoot+='/other';}],
 ['missing live row',(f,o)=>{o.rows.length=0;}],
 ['missing live enrollment',(f,o)=>{o.rows[0].enrollment=null;}],
 ['changed live ledger',(f,o)=>{o.rows[0].bytes=Buffer.from(JSON.stringify({...f.ledger,in_flight:false})).toString('base64');}],
 ['changed live enrollment',(f,o)=>{o.rows[0].enrollment=Buffer.from('{}').toString('base64');}],
 ['changed launch journal',async f=>writeFile(f.paths.launchJournal,'changed')],
 ['unexpected controller journal',async f=>atomic(f.paths.controllerJournal,{done:true})],
 ['changed recovery',async f=>writeFile(f.paths.recovery,'changed')],
 ['changed validation',async f=>writeFile(f.paths.validation,'changed')],
 ['missing archive',async f=>{const r=JSON.parse(await readFile(join(f.dir,'external-reconciliation.json')));await rm(r.archive,{recursive:true});}],
 ['changed archive',async f=>{const r=JSON.parse(await readFile(join(f.dir,'external-reconciliation.json')));await rm(join(r.archive,'ledger'));await writeFile(join(r.archive,'ledger'),'changed',{mode:0o400});}],
 ['wrong archive path',async f=>{const p=join(f.dir,'external-reconciliation.json'),r=JSON.parse(await readFile(p));r.archive+='/other';await atomic(p,r);}],
 ['reactivated manifest',(f,o)=>{o.manifest=f.manifest;}],
 ['unknown manifest',(f,o)=>{delete o.manifest;}],
 ['per issue lock',async f=>atomic(join(f.dir,'lock'),{pid:123})],
 ['other active ledger',(f,o)=>{o.rows.push({file:hex(9)+'.json',stage:'build',in_flight:true});}],
 ['receipt-less idle blocked',(f,o)=>{o.rows.push({file:hex(9)+'.json',stage:'blocked',in_flight:false,active_session:false});}],
 ['receipt-less interrupted blocked',(f,o)=>{o.rows.push({file:hex(9)+'.json',stage:'blocked',in_flight:true,active_session:true});}],
 ['other unknown ledger',(f,o)=>{o.rows.push({file:hex(9)+'.json',in_flight:false,stage:'unknown'});}],
 ['unknown controller directory',async f=>mkdir(join(f.c.stateRoot,'unknown'))],
 ['unfinished foreign journal',async f=>{const d=join(f.c.stateRoot,hex(9));await mkdir(d);await atomic(join(d,'launch.json'),{dispatched:true});}],
])test('deployment receipt owner rejects '+name,async()=>{
 const f=await setup();try {
  await f.run();const observation=await liveObservation(f);await mutate(f,observation);
  let accepted=false;try{accepted=await deploymentOwnersIdle(f.c,observation.rows,observation);}catch{}assert.equal(accepted,false);
 }finally{await f.clean();}
});
test('deployment uses observed bytes instead of a host ledger mirror and rechecks receipts every time',async()=>{
 const f=await setup();try {
  await f.run();const observation=await liveObservation(f);
  // The host copy is stale/unavailable: live observation still binds the archived original.
  await writeFile(f.paths.ledger,'stale host mirror');await rm(f.paths.enrollment);
  const before=await snapshot(f.root);
  assert.equal(await deploymentOwnersIdle(f.c,observation.rows,observation),true);
  assert.deepEqual(await snapshot(f.root),before);
  await writeFile(f.paths.launchJournal,'changed between drain and replacement');
  await assert.rejects(deploymentOwnersIdle(f.c,observation.rows,observation),/bytes changed/);
 }finally{await f.clean();}
});
test('verified historical owner never excuses active or unknown runtime work',async()=>{
 const f=await setup();try {
  await f.run();const observation=await liveObservation(f);
  assert.equal(await deploymentOwnersIdle(f.c,observation.rows,observation),true);
  const state=await f.io.engine();assert.equal(runtimeOwnersIdle(state),true);
  for(const key of ['running','retrying']) {
   assert.equal(runtimeOwnersIdle({...state,[key]:['worker']}),false);
   assert.equal(runtimeOwnersIdle({...state,[key]:undefined}),false);
  }
  for(const key of ['running','retrying','claimed','blocked']) {
   assert.equal(runtimeOwnersIdle({...state,admission:{...state.admission,[key]:['owner']}}),false);
   assert.equal(runtimeOwnersIdle({...state,admission:{...state.admission,[key]:undefined}}),false);
  }
  assert.equal(runtimeOwnersIdle({...state,admission:{...state.admission,pending_dispatch:true}}),false);
 }finally{await f.clean();}
});

async function controllerSetup() {
 const f=await setup(),c=f.c;
 Object.assign(c,{profile:'controller-only-v2',originalIterations:2,originalLimit:3,externalIterations:1,controllerVersion:c.merge,controllerTree:c.tree,dataVolume:'live-data'});
 Object.assign(f.ledger,{iterations:2,reason:'Missing exact reviewed publication',events:[{role:'review',result:{status:'complete'}}]});
 const pin=async(name,value)=>{const path=f.paths[name] || join(f.root,name+'.json');f.paths[name]=path;await atomic(path,value);c.evidence[name]={path,hash:digest(await readFile(path))};};
 await pin('ledger',f.ledger);
 const scope={repo:c.repo,issue:c.issue,pr:c.pr,head:c.head,tree:c.tree};
 await pin('publishArtifact',{status:'complete',publication:{repo:c.repo,issue:Number(c.issue),pr:c.pr,base:c.base,head:sha(9)}});
 await pin('review',{kind:'controller-external-review-v2',...scope,status:'approved',model:'gpt-6-astra',reasoning:'high',fast:false,session:'independent-review'});
 await pin('tests',{kind:'controller-external-tests-v2',...scope,status:'passed',tests:400,failures:0,skipped:0,checks:['node','syntax','diff'].map(name=>({name,exit:0})),logHashes:{node:hex(1),syntax:hex(2),diff:hex(3)}});
 await pin('ownershipRequest',{ownershipVersion:1,authority:{observe:true},repo:c.repo,base:c.base,controllerVersion:c.merge,dataVolume:c.dataVolume});
 await pin('recovery',{kind:'controller-external-attempt-v2',...scope,status:'completed',originalUsed:2,limit:3,externalUsed:1,totalUsed:3,originalHead:sha(9),buildSession:'external-build',originalHashes:Object.fromEntries(['ledger','publishArtifact','launchJournal','manifest'].map(k=>[k,c.evidence[k].hash]))});
 const serviceEvidence={kernel:'11111111-1111-1111-1111-111111111111',services:['symphony','github-auth'].map((service,i)=>({service,id:i?hex(9):c.engineContainer,image:c.engineImage,runtimeHash:hex(i+1),mountHashes:[{type:'volume',destination:'/data',rw:true,identityHash:hex(i+1)}]}))};
 await pin('ownership',{kind:'deployment-ownership-v1',effects:'none',...scope,base:c.base,controllerVersion:c.merge,engine:c.engineContainer,engineImage:c.engineImage,dataVolume:c.dataVolume,sourceRequest:c.evidence.ownershipRequest,ledgerHashes:[{file:keyFor(c)+'.json',ledgerHash:c.evidence.ledger.hash,enrollmentHash:c.evidence.enrollment.hash}],serviceEvidence,manifestContract:digest(f.manifest),runtimeIdle:true,controllerLock:false});
 await pin('validation',{kind:'controller-install-v2',...scope,commit:c.merge,controllerVersion:c.merge,controllerTree:c.tree,status:'installed',engineUnchanged:true,engineContainer:c.engineContainer,engineImage:c.engineImage,ownershipHash:c.evidence.ownership.hash});
 f.io.installedController=async()=>({commit:c.merge,tree:c.tree});f.io.ownership=async()=>JSON.parse(await readFile(f.paths.ownership));f.pin=pin;
 return f;
}
async function interruptedReviewSetup({ordered=false}={}) {
 const f=await controllerSetup(),c=f.c;
 Object.assign(c,{profile:'controller-review-interrupted-v3',originalIterations:3,originalLimit:3,externalIterations:1,recoveryIterations:1,installation:{issue:'32',pr:33,head:sha(6),tree:sha(7),merge:sha(8)},controllerVersion:sha(8),controllerTree:sha(7)});c.authority.externalBudget=true;
 delete c.evidence.publishArtifact;
 const publication={repo:c.repo,issue:c.issue,pr:c.pr,base:c.base,head:sha(9),tree:sha(9),base_head:sha(0),generation:2};
 Object.assign(f.ledger,{iterations:3,stage:'review',active_session:{session_id:'interrupted-review',thread_id:'review-thread',turn_id:'review-turn'},events:[{role:'plan'},{role:'build',iteration:2,result:{status:'complete'},session:{session_id:'old-build'}},{role:'build',iteration:3,result:{status:'complete'},session:{session_id:'original-third-build'}}],publication,resume:{generation:2,publication}});delete f.ledger.reason;
 if(ordered)f.ledger.launch=Object.fromEntries(Object.entries(f.manifest).sort(([a],[b])=>a.localeCompare(b)));
 await f.pin('ledger',f.ledger);await f.pin('enrollment',f.ledger.launch);
 await f.pin('launchJournal',{contract:digest(f.manifest),dispatched:true,observed:true,blocker:'Issue has unresolved hold/action'});
 await f.pin('controllerJournal',{request:hex(7),publication,validation:{kind:'passed',head:publication.head,tree:publication.tree}});
 const originalHashes=Object.fromEntries(['ledger','enrollment','manifest','launchJournal','controllerJournal','gate'].map(k=>[k,c.evidence[k].hash]));
 const owner={issue:c.issue,pr:c.pr,head:c.head,tree:c.tree,merge:c.merge},scope={repo:c.repo,...owner},target={repo:c.repo,...c.installation};
 await f.pin('authorization',{kind:'operator-external-budget-v1',repo:c.repo,issue:Number(c.issue),pr:c.pr,source:'explicit-user-request',userRequest:'추가 1회 승인',originalUsed:3,originalLimit:3,externalLimit:1,totalLimit:4,originalHashes:{ledger:originalHashes.ledger,enrollment:originalHashes.enrollment,manifest:originalHashes.manifest,launch:originalHashes.launchJournal,host:originalHashes.controllerJournal}});
 await f.pin('recoveryAuthorization',{kind:'operator-followup-authorization-v1',issue:32,ownerIssue:Number(c.issue),source:'explicit-user-request',userRequest:'#32 복구 1회 승인',implementationLimit:1,originalOwnerUsage:{originalUsed:3,originalLimit:3,externalUsed:1}});
 const build={status:'completed',model:'gpt-6.1-sol',reasoning:'medium',fast:false};
 await f.pin('correction',{kind:'controller-review-interrupted-correction-v3',...scope,...build,buildSession:'owner-external-build',originalUsed:3,originalLimit:3,externalUsed:1,totalUsed:4,originalHashes,authorizationHash:c.evidence.authorization.hash,interruptedSession:f.ledger.active_session,publication});
 await f.pin('recovery',{kind:'controller-review-interrupted-attempt-v3',...target,...build,buildSession:'recovery-external-build',owner,execution:'external',implementationUsed:1,implementationLimit:1,originalOwnerUsage:{originalUsed:3,originalLimit:3,externalUsed:1},originalHashes,authorizationHash:c.evidence.recoveryAuthorization.hash,correctionHash:c.evidence.correction.hash});
 for(const [name,s,attempt] of [['review',scope,'owner-external-build'],['recoveryReview',target,'recovery-external-build']])await f.pin(name,{kind:'controller-review-interrupted-review-v3',...s,status:'approved',model:'gpt-6-astra',reasoning:'high',fast:false,buildSession:attempt,session:name+'-separate-session'});
 for(const [name,s] of [['tests',scope],['recoveryTests',target]])await f.pin(name,{kind:'controller-review-interrupted-tests-v3',...s,status:'passed',tests:444,failures:0,skipped:0,checks:['node','syntax','diff'].map(name=>({name,exit:0})),logHashes:{node:hex(1),syntax:hex(2),diff:hex(3)}});
 const request=JSON.parse(await readFile(f.paths.ownershipRequest));Object.assign(request,{issue:c.issue,controllerVersion:c.installation.merge,manifest:{status:'present',value:f.manifest}});await f.pin('ownershipRequest',request);
 const proof=JSON.parse(await readFile(f.paths.ownership));Object.assign(proof,{controllerVersion:c.installation.merge,sourceRequest:c.evidence.ownershipRequest,ledgerHashes:[{file:keyFor(c)+'.json',ledgerHash:c.evidence.ledger.hash,enrollmentHash:c.evidence.enrollment.hash}]});await f.pin('ownership',proof);
 await f.pin('validation',{kind:'controller-review-interrupted-install-v3',...target,owner,status:'installed',commit:c.installation.merge,controllerVersion:c.installation.merge,controllerTree:c.installation.tree,engineUnchanged:true,engineContainer:c.engineContainer,engineImage:c.engineImage,ownershipHash:c.evidence.ownership.hash});
 f.io.installedController=async()=>({commit:c.installation.merge,tree:c.installation.tree});
 const api=f.io.api;f.io.api=async(m,p)=>{
  if(p.endsWith('/issues/32')){f.calls.push({method:m,path:p});return {number:32,state:'open',labels:[]};}
  if(p.endsWith('/pulls/33')){f.calls.push({method:m,path:p});return {state:'closed',merged:true,merge_commit_sha:c.installation.merge,head:{sha:c.installation.head,repo:{full_name:c.repo}},base:{ref:c.base,repo:{full_name:c.repo}}};}
  if([c.installation.head,c.installation.merge].some(s=>p.endsWith('/git/commits/'+s))){f.calls.push({method:m,path:p});return {tree:{sha:c.installation.tree},parents:[{sha:c.installation.head}]};}
  return api(m,p);
 };
 return f;
}
test('interrupted review v3 with open non-ready recovery issue preserves original3+external1 and one recovery implementation',async()=>{
 const f=await interruptedReviewSetup();try {
  const before=await snapshot(f.root);const check=await reconcileExternal(f.c,f.io,{check:true});assert.equal(check.status,'eligible');assert.deepEqual(await snapshot(f.root),before);
  await f.run();const r=JSON.parse(await readFile(join(f.dir,'external-reconciliation.json')));
  assert.equal(r.v,3);assert.equal(r.binding.pr,21);assert.equal(r.binding.installation.pr,33);assert.equal(r.binding.originalIterations,3);assert.equal(r.binding.externalIterations,1);assert.equal(r.binding.recoveryIterations,1);assert.equal(r.controllerVersion,f.c.installation.merge);
  for(const name of ['ledger','enrollment','launchJournal','controllerJournal','gate'])assert.equal(digest(await readFile(f.paths[name])),before[f.paths[name].slice(f.root.length)]);
  assert.equal(JSON.parse(await readFile(f.paths.ledger)).stage,'review');
  for(const name of Object.keys(f.c.evidence))assert.equal(digest(await readFile(join(r.archive,name))),f.c.evidence[name].hash);
  const observation=await liveObservation(f);assert.equal(await verifiedExternalReceipt(f.c,keyFor(f.c)),true);assert.equal(await deploymentOwnersIdle(f.c,observation.rows,observation),true);
  await foreignOwners({...f.c,issue:'34'});const after=await snapshot(f.root);assert.equal((await f.run()).unchanged,true);assert.deepEqual(await snapshot(f.root),after);
  assert.ok(f.calls.some(x=>x.path.endsWith('/pulls/21')));assert.ok(f.calls.some(x=>x.path.endsWith('/pulls/33')));assert.ok(f.calls.every(x=>x.method==='GET'));
 }finally{await f.clean();}
});
test('interrupted review v3 accepts original manifest/enrollment key-order difference without changing bytes',async()=>{
 const f=await interruptedReviewSetup({ordered:true});try {
  assert.notEqual(digest(f.manifest),digest(f.ledger.launch));assert.deepEqual(f.manifest,f.ledger.launch);
  const ledger=await readFile(f.paths.ledger),enrollment=await readFile(f.paths.enrollment),manifest=await readFile(f.paths.manifest);
  await f.run();assert.deepEqual(await readFile(f.paths.ledger),ledger);assert.deepEqual(await readFile(f.paths.enrollment),enrollment);
  const r=JSON.parse(await readFile(join(f.dir,'external-reconciliation.json')));assert.deepEqual(await readFile(join(r.archive,'manifest')),manifest);assert.equal(await verifiedExternalReceipt(f.c,keyFor(f.c)),true);
 }finally{await f.clean();}
});
for(const phase of ['intent','fence-written','fenced','manifest-retired','gate-restored','receipt'])test('interrupted review v3 retains existing crash checkpoint '+phase,async()=>{
 const f=await interruptedReviewSetup();try {
  let failed=false;f.io.checkpoint=async p=>{if(p===phase&&!failed){failed=true;throw Error('crash');}};
  await assert.rejects(f.run(),/crash/);await f.run();assert.equal(await verifiedExternalReceipt(f.c,keyFor(f.c)),true);
  assert.deepEqual(JSON.parse(await readFile(f.paths.gate)),f.gate);
 }finally{await f.clean();}
});
const editEvidence=async(f,name,change)=>{const value=JSON.parse(await readFile(f.paths[name]));change(value);await f.pin(name,value);};
for(const [name,change] of [
 ['blocked stage',f=>editEvidence(f,'ledger',x=>{x.stage='blocked';})],
 ['wrong original count',f=>{f.c.originalIterations=2;}],['extra owner correction',f=>{f.c.externalIterations=2;}],['extra recovery implementation',f=>{f.c.recoveryIterations=2;}],
 ['missing active session',f=>editEvidence(f,'ledger',x=>{delete x.active_session;})],
 ['completed active session',f=>editEvidence(f,'ledger',x=>{x.active_session.session_id='original-third-build';})],
 ['completed review instead of last build',f=>editEvidence(f,'ledger',x=>{x.events.at(-1).role='review';})],
 ['wrong last build iteration',f=>editEvidence(f,'ledger',x=>{x.events.at(-1).iteration=2;})],
 ['changed publication',f=>editEvidence(f,'ledger',x=>{x.publication.pr=99;})],
 ['changed controller publication',f=>editEvidence(f,'controllerJournal',x=>{x.publication.head=sha(4);})],
 ['manufactured enrollment',f=>editEvidence(f,'enrollment',x=>{x.limit=2;})],
 ['completed launch',f=>editEvidence(f,'launchJournal',x=>{x.done=true;})],
 ['different launch blocker',f=>editEvidence(f,'launchJournal',x=>{x.blocker='different';})],
 ['absent controller journal',f=>{f.c.evidence.controllerJournal.hash=null;}],
 ['owner authorization source',f=>editEvidence(f,'authorization',x=>{x.source='label';})],
 ['owner authorization hash',f=>editEvidence(f,'authorization',x=>{x.originalHashes.host=hex(9);})],
 ['recovery authorization owner',f=>editEvidence(f,'recoveryAuthorization',x=>{x.ownerIssue=99;})],
 ['recovery authorization allocation',f=>editEvidence(f,'recoveryAuthorization',x=>{x.implementationLimit=2;})],
 ['missing external authority',f=>{f.c.authority.externalBudget=false;}],
 ['owner correction counter',f=>editEvidence(f,'correction',x=>{x.externalUsed=2;})],
 ['owner correction session',f=>editEvidence(f,'correction',x=>{x.interruptedSession.turn_id='other';})],
 ['recovery uses runner',f=>editEvidence(f,'recovery',x=>{x.execution='runner';})],
 ['recovery used count',f=>editEvidence(f,'recovery',x=>{x.implementationUsed=0;})],
 ['recovery wrong owner',f=>editEvidence(f,'recovery',x=>{x.owner.pr=99;})],
 ['review wrong owner head',f=>editEvidence(f,'review',x=>{x.head=sha(4);})],
 ['review wrong recovery head',f=>editEvidence(f,'recoveryReview',x=>{x.head=sha(4);})],
 ['recovery self review',f=>editEvidence(f,'recoveryReview',x=>{x.session='recovery-external-build';})],
 ['failed owner tests',f=>editEvidence(f,'tests',x=>{x.failures=1;})],
 ['skipped recovery tests',f=>editEvidence(f,'recoveryTests',x=>{x.skipped=1;})],
 ['installed owner instead of recovery',f=>{f.io.installedController=async()=>({commit:f.c.merge,tree:f.c.tree});}],
 ['installation tuple equals owner',f=>{f.c.installation={issue:f.c.issue,pr:f.c.pr,head:f.c.head,tree:f.c.tree,merge:f.c.merge};}],
 ['installation proof uses owner merge',f=>editEvidence(f,'validation',x=>{x.commit=f.c.merge;})],
 ['ownership request uses owner controller',f=>editEvidence(f,'ownershipRequest',x=>{x.controllerVersion=f.c.merge;})],
 ['stale live ledger',f=>{const own=f.io.ownership;f.io.ownership=async()=>({...await own(),ledgerHashes:[]});}],
 ['changed live auth',f=>{const own=f.io.ownership;f.io.ownership=async()=>({...await own(),serviceEvidence:{kernel:'changed',services:[]}});}],
 ['active workers',f=>{f.workers=false;}],
 ['foreign owner',async f=>atomic(join(f.c.ledgerRoot,hex(9)+'.json'),{stage:'review',in_flight:true})],
 ['foreign controller lock',async f=>atomic(join(f.dir,'lock'),{pid:999})],
 ...['momoflow:ready','momoflow:needs-decision','momoflow:needs-review'].map(label=>['recovery issue '+label,f=>{
  const api=f.io.api;f.io.api=async(m,p)=>p.endsWith('/issues/32')?{...await api(m,p),labels:[{name:label}]}:api(m,p);
 }]),
 ['open owner issue',f=>{const api=f.io.api;f.io.api=async(m,p)=>p.endsWith('/issues/1')?{...await api(m,p),state:'open'}:api(m,p);}],
 ...['owner','recovery'].flatMap(which=>['head','tree','merge'].map(field=>[which+' remote '+field,f=>{
  const api=f.io.api,t=which==='owner'?f.c:f.c.installation;
  f.io.api=async(m,p)=>{
   const r=await api(m,p);
   if(field==='head'&&p.endsWith('/pulls/'+t.pr))return {...r,head:{sha:sha(4),repo:{full_name:f.c.repo}}};
   if(field==='tree'&&p.endsWith('/git/commits/'+t.head))return {...r,tree:{sha:sha(4)}};
   if(field==='merge'&&p.endsWith('/pulls/'+t.pr))return {...r,merge_commit_sha:sha(4)};
   return r;
  };
 }]))
])test('interrupted review v3 rejects '+name+' before effects',async()=>{
 const f=await interruptedReviewSetup();try{await change(f);const before=await snapshot(f.root);await assert.rejects(f.run());assert.deepEqual(await snapshot(f.root),before);}finally{await f.clean();}
});
for(const name of ['ledger','enrollment','launchJournal','controllerJournal','authorization','recoveryAuthorization','correction','recovery','review','recoveryReview','tests','recoveryTests','ownership','ownershipRequest'])for(const location of ['source','archive'])test('interrupted review receipt rejects changed '+location+' '+name,async()=>{
 const f=await interruptedReviewSetup();try {
  await f.run();const r=JSON.parse(await readFile(join(f.dir,'external-reconciliation.json'))),path=location==='source'?f.paths[name]:join(r.archive,name);
  await rm(path);await writeFile(path,'changed',{mode:0o600});await assert.rejects(verifiedExternalReceipt(f.c,keyFor(f.c)),/bytes changed/);
 }finally{await f.clean();}
});
test('versioned controller completion preserves numeric publish failure and shared2+1 budget without a deployment record',async()=>{
 const f=await controllerSetup();try {
  const original=digest(await readFile(f.paths.ledger)),artifact=digest(await readFile(f.paths.publishArtifact));
  const before=await snapshot(f.root);assert.equal((await reconcileExternal(f.c,f.io,{check:true})).status,'eligible');assert.deepEqual(await snapshot(f.root),before);
  await f.run();const receipt=JSON.parse(await readFile(join(f.dir,'external-reconciliation.json')));
  assert.equal(receipt.v,2);assert.equal(receipt.binding.originalLimit,3);assert.equal(receipt.binding.originalIterations+receipt.binding.externalIterations,3);
  assert.equal(digest(await readFile(f.paths.ledger)),original);assert.equal(digest(await readFile(f.paths.publishArtifact)),artifact);
  assert.equal(JSON.parse(await readFile(f.paths.publishArtifact)).publication.issue,1);
  assert.equal(await verifiedExternalReceipt({...f.c,controllerVersion:sha(8),engineContainer:hex(8),engineImage:'sha256:'+hex(8)},keyFor(f.c)),true);
  await atomic(f.paths.manifest,{issue:'another-scope'});assert.equal(await verifiedExternalReceipt(f.c,keyFor(f.c)),true);
 }finally{await f.clean();}
});
for(const phase of ['intent','fence-written','fenced','manifest-retired','gate-restored','receipt'])test('controller-only retry is safe after '+phase,async()=>{
 const f=await controllerSetup();try {
  let failed=false;f.io.checkpoint=async p=>{if(p===phase&&!failed){failed=true;throw Error('crash');}};
  await assert.rejects(f.run(),/crash/);await f.run();assert.equal(await verifiedExternalReceipt(f.c,keyFor(f.c)),true);
 }finally{await f.clean();}
});
for(const [name,change] of [
 ['extra external build',f=>{f.c.externalIterations=2;}],['different limit',f=>{f.c.originalLimit=4;}],
 ['unknown profile',f=>{f.c.profile='blocked-anything';}],['wrong installed controller',f=>{f.io.installedController=async()=>({commit:sha(8),tree:f.c.tree});}],
 ['stale live ledger',f=>{const own=f.io.ownership;f.io.ownership=async()=>({...await own(),ledgerHashes:[]});}],
 ['changed auth runtime',f=>{const own=f.io.ownership;f.io.ownership=async()=>({...await own(),serviceEvidence:{kernel:'changed',services:[]}});}],
 ['synthetic fixed publication',async f=>{const a=JSON.parse(await readFile(f.paths.publishArtifact));a.publication.issue=f.c.issue;await f.pin('publishArtifact',a);}],
 ['stale reviewed head',async f=>{const r=JSON.parse(await readFile(f.paths.review));r.head=sha(8);await f.pin('review',r);}],
 ['failed external tests',async f=>{const r=JSON.parse(await readFile(f.paths.tests));r.failures=1;await f.pin('tests',r);}],
 ['build self-review',async f=>{const r=JSON.parse(await readFile(f.paths.review));r.session='external-build';await f.pin('review',r);}],
])test('controller profile blocks '+name+' without effects',async()=>{
 const f=await controllerSetup();try {await change(f);const before=await snapshot(f.root);await assert.rejects(f.run());assert.deepEqual(await snapshot(f.root),before);}finally{await f.clean();}
});

async function extendedControllerSetup() {
 const f=await controllerSetup(),c=f.c;c.externalIterations=2;c.externalBudget={externalLimit:2,totalLimit:4};c.authority.externalBudget=true;
 await f.pin('authorization',{kind:'controller-external-budget-v1',profile:c.profile,repo:c.repo,issue:c.issue,pr:c.pr,originalIterations:2,originalLimit:3,externalLimit:2,totalLimit:4,source:'explicit-user-request',userRequest:'Complete this recovery with the necessary additional scoped budget.',operator:'test-operator',originalHashes:Object.fromEntries(['ledger','publishArtifact','launchJournal','manifest'].map(k=>[k,c.evidence[k].hash]))});
 const recovery=JSON.parse(await readFile(f.paths.recovery));recovery.externalUsed=2;recovery.totalUsed=4;await f.pin('recovery',recovery);return f;
}
test('explicit scoped external allocation preserves original2of3 while recording actual total4',async()=>{
 const f=await extendedControllerSetup();try {
  const ledger=await readFile(f.paths.ledger);assert.equal((await reconcileExternal(f.c,f.io,{check:true})).status,'eligible');await f.run();
  assert.deepEqual(await readFile(f.paths.ledger),ledger);const r=JSON.parse(await readFile(join(f.dir,'external-reconciliation.json')));
  assert.equal(r.binding.originalIterations,2);assert.equal(r.binding.originalLimit,3);assert.equal(r.binding.externalIterations,2);assert.equal(r.binding.externalBudget.totalLimit,4);
  assert.equal(await verifiedExternalReceipt(f.c,keyFor(f.c)),true);await f.run();
 }finally{await f.clean();}
});
for(const [name,change] of [
 ['missing config authority',f=>{delete f.c.authority.externalBudget;}],
 ['allocation exceeded',f=>{f.c.externalIterations=3;}],
 ['unbounded allocation',f=>{f.c.externalBudget.externalLimit=Infinity;}],
 ['allocation total mismatch',f=>{f.c.externalBudget.totalLimit=5;}],
 ['wrong authorization issue',async f=>{const a=JSON.parse(await readFile(f.paths.authorization));a.issue='999';await f.pin('authorization',a);}],
 ['wrong original bytes',async f=>{const a=JSON.parse(await readFile(f.paths.authorization));a.originalHashes.ledger=hex(9);await f.pin('authorization',a);}],
 ['missing user authority',async f=>{const a=JSON.parse(await readFile(f.paths.authorization));a.source='label';await f.pin('authorization',a);}],
 ['wrong authorized allocation',async f=>{const a=JSON.parse(await readFile(f.paths.authorization));a.externalLimit=3;await f.pin('authorization',a);}],
 ['false external used count',async f=>{const a=JSON.parse(await readFile(f.paths.recovery));a.externalUsed=1;await f.pin('recovery',a);}],
])test('external budget rejects '+name+' before effects',async()=>{
 const f=await extendedControllerSetup();try{await change(f);const before=await snapshot(f.root);await assert.rejects(f.run());assert.deepEqual(await snapshot(f.root),before);}finally{await f.clean();}
});

test('historical helper RO source allowlist derives only from fully verified receipt and archive bytes',async()=>{
 const f=await setup();try {
  await f.run();const c={...f.c,issue:'24'};
  assert.deepEqual(await historicalReceiptEvidence(c),[f.c.evidence.recovery,f.c.evidence.validation].sort((a,b)=>a.path.localeCompare(b.path)));
  await writeFile(f.paths.recovery,'stale source');await assert.rejects(historicalReceiptEvidence(c));
 }finally{await f.clean();}
});
test('helper historical source mounts retain exact Source, RO and filesystem proof',async()=>{
 const f=operatorFixture(),path='/historical/recovery.json',m={Type:'bind',Source:path,Destination:path,RW:false};
 f.historical=[{path,hash:hex(1)}];f.operator.Mounts.push(m);f.context.mounted.set(m,{identity:path});await f.verify();
 m.RW=true;await assert.rejects(f.verify(),/source\/authority/);m.RW=false;
 m.Source='/copy';await assert.rejects(f.verify(),/source\/authority/);m.Source=path;
 f.context.mounted.set(m,{identity:'/copied-object'});await assert.rejects(f.verify(),/correspondence/);
});

// Observed original GH24 orders: active.json v/id/repo/issue/base/limit;
// ledger.launch base/id/issue/limit/repo/v. They are equal objects, different JSON.
test('original manifest proof survives the exact real ledger key-order difference',async()=>{
 const f=await controllerSetup();try {
  assert.deepEqual(Object.keys(f.manifest),['v','id','repo','issue','base','limit']);
  f.ledger.launch=Object.fromEntries(Object.entries(f.manifest).sort(([a],[b])=>a.localeCompare(b)));
  assert.deepEqual(Object.keys(f.ledger.launch),['base','id','issue','limit','repo','v']);
  assert.notEqual(digest(f.manifest),digest(f.ledger.launch));assert.deepEqual(f.manifest,f.ledger.launch);
  await f.pin('ledger',f.ledger);
  const r=JSON.parse(await readFile(f.paths.recovery));r.originalHashes.ledger=f.c.evidence.ledger.hash;await f.pin('recovery',r);
  const o=JSON.parse(await readFile(f.paths.ownership));o.ledgerHashes[0].ledgerHash=f.c.evidence.ledger.hash;await f.pin('ownership',o);
  const v=JSON.parse(await readFile(f.paths.validation));v.ownershipHash=f.c.evidence.ownership.hash;await f.pin('validation',v);
  const originals=await Promise.all(['ledger','manifest'].map(k=>readFile(f.paths[k])));
  assert.equal((await reconcileExternal(f.c,f.io,{check:true})).status,'eligible');await f.run();
  assert.deepEqual(await readFile(f.paths.ledger),originals[0]);assert.equal(await verifiedExternalReceipt(f.c,keyFor(f.c)),true);
  const receipt=JSON.parse(await readFile(join(f.dir,'external-reconciliation.json')));assert.deepEqual(await readFile(join(receipt.archive,'manifest')),originals[1]);
 }finally{await f.clean();}
});
test('original manifest content differences remain rejected before effects',async()=>{
 const f=await controllerSetup();try {
  f.ledger.launch={...f.manifest,id:hex(9)};await f.pin('ledger',f.ledger);const before=await snapshot(f.root);
  await assert.rejects(f.run(),/Exact interrupted runner history/);assert.deepEqual(await snapshot(f.root),before);
 }finally{await f.clean();}
});
async function correctiveControllerSetup() {
 const f=await extendedControllerSetup(),c=f.c,originalPr=c.pr,api=f.io.api;
 Object.assign(c,{originalPr,pr:27,head:sha(6),tree:sha(7),merge:sha(8),controllerVersion:sha(8),controllerTree:sha(7),externalIterations:3,externalBudget:{externalLimit:3,totalLimit:5}});
 f.io.api=(method,path)=>api(method,path.replace('/pulls/27','/pulls/21'));
 for(const name of ['recovery','review','tests','validation']) {
  const record=JSON.parse(await readFile(f.paths[name]));Object.assign(record,{pr:c.pr,head:c.head,tree:c.tree});
  if(name==='recovery')Object.assign(record,{originalPr,externalUsed:3,totalUsed:5});
  if(name==='validation')Object.assign(record,{commit:c.merge,controllerVersion:c.merge,controllerTree:c.tree});
  await f.pin(name,record);
 }
 const request=JSON.parse(await readFile(f.paths.ownershipRequest));request.controllerVersion=c.merge;await f.pin('ownershipRequest',request);
 const proof=JSON.parse(await readFile(f.paths.ownership));Object.assign(proof,{pr:c.pr,head:c.head,tree:c.tree,controllerVersion:c.merge,sourceRequest:c.evidence.ownershipRequest});await f.pin('ownership',proof);
 const install=JSON.parse(await readFile(f.paths.validation));install.ownershipHash=c.evidence.ownership.hash;await f.pin('validation',install);
 const auth=JSON.parse(await readFile(f.paths.authorization));Object.assign(auth,{pr:c.pr,originalPr,externalLimit:3,totalLimit:5});await f.pin('authorization',auth);
 return f;
}
test('corrective PR completion binds final reviewed and installed scope separately from original publication',async()=>{
 const f=await correctiveControllerSetup();try {
  const artifact=await readFile(f.paths.publishArtifact);await f.run();const r=JSON.parse(await readFile(join(f.dir,'external-reconciliation.json')));
  assert.equal(r.binding.originalPr,21);assert.equal(r.binding.pr,27);assert.equal(r.binding.externalIterations,3);assert.equal(r.binding.externalBudget.totalLimit,5);
  assert.deepEqual(await readFile(f.paths.publishArtifact),artifact);assert.equal(JSON.parse(artifact).publication.pr,21);
  assert.equal(await verifiedExternalReceipt(f.c,keyFor(f.c)),true);
 }finally{await f.clean();}
});
for(const [name,change] of [
 ['wrong original PR',f=>{f.c.originalPr=22;}],['missing original PR',f=>{delete f.c.originalPr;}],
 ['wrong attempt original PR',async f=>{const r=JSON.parse(await readFile(f.paths.recovery));r.originalPr=22;await f.pin('recovery',r);}],
 ['wrong authorization original PR',async f=>{const r=JSON.parse(await readFile(f.paths.authorization));r.originalPr=22;await f.pin('authorization',r);}],
 ['review of original instead of final PR',async f=>{const r=JSON.parse(await readFile(f.paths.review));r.pr=f.c.originalPr;await f.pin('review',r);}],
 ['installation of original instead of corrective merge',async f=>{const r=JSON.parse(await readFile(f.paths.validation));r.commit=sha(3);await f.pin('validation',r);}],
])test('corrective completion rejects '+name+' before effects',async()=>{
 const f=await correctiveControllerSetup();try{await change(f);const before=await snapshot(f.root);await assert.rejects(f.run());assert.deepEqual(await snapshot(f.root),before);}finally{await f.clean();}
});

// Exercise the executable module, production ports and dynamic deploy import in a
// fresh Node process. External commands/fetch/kernel mount table are simulated;
// config, original evidence, permissions and source imports are real. No Docker.
test('real CLI module lifecycle completes ownership dependency and read-only check',async()=>{
 const f=await controllerSetup();try {
  const {stat}=await import('node:fs/promises'),{fileURLToPath}=await import('node:url');
  const {runtimeIdentity}=await import('./deploy.mjs'),{command}=await import('./post-pr-docker.mjs');
  const c=f.c;c.trustedRoot=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'');c.verifyMs=1000;
  c.runnerSource=digest(await readFile(join(c.trustedRoot,'engine/role_runner.ex')));
  await writeFile(c.tokenFile,JSON.stringify({token:'simulated-test-token',expires_at:new Date(Date.now()+3600000).toISOString()}),{mode:0o600});
  const data=join(f.root,'data'),auth=join(f.root,'auth');await mkdir(data);await mkdir(auth);
  const bind={Type:'bind',Source:c.launchRoot,Destination:'/run/momoflow-launch',RW:false};
  const engine={Id:c.engineContainer,Image:c.engineImage,State:{Running:true,Health:{Status:'healthy'}},Config:{Labels:{'com.docker.compose.project':c.productionProject,'com.docker.compose.service':'symphony'}},HostConfig:{},Mounts:[{Type:'volume',Name:c.dataVolume,Source:'/daemon/data',Destination:'/data',RW:true},bind]};
  const authContainer={Id:hex(9),Image:'sha256:'+hex(9),State:{Running:true,Health:{Status:'healthy'}},Config:{Labels:{'com.docker.compose.project':c.productionProject,'com.docker.compose.service':'github-auth'}},HostConfig:{},Mounts:[{Type:'volume',Name:'live-auth',Source:'/daemon/auth',Destination:'/run/momoflow-auth',RW:false}]};
  const all={symphony:engine,'github-auth':authContainer},boot=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),s=await stat(f.root,{bigint:true}),n=s.dev;
  const device=`${((n>>8n)&0xfffn)|((n>>32n)&0xfffff000n)}:${(n&0xffn)|((n>>12n)&0xffffff00n)}`;
  const probes={},services=[];
  for(const [service,x] of Object.entries(all).sort(([a],[b])=>a.localeCompare(b))) {
   const points=[],rows=[],mountHashes=[];
   for(const [i,m] of x.Mounts.entries()) {
    const path=m===bind?c.launchRoot:m.Name===c.dataVolume?data:auth,st=await stat(path,{bigint:true});
    points.push({path:m.Destination,dev:String(st.dev),ino:String(st.ino)});
    rows.push(`${i+1} 0 ${device} ${path} ${m.Destination} rw - ext4 /dev/simulated rw`);
    mountHashes.push({type:m.Type,destination:m.Destination,rw:m.RW,identityHash:digest({device,path,inode:String(st.ino)})});
   }
   probes[x.Id]={boot,mountinfo:rows.join('\n'),points};const r=runtimeIdentity(x);
   services.push({service,id:x.Id,image:x.Image,runtimeHash:digest({...r,mounts:r.mounts.map(m=>m.type==='bind'?{...m,source:null}:m)}),mountHashes:mountHashes.sort((a,b)=>a.destination.localeCompare(b.destination))});
  }
  const request={ownershipVersion:1,authority:{observe:true},hold:false,repo:c.repo,issue:c.issue,base:c.base,controllerVersion:c.merge,project:c.productionProject,dataVolume:c.dataVolume,engineURL:c.engineURL,verifyMs:1000,current:{commit:c.merge,image:c.engineImage,authImage:authContainer.Image,runnerSource:c.runnerSource,composeHash:hex(1),composeFile:'/operator/compose.json',files:{'/operator/compose.json':hex(1)},inspect:{symphony:{},'github-auth':{}}}};
  for(const k of ['stateRoot','inboxRoot','launchRoot','gateRoot','trustedRoot','ledgerRoot','tokenFile'])request[k]=c[k];
  await f.pin('ownershipRequest',request);
  const proof=JSON.parse(await readFile(f.paths.ownership));Object.assign(proof,{sourceRequest:c.evidence.ownershipRequest,serviceEvidence:{kernel:boot,services}});await f.pin('ownership',proof);
  const install=JSON.parse(await readFile(f.paths.validation));install.ownershipHash=c.evidence.ownership.hash;await f.pin('validation',install);
  const observation={rows:[{file:keyFor(c)+'.json',bytes:(await readFile(f.paths.ledger)).toString('base64'),enrollment:(await readFile(f.paths.enrollment)).toString('base64')}],manifest:f.manifest};
  const state=await f.io.engine(),api={};
  for(const path of [`/repos/${c.repo}/issues/${c.issue}`,`/repos/${c.repo}/pulls/${c.pr}`,`/repos/${c.repo}/git/commits/${c.head}`,`/repos/${c.repo}/git/commits/${c.merge}`,`/repos/${c.repo}/issues?state=open&labels=momoflow%3Aready&per_page=100`])api[path]=await f.io.api('GET',path);
  const configFile=join(f.root,'cli-config.json'),fixtureFile=join(f.root,'cli-fixture.json'),preload=join(f.root,'cli-preload.mjs'),trace=join(f.root,'cli-trace.jsonl');
  await writeFile(configFile,JSON.stringify(c),{mode:0o600});
  await writeFile(fixtureFile,JSON.stringify({all,probes,observation,state,api,merge:c.merge,tree:c.tree,mountinfo:`1 0 ${device} / / rw - ext4 /dev/simulated rw\n`,trace}));
  await writeFile(preload,`import fs from 'node:fs/promises';import syncfs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const fixture=JSON.parse(await fs.readFile(${JSON.stringify(fixtureFile)},'utf8')),read=fs.readFile,lstat=fs.lstat;
fs.readFile=async(path,...args)=>path==='/proc/self/mountinfo'?fixture.mountinfo:read(path,...args);
fs.lstat=async(path,...args)=>{if(path==='/.dockerenv')throw Object.assign(Error('simulated host'),{code:'ENOENT'});return lstat(path,...args);};
const trace=x=>syncfs.appendFileSync(fixture.trace,JSON.stringify(x)+'\\n');
// Nested Node asynchronous stdio can be lost on this host; capture console calls
// synchronously while retaining the real command process/pipe/close lifecycle.
console.log=(...a)=>syncfs.writeSync(1,a.join(' ')+'\\n');console.error=(...a)=>syncfs.writeSync(2,a.join(' ')+'\\n');
const originalSpawn=cp.spawn;
cp.spawn=(file,args,options)=>{try {trace({file,args});let value;
if(file==='git')value=args.includes('status')?'':args.includes('HEAD^{tree}')?fixture.merge+'\\n'+fixture.tree:fixture.merge;
else if(file==='docker') {
 if(args[0]==='ps')value=Object.values(fixture.all).map(x=>JSON.stringify({ID:x.Id})).join('\\n');
 else if(args[0]==='inspect') {const x=Object.values(fixture.all).find(x=>x.Id===args.at(-1));if(!x)throw Error('unknown inspect');value=JSON.stringify(args.includes('--format')?x.Mounts:[x]);}
 else if(args[0]==='exec') {if(fixture.failExec)throw Error('simulated observation unavailable');value=JSON.stringify(args[4].includes('const paths=JSON.parse')?fixture.probes[args[1]]:fixture.observation);}
 else if(args[0]==='top')value='PID COMMAND\\n1 beam.smp\\n';
 else throw Error('unexpected Docker effect');
} else throw Error('unexpected command');
return originalSpawn(process.execPath,['-e','require("fs").writeSync(1,'+JSON.stringify(value)+')'],options);
}catch(e){return originalSpawn(process.execPath,['-e','require("fs").writeSync(2,'+JSON.stringify(e.message)+');process.exit(1)'],options);}};
globalThis.fetch=async url=>{trace({url:String(url)});return {ok:true,status:200,json:async()=>String(url).includes('/api/v1/state')?fixture.state:fixture.api[new URL(url).pathname+new URL(url).search]};};syncBuiltinESMExports();`);
  const before=await snapshot(f.root),result=await command(process.execPath,['--import',preload,join(c.trustedRoot,'scripts/reconcile-external.mjs'),configFile,'--check'],{timeout:15000});
  assert.equal(result.exit,0,result.output.toString());assert.ok(result.output.length,'CLI must emit its read-only result');assert.equal(JSON.parse(result.output).status,'eligible');assert.equal(JSON.parse(result.output).effects,'none');
  const calls=(await readFile(trace,'utf8')).trim().split('\n').map(x=>JSON.parse(x));assert.ok(calls.some(x=>x.args?.[0]==='exec'));
  assert.ok(calls.some(x=>x.url?.startsWith('https://api.github.com/')),'must proceed beyond ownership module observation');
  const after=await snapshot(f.root);delete after['/cli-trace.jsonl'];assert.deepEqual(after,before);
  const broken=JSON.parse(await readFile(fixtureFile));broken.failExec=true;await writeFile(fixtureFile,JSON.stringify(broken));
  const failed=await command(process.execPath,['--import',preload,join(c.trustedRoot,'scripts/reconcile-external.mjs'),configFile,'--check'],{timeout:15000});
  assert.equal(failed.exit,1,failed.output.toString());assert.match(failed.output.toString(),/observation unavailable|metadata probe unavailable/);assert.doesNotMatch(failed.output.toString(),/unsettled top-level await/);
  const failedAfter=await snapshot(f.root);delete failedAfter['/cli-trace.jsonl'];delete failedAfter['/cli-fixture.json'];delete before['/cli-fixture.json'];assert.deepEqual(failedAfter,before);
 }finally{await f.clean();}
});
