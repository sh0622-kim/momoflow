import { hostname } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { command } from './post-pr-docker.mjs';
import { finishConfig, prepareCompletion } from './finish.mjs';
import { fixture } from './post-pr-fixture.mjs';
import { digest } from './post-pr.mjs';
import { fileURLToPath } from 'node:url';
for(const scenario of ['normal','duplicate','drift','authority','foreign','owner','unknown','failed','rollback','drain','lock','race','ledger-changed','revoke-retirement','revoke-resume','expire-resume','report-retry','after-retire']) test(`finish separate module process: ${scenario} (mock external effects)`,async()=>{
 const r=await command(process.execPath,[fileURLToPath(new URL('./finish-process-fixture.mjs',import.meta.url)),scenario],{timeout:15000});
 assert.equal(r.exit,0,r.output.toString());const row=JSON.parse(r.output);assert.equal(row.scenario,scenario);assert.equal(row.evidenceKind,'mock-external-real-subprocess-files-locks');
});
test('actual finish CLI imports successfully and rejects an invalid request without effects',async()=>{
 const r=await command(process.execPath,[fileURLToPath(new URL('./finish.mjs',import.meta.url))],{timeout:10000});
 assert.equal(r.exit,1);assert.match(r.output.toString(),/Usage: node scripts\/finish/);assert.doesNotMatch(r.output.toString(),/SyntaxError|ReferenceError/);
});
function setup(){
 const f=fixture(),c={...f.c,launchId:'a'.repeat(64),iterationLimit:3,launchRoot:'/operator/launch',configFile:'/operator/launch.json',configContents:{fixed:true},authority:{...f.c.authority,finish:true,deploy:true,retire:true},finish:{deploymentRoot:'/operator/deploy',gateRoot:'/operator/gate',project:'test',dataVolume:'test-data',drainMs:1000,verifyMs:1000,previous:{commit:'a'.repeat(40),image:'sha256:'+'a'.repeat(64),authImage:'sha256:'+'b'.repeat(64),runnerSource:'c'.repeat(64),composeFile:'/operator/compose.json',composeHash:'d'.repeat(64),files:{'/operator/compose.json':'d'.repeat(64)},inspect:{symphony:{},'github-auth':{}}}}};
 c.launch={v:1,id:c.launchId,repo:c.repo,issue:c.issue,base:c.base,limit:c.iterationLimit};return {c,f};
}
test('completion rejects missing authority, unknown operator commands, and changed scope',()=>{
 const {c}=setup();assert.equal(finishConfig(c),c);
 for(const key of ['finish','deploy','retire','close']){const x=structuredClone(c);x.authority[key]=false;assert.throws(()=>finishConfig(x),/authority/);}
 const x=structuredClone(c);x.finish.command='candidate-supplied';assert.throws(()=>finishConfig(x),/unknown finish/);
 c.launch.issue='31';assert.throws(()=>finishConfig(c),/scope/);
});
test('completion requires durable launch delegation before inspecting merge/ledger',async()=>{
 const {c}=setup();const intent={done:true,contract:digest(c.launch),settings:digest(c.configContents)};
 const io={launch:async()=>intent,host:async()=>null,ledger:async()=>null};
 await assert.rejects(prepareCompletion(c,io),/delegate/);
});
test('isolated completion CLI has a separate executable entry and fails closed without a plan',async()=>{
 const r=await command(process.execPath,[fileURLToPath(new URL('./finish-isolated.mjs',import.meta.url))],{timeout:10000});
 assert.equal(r.exit,1);assert.match(r.output.toString(),/No production success claimed/);
});
test('preserved normal merge evidence is bound to original journal, launch, generation and settings',async()=>{
 const {c,f}=setup();const ledger=structuredClone(f.ledger);ledger.launch=c.launch;
 const p=ledger.publication,j={done:true,publication:p,request:digest(p),mergeAttempt:{state:'confirmed',sha:'f'.repeat(40)},merged:'f'.repeat(40),validation:f.result};
 const intent={done:true,contract:digest(c.launch),settings:digest(c.configContents),finishSettings:digest(c.configContents)};
 const e={ledger,publication:p,validation:j.validation,merge:j.merged};
 const io={launch:async()=>intent,host:async()=>j,ledger:async()=>ledger,evidence:async()=>e};
 assert.equal((await prepareCompletion(c,io)).p.head,p.head);
 for(const mutate of [()=>{intent.finishSettings='changed';},()=>{j.mergeAttempt.state='uncertain';},()=>{e.merge='0'.repeat(40);},()=>{ledger.publication.generation=3;}]){
  const backup=structuredClone({intent,j,e,ledger});mutate();await assert.rejects(prepareCompletion(c,io));
  Object.assign(intent,backup.intent);Object.assign(j,backup.j);Object.assign(e,backup.e);Object.assign(ledger,backup.ledger);
 }
});
test('production and isolated completion connections reject mixed scopes before commands',async()=>{
 const {connectedCompletion,connectedFixtureCompletion}=await import('./deploy.mjs');
 await assert.rejects(connectedCompletion({fixtureMode:'credential-free-v1'},'/unused',()=>assert.fail()),/Production completion/);
 const c={repo:'smoke/fixture',issue:'18',base:'main',fixtureSource:'a',fixtureRepository:'/unused',integration:{}};
 await assert.rejects(connectedFixtureCompletion(c,'/unused',{status:'present',value:{v:1,id:'a'.repeat(64),repo:'smoke/fixture',issue:'19',base:'main',limit:3}},()=>assert.fail()),/Exact isolated completion manifest/);
});
for(const mode of ['policy','recheck','bridge']) test(`actual pinned finishConnected subprocess: ${mode} (mock GitHub; no Docker effects)`,async()=>{
 const r=await command(process.execPath,[fileURLToPath(new URL('./finish-connected-fixture.mjs',import.meta.url)),mode],{timeout:90000});
 assert.equal(r.exit,0,r.output.toString());const row=JSON.parse(r.output);assert.equal(row.mode,mode);assert.ok(row.checked>=(mode==='bridge'?1:4));
});

import { config, verifyIndependentOperator } from './post-pr.mjs';
test('host bridge address requires explicit finish delegation and fixed helper; remote addresses stay rejected',async()=>{
 const {c}=setup();c.engineURL='http://host.docker.internal:4000';c.operatorContainer='helper';assert.equal(finishConfig(c),c);
 for(const mutate of [x=>delete x.finish,x=>x.authority.finish=false,x=>delete x.operatorContainer,x=>x.engineURL='http://example.org:4000',x=>x.engineURL='http://host.docker.internal.evil:4000',x=>x.engineURL='http://192.168.1.2:4000']) {const x=structuredClone(c);mutate(x);assert.throws(()=>config(x));}
 const old=process.env.HOSTNAME;process.env.HOSTNAME=hostname();
 try {
  const self={Id:'a'.repeat(64),Config:{Hostname:hostname()},HostConfig:{NetworkMode:'operator_bridge'},State:{Running:true}};
  const docker=async()=>JSON.stringify([self]);assert.equal((await verifyIndependentOperator(c,docker)).Id,self.Id);
  for(const mutate of [x=>x.HostConfig.NetworkMode='host',x=>x.HostConfig.NetworkMode='container:engine',x=>x.State.Running=false,x=>x.Config.Hostname='other',x=>x.Config.Labels={'com.docker.compose.service':'symphony'},x=>x.Config.Labels={'com.docker.compose.service':'github-auth'}]) {const x=structuredClone(self);mutate(x);await assert.rejects(verifyIndependentOperator(c,async()=>JSON.stringify([x])));}
  await assert.rejects(verifyIndependentOperator(c,async args=>JSON.stringify([{...self,Id:args[1]===hostname()?'other':self.Id}])) ,/not this process/);
 } finally {if(old===undefined)delete process.env.HOSTNAME;else process.env.HOSTNAME=old;}
});
