// Real CLI/module/retirement filesystem and locks; Docker/GitHub/engine are mocked.
import { writeSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish, completionPorts } from './finish.mjs';
import { atomic, json, digest, withControllerLock } from './post-pr.mjs';
import { withDeploymentLock } from './deploy.mjs';
import assert from 'node:assert/strict';
const scenario=process.argv[2], root=await mkdtemp(join(tmpdir(),'finish-process-'));
try {
 const c={stateRoot:join(root,'state'),deploymentRoot:join(root,'deploy'),repo:'smoke/fixture',issue:'30',controllerVersion:'a'.repeat(40),deploymentId:'b'.repeat(64),configContents:{scope:'test',authority:'mock external effects'},launchRoot:root,launch:{v:1,id:'c'.repeat(64),repo:'smoke/fixture',issue:'30',base:'main',limit:3}};
 await mkdir(c.stateRoot);const manifest=join(root,'active.json'),archive=join(root,`completed-manifest-${c.deploymentId}.json`),journal=join(root,'journal.json');
 const originals={'other-scope.json':'other scope','original-ledger.json':'immutable ledger','original-ledger.json.enrolled':'immutable enrollment','original-failure.json':'prior failure'};
 for(const [name,bytes] of Object.entries(originals))await writeFile(join(root,name),bytes);
 const original=JSON.stringify(c.launch,null,2)+'\n';await writeFile(manifest,original);
 const current=async()=>{try{return await json(manifest);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
 if(scenario==='foreign')await writeFile(manifest,JSON.stringify({...c.launch,issue:'31'}));
 const beforeManifest=await readFile(manifest,'utf8');
 const effects=[],trace=[];let live='previous',gate=false;
 const request={...c,completionOwner:{file:'mock.json',ledgerHash:digest(originals['original-ledger.json']),enrollmentHash:digest(originals['original-ledger.json.enrolled'])},drainMs:1,target:{image:'target'},previous:{image:'previous'},evidence:{hash:'e'.repeat(64)}};
 const ports={
 authorize:async()=>{trace.push('authorize');if(scenario==='authority')throw Error('mock missing authority');},
 files:async()=>{},match:async b=>{assert.equal(b.image,live);},
 state:async()=>({running:[],retrying:[],admission:{contract:1,configured:true,paused:gate,generation:c.deploymentId,pending_dispatch:false,running:[],retrying:[],claimed:scenario==='drain'&&gate?['active']:[],blocked:[]},momoflow_launch:{manifest:await current()?{status:'present',value:await current()}:{status:'absent'}}}),
 observeOwners:async()=>{
  if(scenario==='race' && gate) {try {await readFile(archive);await writeFile(manifest,original+' ');}catch(e){if(e.code!=='ENOENT')throw e;}}
  return {rows:[{file:'mock.json',bytes:Buffer.from(scenario==='ledger-changed'?'changed':originals['original-ledger.json']).toString('base64'),enrollment:Buffer.from(originals['original-ledger.json.enrolled']).toString('base64')}],manifest:await current()};
 },ownersIdle:async()=>!['owner','unknown'].includes(scenario),sleep:async()=>{},
 execute:async()=>{trace.push('deploy');effects.push('deploy');const phase=scenario==='rollback'?'rolled_back':scenario==='failed'?'blocked':'complete';if(phase==='complete')live='target';const d={phase,target:request.target,previous:request.previous};await atomic(join(c.deploymentRoot,c.deploymentId,'journal.json'),d);return d;},
 verify:async(b,paused,m)=>{trace.push('verify');assert.equal(b.image,live);assert.equal(paused,gate);assert.deepEqual(m,await current()?{status:'present',value:await current()}:{status:'absent'});return {kind:'mock-external',verified:true};},
 gate:async p=>{effects.push('gate:'+p);gate=p;}
 };
 const io=completionPorts(c,request,ports,{journalFile:journal,authorize:async()=>{},report:async()=>{trace.push('report');}});
 const actualRetire=io.retire;io.retire=async()=>{const result=await actualRetire();effects.push('retire');return result;};
 await withControllerLock(c,async()=>effects.push('handoff'));
 const run=()=>withDeploymentLock(c,()=>finish(c,io));
 if(['normal','duplicate','drift'].includes(scenario)) {
  const result=await run();assert.equal(result.phase,'complete');assert.equal(await readFile(archive,'utf8'),original);
  const before=[...effects];if(scenario==='drift'){live='drift';await assert.rejects(run());}else assert.equal((await run()).phase,'complete');
  assert.deepEqual(effects,before,'duplicate must not repeat gate/deploy/archive/unlink');
 } else if(scenario==='lock') {
  await withControllerLock(c,async()=>assert.rejects(run(),/EEXIST/));assert.deepEqual(effects,['handoff']);
 } else {
  await assert.rejects(run());assert.equal(await readFile(manifest,'utf8'),scenario==='race'?original+' ':beforeManifest);assert.ok(!effects.includes('retire'));
  if(['foreign','owner','unknown','authority','ledger-changed'].includes(scenario))assert.ok(!effects.includes('deploy'));
  if(['failed','rollback'].includes(scenario)) {const j=await json(journal);assert.equal(j.phase,'blocked');assert.equal(j.deploymentPhase,scenario==='failed'?'blocked':'rolled_back');}
  const before=[...effects];await assert.rejects(run());assert.deepEqual(effects,before,'blocked completion must not replay effects');
 }
 for(const [name,bytes] of Object.entries(originals))assert.equal(await readFile(join(root,name),'utf8'),bytes);
 writeSync(1,JSON.stringify({scenario,evidenceKind:'mock-external-real-subprocess-files-locks',effects,trace})+'\n');
} finally {await rm(root,{recursive:true,force:true});}
