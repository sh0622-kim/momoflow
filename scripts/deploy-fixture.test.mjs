// Real local Git/filesystem; Docker/image records are simulated. No auth/model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from './post-pr-docker.mjs';
import { fixtureSource, fixtureEvidence, fixtureLabels, integrationPlan, isolatedResources } from './deploy-fixture.mjs';
import { connected } from './deploy.mjs';
import { digest } from './post-pr.mjs';
const sha=n=>String(n).repeat(40),hash=n=>String(n).repeat(64);
async function localFixture() {
 const root=await mkdtemp('/tmp/momoflow-fixture-'),repo=join(root,'repo');await mkdir(repo);
 const git=async args=>{const r=await command('git',['-C',repo,...args]);assert.equal(r.exit,0,r.output.toString());return r.output.toString().trim();};
 const commit=()=>git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);
 await git(['init']);await mkdir(join(repo,'engine'));await writeFile(join(repo,'engine/role_runner.ex'),'runner\n');await writeFile(join(repo,'WORKFLOW.md'),'workflow');await mkdir(join(repo,'security'));await writeFile(join(repo,'security/codex-seccomp.json'),JSON.stringify({defaultAction:'SCMP_ACT_ERRNO',syscalls:[]}));await git(['add','.']);await commit();
 const source=await git(['rev-parse','HEAD']),versions=[];
 for(const v of ['A','B']) {
  await git(['checkout','--detach',source]);await writeFile(join(repo,'.momoflow-fixture-version'),v+'\n');await git(['add','.']);await commit();
  const id=await git(['rev-parse','HEAD']);versions.push(await fixtureSource(repo,source,id,v));
 }
 const logs=join(root,'logs');await mkdir(logs);await writeFile(join(logs,digest('log')),'log',{mode:0o600});
 for(const [i,row] of versions.entries()) {row.image='sha256:'+hash(i+1);row.logs={build:digest('log'),smoke:digest('log')};}
 const e={kind:'momoflow-isolated-fixture-v1',source,versions};
 const c={fixtureSource:source,fixtureRepository:repo,integration:{},project:'momoflow-deploy-test-unit',evidence:{path:join(root,'provenance.json'),hash:digest(e)},previous:versions[0],target:versions[1]};
 const docker=async args=>JSON.stringify([{Id:args[1],Config:{Labels:fixtureLabels(source,versions.find(x=>x.image===args[1]).commit,versions.find(x=>x.image===args[1]).tree)}}]);
 return {root,repo,source,versions,e,c,docker,git,commit};
}
test('fixture provenance checks real Git parent/tree/bytes with simulated immutable images',async()=>{
 const x=await localFixture();try {
  assert.equal(x.versions[0].runnerSource,digest('runner\n'));
  assert.equal((await fixtureEvidence(x.c,x.e,x.docker)).githubGate,'not-exercised');
  await assert.rejects(fixtureEvidence(x.c,x.e,async()=>JSON.stringify([{Id:x.c.target.image,Config:{Labels:{}}}])));
  x.e.versions[0].tree=sha(8);x.c.evidence.hash=digest(x.e);await assert.rejects(fixtureEvidence(x.c,x.e,x.docker),/tree/);
 } finally {await rm(x.root,{recursive:true,force:true});}
});
test('fixture rejects source edits, corrupt logs, wrong parent and ordinary CLI mixing',async()=>{
 const x=await localFixture();try {
  await connected(x.c,'/nonexistent').then(()=>assert.fail('ordinary CLI accepted fixture'),e=>assert.match(e.message,/separate isolated/));
  await writeFile(join(x.root,'logs',digest('log')),'changed');await assert.rejects(fixtureEvidence(x.c,x.e,x.docker),/log/);
  await x.git(['checkout','--detach',x.source]);await writeFile(join(x.repo,'engine/role_runner.ex'),'changed');await writeFile(join(x.repo,'.momoflow-fixture-version'),'A\n');await x.git(['add','.']);await x.commit();
  const id=await x.git(['rev-parse','HEAD']);await assert.rejects(fixtureSource(x.repo,x.source,id,'A'),/only add/);
  await assert.rejects(fixtureSource(x.repo,x.versions[0].commit,x.versions[1].commit,'B'),/parent/);
 } finally {await rm(x.root,{recursive:true,force:true});}
});
function requests() {
 const a={image:'A',commit:'a',files:{a:'1'}},b={image:'B',commit:'b',files:{b:'2'}};
 const common={project:'momoflow-deploy-test-unit',integration:{productionEngine:'prod',productionAuth:'auth',productionProject:'prod'},fixtureSource:sha(1),fixtureRepository:'/operator/repo',dataVolume:'test'};
 return [{...common,deploymentId:hash(1),previous:a,target:b},{...common,deploymentId:hash(2),previous:b,target:a},{...common,deploymentId:hash(3),previous:a,target:b}];
}
test('all three requests require exact A/B/A/B bundles, unique IDs and one installation',()=>{
 assert.equal(integrationPlan(requests()).length,3);
 for(const change of [r=>r[2].previous.files.a='tampered',r=>r[2].deploymentId=r[0].deploymentId,r=>r[1].gateRoot='/other',r=>r[2].fixtureSource=sha(2),r=>r[2].target={...r[2].target,commit:'C'}]) {
  const r=JSON.parse(JSON.stringify(requests()));change(r);assert.throws(()=>integrationPlan(r));
 }
});
const container=(source,type='bind')=>({Mounts:[{Type:type,Source:source,Name:source}],HostConfig:{PortBindings:{}}});
test('isolation includes production auth key/token sources and overlapping bind parents',()=>{
 const c=requests()[0],prod=[container('/prod/data'),container('/secrets/prod.pem')];
 isolatedResources(c,prod,[container('/test/data'),container('/secrets/test.pem')]);
 for(const shared of ['/secrets/prod.pem','/secrets','/prod/data/child']) assert.throws(()=>isolatedResources(c,prod,[container('/test'),container(shared)]),/shares/);
 assert.throws(()=>isolatedResources(c,[container('token','volume'),container('/key')],[container('token','volume'),container('/test')]),/shares/);
});

import { fixtureBundle, pinFixtureBundle, installationAttempt } from './deploy-fixture-install.mjs';
import { fixtureEnvironmentValues, fixtureEnvironment, fixtureRuntime, inspectIsolation } from './deploy-fixture.mjs';
import { deploymentConfig, bundleFiles, safeRuntime, deploy, runtimeIdentity } from './deploy.mjs';
import { readFile, realpath, symlink } from 'node:fs/promises';
async function credentialFree() {
 const root=await mkdtemp('/tmp/credential-free-');
 const c={fixtureMode:'credential-free-v1',fixtureSource:sha(1),fixtureRepository:root,repo:'smoke/fixture',issue:'18',base:'main',project:'momoflow-deploy-test-unit',dataVolume:'unit-data',codexVolume:'unit-codex',engineURL:'http://127.0.0.1:4500',integration:{productionProject:'prod'},manifest:{status:'absent'},deploymentId:hash(1),controllerVersion:sha(1),validationOrigin:sha(1),authority:{deploy:true},hold:false,compatibility:'unchanged-data',exceptional:false,drainMs:5,verifyMs:5,evidence:{path:join(root,'provenance.json'),hash:hash(1)},...Object.fromEntries(['stateRoot','deploymentRoot','gateRoot','launchRoot','inboxRoot','ledgerRoot','trustedRoot'].map(k=>[k,join(root,k)]))};
 const profile=join(root,'seccomp.json');await writeFile(profile,JSON.stringify({defaultAction:'SCMP_ACT_ERRNO',syscalls:[]}));
 const bundles=[],docs={},images={},calls=[];
 // Source-derived compose-go v2.9.1 JSON behavior: false CreateHostPath is
 // omitted (types/types.go bool omitempty). This is not a real Docker render.
 const docker=async args=>{calls.push(args);if(args[0]==='inspect')return JSON.stringify([images[args[1]]]);assert.ok(args.includes('config'));
  const d=JSON.parse(await readFile(args[args.indexOf('-f')+1],'utf8'));
  for(const m of d.services.symphony.volumes) if(m.bind?.create_host_path===false) delete m.bind.create_host_path;
  return JSON.stringify(d);
 };
 for(const i of [1,2]) {
  const row={image:'sha256:'+hash(i),commit:sha(i),runnerSource:hash(3)};
  const image={Id:row.image,Config:{User:'momo',Env:['HOME=/home/momo','MIX_ENV=prod'],Entrypoint:null,Cmd:['engine']}};images[row.image]=image;
  const wf=join(root,'workflow-'+i);await writeFile(wf,'workflow');
  const {doc,bundle}=fixtureBundle(c,row,image,wf,profile,join(root,'compose-'+i+'.json'),await readFile(profile));
  // Exercise normalization of explicit false as well as the generated {} form.
  doc.services.symphony.volumes.find(m=>m.type==='bind').bind.create_host_path=false;
  await pinFixtureBundle(c,bundle,doc,image,await readFile(profile),docker);
  bundles.push(bundle);docs[bundle.composeFile]=JSON.parse(await readFile(bundle.composeFile,'utf8'));
 }
 c.previous=bundles[0];c.target=bundles[1];
 calls.length=0;
 return {root,c,docs,images,docker,calls};
}
test('operator bundles connect credential-free single-service contract without tokenFile/authImage or login',async()=>{
 const x=await credentialFree();try {
  deploymentConfig(x.c,{fixture:true});
  for(const b of [x.c.previous,x.c.target]) await bundleFiles(x.c,b,x.docker,{fixture:true});
  assert.ok(x.docs[x.c.target.composeFile].services.symphony.volumes.filter(m=>m.type==='bind').every(m=>Object.keys(m.bind).length===0));
  assert.equal(x.c.target.composeHash,digest(await readFile(x.c.target.composeFile)));
  assert.equal(x.c.tokenFile,undefined);assert.equal(x.c.target.authImage,undefined);
  assert.ok(x.calls.every(a=>a[0]==='inspect' || a.includes('config')));
  fixtureEnvironment(x.c,{HOME:'/home/momo',...fixtureEnvironmentValues});
  assert.throws(()=>deploymentConfig(x.c),/separate isolated/);
  assert.throws(()=>safeRuntime(x.c,x.c.target));
  await assert.rejects(connected(x.c,'/does-not-exist'),/separate isolated/);
  const r=[{...x.c},{...x.c,deploymentId:hash(2),previous:x.c.target,target:x.c.previous},{...x.c,deploymentId:hash(3)}];assert.equal(integrationPlan(r).length,3);
  r[2].fixtureMode='other';assert.throws(()=>integrationPlan(r));
 } finally {await rm(x.root,{recursive:true,force:true});}
});
for(const [name,change] of [
 ['token file',d=>d.services.symphony.environment={...d.services.symphony.environment,GITHUB_TOKEN_FILE:'/run/auth'}],
 ['real token',d=>d.services.symphony.environment={...d.services.symphony.environment,GITHUB_TOKEN:'real'}],
 ['model override',d=>d.services.symphony.environment={...d.services.symphony.environment,OPENAI_API_KEY:'key'}],
 ['bind auto creation',d=>{d.services.symphony.volumes.find(m=>m.type==='bind').bind.create_host_path=true;}],
 ['missing bind options',d=>{delete d.services.symphony.volumes.find(m=>m.type==='bind').bind;}],
 ['external network',d=>{d.networks.default.internal=false;}],
 ['auth service',d=>{d.services['github-auth']={};}],
 ['auth mount',d=>d.services.symphony.volumes.push({type:'volume',source:'codex',target:'/run/momoflow-auth',volume:{nocopy:true}})],
 ['privileged',d=>{d.services.symphony.privileged=true;}],
 ['socket',d=>d.services.symphony.volumes.push({type:'bind',source:'/var/run/docker.sock',target:'/socket',read_only:true,bind:{create_host_path:false}})]
]) test(`fixture rejects ${name} before Compose rendering or effects`,async()=>{
 const x=await credentialFree();try {
  const b=x.c.target,d=x.docs[b.composeFile];change(d);await writeFile(b.composeFile,JSON.stringify(d));b.files[b.composeFile]=b.composeHash=digest(await readFile(b.composeFile));
  await assert.rejects(bundleFiles(x.c,b,x.docker,{fixture:true}));assert.equal(x.calls.filter(a=>a[0]!=='inspect').length,0);
 } finally {await rm(x.root,{recursive:true,force:true});}
});
test('fixture rejects present launch, host token path, shared data/Codex volume and inherited credentials',async()=>{
 const x=await credentialFree();try {
  for(const change of [c=>{c.manifest={status:'present'};},c=>{c.tokenFile='/host/token';}]) {const c=structuredClone(x.c);change(c);assert.throws(()=>deploymentConfig(c,{fixture:true}));}
  x.images[x.c.target.image].Config.Env.push('GITHUB_TOKEN_FILE=/host/token');await assert.rejects(bundleFiles(x.c,x.c.target,x.docker,{fixture:true}),/environment/);
  const b=structuredClone(x.c.target);b.inspect.symphony.mounts.find(m=>m.destination==='/data').source='production-data';assert.throws(()=>fixtureRuntime(x.c,b),/volume/);
 } finally {await rm(x.root,{recursive:true,force:true});}
});
test('isolation rejects local-volume aliases, unknown drivers, cross-type backing paths and symlink binds',async()=>{
 const root=await mkdtemp('/tmp/isolation-');try {
  const c={integration:{productionProject:'prod'},project:'momoflow-deploy-test-unit',...Object.fromEntries(['stateRoot','deploymentRoot','gateRoot','launchRoot','inboxRoot','ledgerRoot'].map(k=>[k,join(root,k)]))};
  const prod=[container('prod-data','volume'),container(root+'/prod-key')];await writeFile(root+'/prod-key','noncredential');
  const path=root+'/test';await mkdir(path);
  const vol={Driver:'local',Options:{},Mountpoint:root+'/prod-volume'};
  const docker=async args=>JSON.stringify([{...vol,Mountpoint:args[2]==='test-data'?root+'/test-volume':vol.Mountpoint}]);
  await inspectIsolation(c,prod,[container('test-data','volume')],docker,{fixture:true});
  for(const props of [{Driver:'plugin'},{Options:{device:'/production'}},{Mountpoint:root+'/prod-key'}]) await assert.rejects(inspectIsolation(c,prod,[container('test-data','volume')],async args=>JSON.stringify([{...vol,...(args[2]==='test-data'?props:{})}]),{fixture:true}));
  await assert.rejects(inspectIsolation(c,prod,[container(root+'/prod-volume')],docker,{fixture:true}));
  await symlink(path,root+'/alias');await assert.rejects(inspectIsolation(c,prod,[container(root+'/alias')],docker,{fixture:true}),/canonical/);
  c.stateRoot=root+'/prod-key/child';await assert.rejects(inspectIsolation(c,prod,[container(path)],docker,{fixture:true}),/control/);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('fixture state machine preserves drain and verified rollback; fixture data cannot enter ordinary deploy',async()=>{
 const x=await credentialFree();try {
  const calls=[];let paused=false,t=0;
  const state=async()=>({admission:{contract:1,configured:true,paused,generation:x.c.deploymentId,running:[],retrying:[],claimed:[],blocked:[],pending_dispatch:false}});
  const io={load:async()=>null,authorize:async()=>{},preflight:async()=>{},save:async j=>calls.push(j.phase),gate:async p=>{paused=p;},state,now:()=>t,sleep:async()=>{t++;},ownersIdle:async()=>true,backup:async()=>{},preReplace:async()=>{},replace:async b=>calls.push(b.commit),verify:async b=>{if(b===x.c.target)throw Error('stopped fixture');return {auth:'not-exercised'};},report:async()=>{}};
  await assert.rejects(deploy(x.c,io),/separate isolated/);assert.deepEqual(calls,[]);
  const j=await deploy(x.c,io,{fixture:true});assert.equal(j.phase,'rolled_back');assert.ok(calls.indexOf('drained')<calls.indexOf(x.c.target.commit));assert.ok(calls.includes('rollback_verified'));assert.equal(j.rollbackVerification.auth,'not-exercised');
 } finally {await rm(x.root,{recursive:true,force:true});}
});

test('reused fixture provenance binds generated WORKFLOW and seccomp to original reviewed source bytes',async()=>{
 const source=await localFixture(),x=await credentialFree();try {
  const c={...x.c,fixtureSource:source.source,fixtureRepository:source.repo,evidence:source.c.evidence};
  for(const [i,b] of [c.previous,c.target].entries()) Object.assign(b,{commit:source.versions[i].commit,runnerSource:source.versions[i].runnerSource});
  await fixtureEvidence(c,source.e,source.docker);
  const wf=c.target.inspect.symphony.mounts.find(m=>m.destination==='/config/WORKFLOW.md').source,original=c.target.files[wf];
  c.target.files[wf]=digest('changed-model-policy');await assert.rejects(fixtureEvidence(c,source.e,source.docker),/WORKFLOW/);c.target.files[wf]=original;
  const profile=join(x.root,'seccomp.json');c.target.files[profile]=digest('unconfined');await assert.rejects(fixtureEvidence(c,source.e,source.docker),/sandbox/);
 } finally {await rm(x.root,{recursive:true,force:true});await rm(source.root,{recursive:true,force:true});}
});

import { readProductionRoles } from './deploy-integration.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
test('installer journals attempted/completed effects and safe nonzero diagnostics without argv or output',async()=>{
 const parent=await mkdtemp('/tmp/install-diagnostic-'),root=join(parent,'new'),secret='private-output-and-argument';
 try {
  await assert.rejects(installationAttempt(root,async d=>{
   await d.createRoot({project:'fixture',volumes:['fixture-data']});
   await d.stage('create-volume-0');
   await d.command(process.execPath,['-e',`const fs=require('fs');const j=JSON.parse(fs.readFileSync(process.argv[1]));if(j.commands.at(-1).status!=='attempted')process.exit(91);fs.writeFileSync(process.argv[2],'effect');`,join(root,'installation.json'),join(root,'effect')]);
   await d.stage('start-initial-fixture');
   await d.command(process.execPath,['-e',"require('fs').writeSync(2,process.argv[1]);process.exit(23)",secret]);
  }),e=>{
   assert.deepEqual(e.diagnostic,{stage:'start-initial-fixture',reason:'External command failed',journal:join(root,'installation.json'),exit:23});
   assert.match(e.message,/exit=23/);assert.ok(!e.message.includes(secret));return true;
  });
  const bytes=await readFile(join(root,'installation.json'),'utf8'),j=JSON.parse(bytes);
  assert.equal(j.status,'failed');assert.deepEqual(j.commands.map(x=>[x.stage,x.status,x.exit]),[['create-volume-0','completed',0],['start-initial-fixture','failed',23]]);
  assert.equal(j.commands[1].outputHash,digest(secret));assert.ok(!bytes.includes(secret));assert.ok(!bytes.includes('process.stderr'));
  assert.equal(await readFile(join(root,'effect'),'utf8'),'effect');assert.equal((await fs.promises.stat(join(root,'installation.json'))).mode&0o777,0o600);
  const before=bytes;
  await assert.rejects(installationAttempt(root,d=>d.createRoot({})),e=>e.diagnostic.journal===null);
  assert.equal(await readFile(join(root,'installation.json'),'utf8'),before);
 } finally {await rm(parent,{recursive:true,force:true});}
});
test('installer pre-root failure reports stage/exit without claiming a journal exists',async()=>{
 const parent=await mkdtemp('/tmp/install-preroot-'),root=join(parent,'absent');try {
  await assert.rejects(installationAttempt(root,async d=>{
   await d.stage('production-and-provenance-preflight');
   await d.command(process.execPath,['-e','process.exit(17)']);
  }),e=>{assert.equal(e.diagnostic.stage,'production-and-provenance-preflight');assert.equal(e.diagnostic.exit,17);assert.equal(e.diagnostic.journal,null);assert.match(e.message,/not created or unavailable/);return true;});
  await assert.rejects(fs.promises.stat(root),{code:'ENOENT'});
 } finally {await rm(parent,{recursive:true,force:true});}
});
test('installer validation failure after an effect hides arbitrary errors; success finalizes journal',async()=>{
 const parent=await mkdtemp('/tmp/install-validation-');try {
  const root=join(parent,'failed');
  await assert.rejects(installationAttempt(root,async d=>{
   await d.createRoot({});await d.stage('connected-fixture-preflight');
   await d.command(process.execPath,['-e','process.exit(0)']);throw Error('raw inspect Env=credential');
  }),e=>{assert.equal(e.diagnostic.reason,'Validation or filesystem check failed');assert.ok(!e.message.includes('credential'));return true;});
  const failed=await readFile(join(root,'installation.json'),'utf8');assert.ok(!failed.includes('credential'));assert.equal(JSON.parse(failed).commands[0].status,'completed');
  const good=join(parent,'success');assert.equal(await installationAttempt(good,async d=>{await d.createRoot({});await d.stage('record-installed');return 'ok';}),'ok');
  assert.equal(JSON.parse(await readFile(join(good,'installation.json'),'utf8')).status,'installed-paused');
 } finally {await rm(parent,{recursive:true,force:true});}
});
test('installer records command spawn failure without raw OS error or false completion',async()=>{
 const parent=await mkdtemp('/tmp/install-spawn-'),root=join(parent,'new');try {
  await assert.rejects(installationAttempt(root,async d=>{await d.createRoot({});await d.stage('installed-sandbox');await d.command('/nonexistent-private-command',[]);}),e=>e.diagnostic.reason==='Command could not start');
  const j=JSON.parse(await readFile(join(root,'installation.json'),'utf8'));assert.equal(j.commands[0].status,'spawn-failed');assert.equal(j.status,'failed');
 } finally {await rm(parent,{recursive:true,force:true});}
});
test('production observation returns only ledger file hashes and rejects symlink/invalid layouts',async()=>{
 const root=await mkdtemp('/tmp/role-hashes-');try {
  assert.deepEqual(readProductionRoles(fs,crypto,root+'/absent'),[]);
  const p=join(root,hash(1)+'.json');await writeFile(p,'{"iterations":2}');
  assert.deepEqual(readProductionRoles(fs,crypto,root),[{file:hash(1)+'.json',hash:digest('{"iterations":2}')}]);
  const before=readProductionRoles(fs,crypto,root);await writeFile(p,'{"iterations":3}');assert.notDeepEqual(readProductionRoles(fs,crypto,root),before);
  await symlink(p,join(root,hash(2)+'.json'));assert.throws(()=>readProductionRoles(fs,crypto,root),/ledger/);
 } finally {await rm(root,{recursive:true,force:true});}
});
