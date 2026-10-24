// Real CLI/module/retirement filesystem and locks; Docker/GitHub/engine are mocked.
import { writeSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish, completionPorts } from './finish.mjs';
import { atomic, json, digest, withControllerLock } from './post-pr.mjs';
import { withDeploymentLock } from './deploy.mjs';
import assert from 'node:assert/strict';
import { exceptionalScope, recordResponse, requireApproval } from './exceptional.mjs';
const realNow=Date.now;
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
 const effects=[],trace=[];let live='previous',gate=false,revoked=false;
 const request={...c,completionOwner:{file:'mock.json',ledgerHash:digest(originals['original-ledger.json']),enrollmentHash:digest(originals['original-ledger.json.enrolled'])},drainMs:1,target:{image:'target'},previous:{image:'previous'},evidence:{hash:'e'.repeat(64)}};
 const prepared={scope:exceptionalScope,request:{repo:c.repo,issue:c.issue}};
 const response={prepared:digest(prepared),scope:exceptionalScope,actor:'external-operator',authority:'existing-scope',source:'https://github.com/smoke/fixture/issues/30',action:'approve',at:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
 if(['revoke-resume','expire-resume'].includes(scenario))await recordResponse(prepared,root,response);
 const ports={
 authorize:async()=>{trace.push('authorize');if(['revoke-resume','expire-resume'].includes(scenario))await requireApproval(prepared,root);if(revoked)throw Error('mock operator revocation');if(scenario==='authority')throw Error('mock missing authority');},
 files:async()=>{},match:async b=>{assert.equal(b.image,live);},
 state:async()=>({running:[],retrying:[],admission:{contract:1,configured:true,paused:gate,generation:c.deploymentId,pending_dispatch:false,running:[],retrying:[],claimed:scenario==='drain'&&gate?['active']:[],blocked:[]},momoflow_launch:{manifest:await current()?{status:'present',value:await current()}:{status:'absent'}}}),
 observeOwners:async()=>{
  if(scenario==='race' && gate) {try {await readFile(archive);await writeFile(manifest,original+' ');}catch(e){if(e.code!=='ENOENT')throw e;}}
  return {rows:[{file:'mock.json',bytes:Buffer.from(scenario==='ledger-changed'?'changed':originals['original-ledger.json']).toString('base64'),enrollment:Buffer.from(originals['original-ledger.json.enrolled']).toString('base64')}],manifest:await current()};
 },ownersIdle:async()=>!['owner','unknown'].includes(scenario),sleep:async()=>{},
 execute:async()=>{trace.push('deploy');effects.push('deploy');const phase=scenario==='rollback'?'rolled_back':scenario==='failed'?'blocked':'complete';if(phase==='complete')live='target';const d={phase,target:request.target,previous:request.previous};await atomic(join(c.deploymentRoot,c.deploymentId,'journal.json'),d);return d;},
 verify:async(b,paused,m)=>{trace.push('verify');assert.equal(b.image,live);assert.equal(paused,gate);assert.deepEqual(m,await current()?{status:'present',value:await current()}:{status:'absent'});return {kind:'mock-external',verified:true};},
 gate:async p=>{effects.push('gate:'+p);gate=p;if(scenario==='revoke-retirement' && p)revoked=true;}
 };
 const io=completionPorts(c,request,ports,{journalFile:journal,authorize:async()=>{},report:async()=>{trace.push('report');}});
 const save=io.save;io.save=async j=>{await save(j);if(j.phase==='resume_intent' && scenario==='revoke-resume')await recordResponse(prepared,root,{...response,action:'revoke'});if(j.phase==='resume_intent' && scenario==='expire-resume')Date.now=()=>realNow()+120000;};
 const actualRetire=io.retire;io.retire=async()=>{const result=await actualRetire();effects.push('retire');return result;};
 await withControllerLock(c,async()=>effects.push('handoff'));
 const run=()=>withDeploymentLock(c,()=>finish(c,io));
 if(['normal','duplicate','drift','report-retry','after-retire'].includes(scenario)) {
  if(scenario==='after-retire') {io.retire=async()=>{await actualRetire();throw Error('lost unlink response');};await assert.rejects(run());assert.equal((await json(journal)).phase,'blocked');await assert.rejects(readFile(manifest),/ENOENT/);const before=[...effects];await assert.rejects(run());assert.deepEqual(effects,before);}
  else {
  if(scenario==='report-retry') {io.report=async()=>{throw Error('lost reporting response');};await assert.rejects(run());assert.equal((await json(journal)).phase,'complete');const before=[...effects];io.report=async()=>{};await run();assert.deepEqual(effects,before);}
  const result=await run();assert.equal(result.phase,'complete');assert.equal(await readFile(archive,'utf8'),original);
  const before=[...effects];if(scenario==='drift'){live='drift';await assert.rejects(run());}else assert.equal((await run()).phase,'complete');
  assert.deepEqual(effects,before,'duplicate must not repeat gate/deploy/archive/unlink');
  }
 } else if(['revoke-resume','expire-resume'].includes(scenario)) {
  await assert.rejects(run(),/revoked|expired/);assert.equal((await json(journal)).phase,'blocked');assert.equal(gate,true);assert.ok(!effects.includes('gate:false'));
  await assert.rejects(readFile(manifest),/ENOENT/);assert.equal(await readFile(archive,'utf8'),original);
  const before=[...effects];await assert.rejects(run());assert.deepEqual(effects,before);
 } else if(scenario==='lock') {
  await withControllerLock(c,async()=>assert.rejects(run(),/EEXIST/));assert.deepEqual(effects,['handoff']);
 } else {
  await assert.rejects(run());assert.equal(await readFile(manifest,'utf8'),scenario==='race'?original+' ':beforeManifest);assert.ok(!effects.includes('retire'));
  if(['foreign','owner','unknown','authority','ledger-changed'].includes(scenario))assert.ok(!effects.includes('deploy'));
  if(['failed','rollback'].includes(scenario)) {const j=await json(journal);assert.equal(j.phase,'blocked');assert.equal(j.deploymentPhase,scenario==='failed'?'blocked':'rolled_back');}
  if(scenario==='revoke-retirement'){assert.equal(gate,true);assert.equal((await json(journal)).phase,'blocked');assert.equal(effects.filter(x=>x==='gate:true').length,2,'revocation must not suppress safety fencing');}
  const before=[...effects];await assert.rejects(run());assert.deepEqual(effects,before,'blocked completion must not replay effects');
 }
 for(const [name,bytes] of Object.entries(originals))assert.equal(await readFile(join(root,name),'utf8'),bytes);
 writeSync(1,JSON.stringify({scenario,evidenceKind:'mock-external-real-subprocess-files-locks',effects,trace})+'\n');
} finally {Date.now=realNow;await rm(root,{recursive:true,force:true});}
