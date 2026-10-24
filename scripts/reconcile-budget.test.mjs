// Real files/modules/archives; all GitHub, native model metadata, Docker and worker states are simulated.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm,lstat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {budgetFixture} from './reconcile-budget-fixture.mjs';
import {digest,keyFor,atomic} from './post-pr.mjs';
import {reconcileExternal,verifiedExternalReceipt,foreignOwners,historicalReceiptEvidence} from './reconcile-external.mjs';
import {deploymentOwnersIdle} from './deploy.mjs';
import {budgetExtraMounts,budgetSourceChecks} from './reconcile-budget.mjs';
async function files(root) {
 const rows={};async function scan(p){for(const e of await readdir(p,{withFileTypes:true})){const q=join(p,e.name);if(e.isDirectory())await scan(q);else rows[q.slice(root.length)]=digest(await readFile(q));}}await scan(root);return rows;
}
async function replace(f,name,mutate) {
 const ref=f.c.evidence[name],value=JSON.parse(await readFile(ref.path));mutate(value);await atomic(ref.path,value);
 f.c.evidence[name]={...ref,hash:digest(await readFile(ref.path))};
 if(['ledger','enrollment','launchJournal','gate','manifest'].includes(name)) {
  await replace(f,'originalIndex',x=>{x[name].hash=f.c.evidence[name].hash;});
  await replace(f,'recovery',x=>{x.originalHashes[name]=f.c.evidence[name].hash;});
 }
}
test('v4 preparation/check/apply/duplicate preserve normal-stop bytes and distinguish3+2+1 with open nonready owner',async()=>{
 const f=await budgetFixture();try {
  const before=await files(f.root);assert.equal((await f.prepare()).id,f.prepared.id);assert.deepEqual(await files(f.root),before);
  assert.equal((await reconcileExternal(f.c,f.io,{check:true})).effects,'none');assert.deepEqual(await files(f.root),before);
  await assert.rejects(foreignOwners({...f.c,issue:'99'}),/journal/);
  const result=await f.run();assert.equal(result.status,'externally-reconciled');
  const receipt=JSON.parse(await readFile(join(f.dir,'external-reconciliation.json')));assert.equal(receipt.v,4);
  assert.equal(receipt.binding.originalIterations,3);assert.equal(receipt.binding.externalIterations,2);assert.equal(receipt.binding.recoveryIterations,1);
  for(const name of ['ledger','enrollment','launchJournal','gate'])assert.equal(digest(await readFile(f.paths[name])),before[f.paths[name].slice(f.root.length)]);
  await assert.rejects(lstat(f.paths.controllerJournal),{code:'ENOENT'});await assert.rejects(lstat(f.paths.manifest),{code:'ENOENT'});
  assert.equal(await verifiedExternalReceipt(f.c,keyFor(f.c)),true);await foreignOwners({...f.c,issue:'99'});
  const rows=[{file:keyFor(f.c)+'.json',bytes:(await readFile(f.paths.ledger)).toString('base64'),enrollment:(await readFile(f.paths.enrollment)).toString('base64')}];
  assert.equal(await deploymentOwnersIdle(f.c,rows,{rows,manifest:null}),true);
  const after=await files(f.root),calls=f.calls.length;assert.equal((await f.run()).unchanged,true);assert.deepEqual(await files(f.root),after);assert.equal(f.calls.length,calls);
  // Historical ownership remains historical after a later legitimate controller/engine upgrade.
  const later={...f.c,controllerVersion:'f'.repeat(40),engineContainer:'e'.repeat(64),engineImage:'sha256:'+'d'.repeat(64),runnerSource:'c'.repeat(64)};
  await writeFile(JSON.parse(await readFile(f.paths.ownershipRequest)).current.composeFile,'a future bundle at the original live path');
  assert.equal(await verifiedExternalReceipt(later,keyFor(f.c)),true);assert.ok((await historicalReceiptEvidence({...later,issue:'99'})).length>20);
 }finally{await f.clean();}
});
for(const phase of ['intent','fence-written','fenced','manifest-retired','gate-restored','receipt'])test('v4 identical request resumes crash at '+phase,async()=>{
 const f=await budgetFixture();try {
  const original=await readFile(f.paths.ledger);let crashed=false;
  f.io.checkpoint=async name=>{if(name===phase&&!crashed){crashed=true;throw Error('simulated crash');}};
  await assert.rejects(f.run(),/simulated crash/);assert.equal(crashed,true);
  await f.run();assert.equal(await verifiedExternalReceipt(f.c,keyFor(f.c)),true);assert.deepEqual(await readFile(f.paths.ledger),original);assert.deepEqual(JSON.parse(await readFile(f.paths.gate)),f.gate);
  await assert.rejects(lstat(f.paths.controllerJournal),{code:'ENOENT'});
 }finally{await f.clean();}
});
for(const [name,change]of[
 ['wrong final review',f=>replace(f,'ledger',x=>{x.events.at(-1).result.status='complete';})],
 ['wrong reason',f=>replace(f,'ledger',x=>{x.reason='some other stop';})],
 ['active session',f=>replace(f,'ledger',x=>{x.active_session={thread_id:'active'};})],
 ['in flight',f=>replace(f,'ledger',x=>{x.in_flight=true;})],
 ['publication',f=>replace(f,'ledger',x=>{x.publication={pr:21};})],
 ['count changed',f=>replace(f,'ledger',x=>{x.iterations=2;})],
 ['new host journal',f=>atomic(f.paths.controllerJournal,{done:true})],
 ['limit changed',f=>{f.c.originalLimit=2;}],
 ['correction count changed',f=>{f.c.externalIterations=3;}],
 ['recovery count changed',f=>{f.c.recoveryIterations=2;}],
 ['authority changed',f=>{f.c.authority.externalBudget=false;}],
 ['authorization changed',f=>replace(f,'authorization',x=>{x.externalCorrectionTotalLimit=3;})],
 ['recovery authorization changed',f=>replace(f,'recoveryAuthorization',x=>{x.implementationLimit=2;})],
 ['native model changed',async f=>{const r=f.c.evidence.buildNative,b=(await readFile(r.path,'utf8')).replaceAll('gpt-6.1-sol','wrong-model');await writeFile(r.path,b);r.hash=digest(b);}],
 ['native turn reused',f=>replace(f,'recovery',x=>{x.turns.recovery.build=x.turns.owner.build;})],
 ['invented Fast enforcement',f=>replace(f,'review',x=>{x.fastOffRuntimeProven=true;})],
 ['wrong installed controller',f=>{f.io.installedController=async()=>({commit:'9'.repeat(40),tree:f.c.controllerTree});}],
 ['self review',f=>replace(f,'review',x=>{x.session=x.buildSession;})],
 ['stale head',f=>replace(f,'review',x=>{x.head='9'.repeat(40);})],
 ['failed tests',f=>replace(f,'tests',x=>{x.kind='code_failure';})],
 ['wrong producer',f=>replace(f,'tests',x=>{x.origin='0'.repeat(40);})],
 ['wrong request',f=>replace(f,'testRequest',x=>{x.head='9'.repeat(40);})],
 ['wrong image',f=>replace(f,'tests',x=>{x.image='latest';})],
 ['log tamper',f=>writeFile(f.c.evidence.ownerLog_node.path,'changed')],
 ['skipped assertion log',async f=>{const r=f.c.evidence.ownerLog_node;await writeFile(r.path,'# tests 613\n# pass 613\n# fail 0\n# skipped 1');r.hash=digest(await readFile(r.path));await replace(f,'tests',x=>{x.checks.find(row=>row.name==='node').log=r.hash;});}],
 ['unresolved label',f=>replace(f,'actionResolution',x=>{x.labels=[];})],
 ['pre-review resolution',f=>replace(f,'actionResolution',x=>{x.at=new Date(1000).toISOString();})],
 ['wrong old source',f=>writeFile(f.c.evidence.previousRunner.path,'new source pretending to be old')],
 ['wrong old image',f=>replace(f,'ownershipRequest',x=>{x.current.image='sha256:'+'e'.repeat(64);})],
 ['old bundle changed',async f=>writeFile(JSON.parse(await readFile(f.paths.ownershipRequest)).current.composeFile,'changed')],
 ['live ownership drift',f=>{const own=f.io.ownership;f.io.ownership=async()=>({...await own(),serviceEvidence:{}});}],
 ['worker',f=>{f.io.workers=async()=>false;}],
 ['foreign ready',f=>{const api=f.io.api;f.io.api=async(m,p)=>p.includes('issues?')?[{number:99}]:api(m,p);}],
 ['foreign claim',f=>{const engine=f.io.engine;f.io.engine=async()=>{const s=await engine();s.admission.claimed=['other'];return s;};}],
 ['old source runtime mismatch',f=>{const engine=f.io.engine;f.io.engine=async()=>{const s=await engine();s.momoflow_launch.source='a'.repeat(64);return s;};}],
 ['foreign lock',f=>atomic(join(f.dir,'lock'),{pid:1})],
 ['remote recovery head',f=>{const api=f.io.api;f.io.api=async(m,p)=>p.endsWith('/pulls/37')?{...await api(m,p),head:{sha:'9'.repeat(40)}}:api(m,p);}],
 ['wrong merge parent',f=>{const api=f.io.api;f.io.api=async(m,p)=>p.endsWith('/git/commits/'+f.c.merge)?{...await api(m,p),parents:[{sha:'9'.repeat(40)},{sha:f.c.head}]}:api(m,p);}],
])test('v4 rejects '+name+' without writing a receipt or retiring manifest',async()=>{
 const f=await budgetFixture();try{await change(f);const before=await files(f.root);await assert.rejects(f.run());assert.deepEqual(await files(f.root),before);await assert.rejects(lstat(join(f.dir,'external-reconciliation.json')),{code:'ENOENT'});assert.ok(f.calls.every(x=>x.method==='GET'));}finally{await f.clean();}
});
for(const name of ['ledger','originalIndex','correction','buildNative','review','tests','previousRunner','actionResolution','recovery'])
for(const location of ['source','archive'])test(`v4 receipt rejects changed ${location} ${name}`,async()=>{
 const f=await budgetFixture();try{await f.run();const r=JSON.parse(await readFile(join(f.dir,'external-reconciliation.json'))),path=location==='source'?f.c.evidence[name].path:join(r.archive,name);await rm(path);await writeFile(path,'changed',{mode:0o600});await assert.rejects(verifiedExternalReceipt(f.c,keyFor(f.c)));}finally{await f.clean();}
});
test('v4 preparation rejects changed identity and permits only finite previous bundle file mounts',async()=>{
 const f=await budgetFixture();try{
  const mounts=await budgetExtraMounts(f.c);assert.equal(mounts.length,3);assert.equal(await budgetSourceChecks(f.c),f.c.runnerSource);
  const before=await files(f.root);f.input.turns.owner.build='other';await assert.rejects(f.prepare());
  const after=await files(f.root);delete before['/typed-input.json'];delete after['/typed-input.json'];assert.deepEqual(after,before);
  await replace(f,'ownershipRequest',x=>{x.current.files['/run/secrets/private-key.pem']=digest('simulated private data');});await replace(f,'previousBundle',x=>{x.files['/run/secrets/private-key.pem']=Buffer.from('simulated private data').toString('base64');});await assert.rejects(budgetExtraMounts(f.c),/allowlist/);
 }finally{await f.clean();}
});
await import('./reconcile-budget-cli.test.mjs');

test('preparation accepts typed source paths and derives only six hash-named logs per validation',async()=>{
 const {prepareReconciliation}=await import('./prepare-reconciliation.mjs');
 const {budgetChecks}=await import('./reconcile-budget.mjs');
 const {mkdir}=await import('node:fs/promises');
 const f=await budgetFixture();try {
  const input=JSON.parse(await readFile(f.inputFile)),logs={};
  for(const prefix of ['owner','recovery']) {
   const dir=join(f.root,prefix+'-logs');await mkdir(dir);logs[prefix]=dir;
   for(const name of budgetChecks){const key=`${prefix}Log_${name}`,ref=input.sources[key];await writeFile(join(dir,ref.hash),await readFile(ref.path));delete input.sources[key];}
  }
  input.logs=logs;for(const [name,ref]of Object.entries(input.sources))if(name!=='controllerJournal')input.sources[name]=ref.path;
  const file=join(f.root,'path-input.json');await atomic(file,input);const out=join(f.root,'path-prepared');
  const first=await prepareReconciliation(file,out,{api:f.io.api,installed:async()=>f.seen});
  assert.equal((await prepareReconciliation(file,out,{api:f.io.api,installed:async()=>f.seen})).id,first.id);
  const c=JSON.parse(await readFile(first.request));assert.equal(c.evidence.ownerLog_node.hash,input.sources.tests?JSON.parse(await readFile(input.sources.tests)).checks.find(x=>x.name==='node').log:undefined);
 }finally{await f.clean();}
});

test('same implementation1 survives recorded provider interruption in the reused native session',async()=>{
 const f=await budgetFixture();try {
  const ref=f.c.evidence.recoveryBuildNative,rows=(await readFile(ref.path,'utf8')).split('\n').map(x=>JSON.parse(x));
  rows.find(x=>x.type==='event_msg').payload.started_at=310;
  rows.find(x=>x.type==='event_msg').payload.completed_at=320;
  rows.push({type:'turn_context',payload:{turn_id:'failed-transport',model:'gpt-6.1-sol',effort:'medium'}});
  rows.push({type:'event_msg',payload:{type:'task_complete',turn_id:'failed-transport',started_at:290,completed_at:305,last_agent_message:null,error:{codex_error_info:'server_overloaded',message:'Selected model is at capacity'}}});
  await writeFile(ref.path,rows.map(x=>JSON.stringify(x)).join('\n'));ref.hash=digest(await readFile(ref.path));
  await assert.rejects(f.run(),/transport turns/);
  await replace(f,'recoveryBuild',x=>{x.transportInterruptions=[{turnId:'failed-transport',code:'server_overloaded'}];});
  assert.equal((await f.run()).status,'externally-reconciled');
  assert.equal(JSON.parse(await readFile(join(f.dir,'external-reconciliation.json'))).binding.recoveryIterations,1);
 }finally{await f.clean();}
});
