// Real local Git/filesystem; Docker/image records are simulated. No auth/model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from './post-pr-docker.mjs';
import { fixtureSource, fixtureEvidence, fixtureLabels, integrationPlan, isolatedResources } from './deploy-fixture.mjs';
import { connected, integrationIsolation, replaceConnectedBundle } from './deploy.mjs';
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
 const root=await mkdtemp('/tmp/gh20-credential-free-');
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

import { stat, lstat, link } from 'node:fs/promises';
import { mountRows, filesystemIdentity, fixtureMountSources, mountProbe } from './deploy-mount-identity.mjs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
// Files, stat, inode, symlinks and Git are real. Both host and daemon mountinfo
// are controlled for namespace regressions: the validator's /tmp can be overlay.
// Scope the builtin mock to each sequential test and restore named ESM imports.
function namespaceTest(name,fn) {
 test(name,async t=>{
  const original=fsPromises.readFile,s=await stat('/tmp',{bigint:true}),n=s.dev;
  const device=`${((n>>8n)&0xfffn)|((n>>32n)&0xfffff000n)}:${(n&0xffn)|((n>>12n)&0xffffff00n)}`;
  t.mock.method(fsPromises,'readFile',async (path,...args)=>path==='/proc/self/mountinfo'
   ?`1 0 ${device} / / rw - ext4 /dev/simulated-host rw\n`:original(path,...args));
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  await fn();
 });
}

async function namespaceFixture(desktop=true) {
 const root=await mkdtemp('/tmp/gh20-isolation-'),rows=mountRows(await readFile('/proc/self/mountinfo','utf8'));
 const boot=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),records=new Map(),probes=new Map(),volumes=new Map(),calls=[];
 for(const name of ['prod','key','test']) await mkdir(join(root,name));
 const make=async(id,paths,types=[])=>{
  const mounts=[],points=[],lines=[];
  for(const [i,path] of paths.entries()) {
   const s=await stat(path,{bigint:true}),identity=filesystemIdentity(rows,path,s),type=types[i] || 'bind',destination='/mounted-'+i;
   const source=desktop?'/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu-24.04/'+id+'-'+i:path;
   mounts.push({Type:type,Source:source,Destination:destination,RW:false,...(type==='volume'?{Name:id+'-volume'}:{})});
   points.push({path:destination,dev:String(s.dev),ino:String(s.ino)});
   const esc=p=>p.replace(/\\/g,'\\134').replace(/ /g,'\\040');
   lines.push(`${i+1} 0 ${identity.device} ${esc(identity.path)} ${destination} ro - ext4 /dev/test ro`);
   if(type==='volume') volumes.set(id+'-volume',{Name:id+'-volume',Driver:'local',Options:{},Mountpoint:source});
  }
  const x={Id:id,Mounts:mounts,HostConfig:{PortBindings:{}}};records.set(id,x);probes.set(id,{boot,mountinfo:lines.join('\n'),points});return x;
 };
 const production=[await make('engine',[root+'/prod']),await make('auth',[root+'/key'])];
 const c={project:'momoflow-deploy-test-unit',integration:{productionProject:'prod'},...Object.fromEntries(['stateRoot','deploymentRoot','gateRoot','launchRoot','inboxRoot','ledgerRoot'].map(k=>[k,join(root,'new',k)]))};
 const docker=async a=>{
  calls.push(a);
  if(a[0]==='exec') return JSON.stringify(probes.get(a[1]));
  if(a[0]==='inspect') return JSON.stringify(records.get(a.at(-1)).Mounts);
  if(a[0]==='volume' && a[1]==='inspect') return JSON.stringify([volumes.get(a[2])]);
  assert.fail('Unexpected Docker effect: '+a[0]);
 };
 const prospective=path=>({Mounts:[{Type:'bind',Source:path}],HostConfig:{PortBindings:{}}});
 return {root,c,production,make,probes,records,volumes,calls,docker,prospective};
}
for(const desktop of [false,true]) namespaceTest(`${desktop?'Desktop opaque':'native Linux'} namespace isolation passes distinct and absent host paths; rejects overlap/aliases`,async()=>{
 const x=await namespaceFixture(desktop);try {
  await inspectIsolation(x.c,x.production,[x.prospective(x.root+'/test')],x.docker,{fixture:true});
  await assert.rejects(lstat(x.root+'/new'),{code:'ENOENT'});
  for(const path of [x.root+'/prod',x.root+'/prod/child',x.root,'/']) await assert.rejects(inspectIsolation(x.c,x.production,[x.prospective(path)],x.docker,{fixture:true}),/production|nested/);
  await symlink(x.root+'/prod',x.root+'/alias');await assert.rejects(inspectIsolation(x.c,x.production,[x.prospective(x.root+'/alias')],x.docker,{fixture:true}),/canonical/);
  await symlink(x.root+'/missing',x.root+'/dangling');await assert.rejects(inspectIsolation(x.c,x.production,[x.prospective(x.root+'/dangling/child')],x.docker,{fixture:true}),/symlink/);
  // Distinct daemon strings pointing at the same filesystem subtree.
  const alias=await x.make('alias',[x.root+'/prod']);await assert.rejects(inspectIsolation(x.c,x.production,[alias],x.docker,{fixture:true}),/production|nested/);
  const control={...x.c,stateRoot:x.root+'/key/child'};await assert.rejects(inspectIsolation(control,x.production,[x.prospective(x.root+'/test')],x.docker,{fixture:true}),/control/);
  await writeFile(x.root+'/prod/file','not a credential');await link(x.root+'/prod/file',x.root+'/hardlink');
  x.production[0]=await x.make('engine',[x.root+'/prod/file']);await assert.rejects(inspectIsolation(x.c,x.production,[x.prospective(x.root+'/hardlink')],x.docker,{fixture:true}),/production|nested/);
  assert.ok(x.calls.every(a=>['exec','inspect','volume'].includes(a[0])));
 } finally {await rm(x.root,{recursive:true,force:true});}
});
namespaceTest('volume backing crosses bind namespace and prospective volumes require live correspondence',async()=>{
 const x=await namespaceFixture();try {
  const candidate=await x.make('test-volume',[x.root+'/test'],['volume']);
  await inspectIsolation(x.c,x.production,[candidate],x.docker,{fixture:true});
  const prospective={Mounts:candidate.Mounts.map(m=>({...m,Source:m.Name})),HostConfig:{PortBindings:{}}};
  await inspectIsolation(x.c,x.production,[prospective],x.docker,{fixture:true,live:[candidate]});
  await assert.rejects(inspectIsolation(x.c,x.production,[prospective],x.docker,{fixture:true}),/correspondence/);
  const v=x.volumes.get('test-volume-volume');
  for(const props of [{Driver:'plugin'},{Options:{device:'/production'}},{Mountpoint:'/stale'}]) {
   x.volumes.set('test-volume-volume',{...v,...props});await assert.rejects(inspectIsolation(x.c,x.production,[candidate],x.docker,{fixture:true}),/driver|backing/);
  }x.volumes.set('test-volume-volume',v);
  const overlap=await x.make('overlap-volume',[x.root+'/prod'],['volume']);await assert.rejects(inspectIsolation(x.c,x.production,[overlap],x.docker,{fixture:true}),/production|nested/);
  x.production[0]=await x.make('prod-volume',[x.root+'/prod'],['volume']);await assert.rejects(inspectIsolation(x.c,x.production,[x.prospective(x.root+'/prod/child')],x.docker,{fixture:true}),/production|nested/);
 } finally {await rm(x.root,{recursive:true,force:true});}
});
namespaceTest('missing, contradictory, nested, stacked and stale namespace evidence fails before effects with safe reasons',async()=>{
 const x=await namespaceFixture();try {
  const original=structuredClone(x.probes.get('engine'));
  for(const change of [p=>{p.boot='different';},p=>{p.points=[];},p=>{p.points[0].dev='0';},p=>{p.mountinfo+='\n'+p.mountinfo;},p=>{p.mountinfo+='\n9 0 1:2 / /mounted-0/nested ro - ext4 /dev/test ro';}]) {
   const p=structuredClone(original);change(p);x.probes.set('engine',p);
   await assert.rejects(inspectIsolation(x.c,x.production,[x.prospective(x.root+'/test')],x.docker,{fixture:true}),e=>{assert.match(e.safeReason,/Isolation/);return true;});
  }
  x.probes.set('engine',original);
  const stale=async a=>a[0]==='inspect'?'[]':x.docker(a);
  await assert.rejects(inspectIsolation(x.c,x.production,[x.prospective(x.root+'/test')],stale,{fixture:true}),/changed/);
  await assert.rejects(inspectIsolation(x.c,x.production,[x.prospective(x.root+'/test')],async()=>{throw Error('secret');},{fixture:true}),e=>{assert.equal(e.safeReason,'Isolation live mount metadata probe unavailable');assert.doesNotMatch(e.message,/secret/);return true;});
 } finally {await rm(x.root,{recursive:true,force:true});}
});
namespaceTest('fixture runtime source normalization requires exact mounted object, destination, type and RW',async()=>{
 const x=await namespaceFixture();try {
  const live=await x.make('fixture',[x.root+'/test']);
  const expected={mounts:[{type:'bind',source:x.root+'/test',destination:'/mounted-0',rw:false}]};
  const normalized=await fixtureMountSources(live,expected,x.docker);assert.equal(normalized[0].Source,x.root+'/test');assert.equal(live.Mounts[0].Source.includes('/run/desktop/'),true);
  const p=x.probes.get('fixture');p.points[0].ino='99999999999999';await assert.rejects(fixtureMountSources(live,expected,x.docker),/correspondence/);
  p.points[0].ino=String((await stat(x.root+'/test',{bigint:true})).ino);
  for(const props of [{source:x.root+'/key'},{source:x.root+'/test/absent'},{destination:'/wrong'},{type:'volume'},{rw:true}]) await assert.rejects(fixtureMountSources(live,{mounts:[{...expected.mounts[0],...props}]},x.docker),/correspondence|authority/);
 } finally {await rm(x.root,{recursive:true,force:true});}
});
test('actual local Node probe reads kernel/stat metadata only (no live Docker claim)',async()=>{
 const root=await mkdtemp('/tmp/gh20-probe-');try {
  const path=join(root,'space path');await mkdir(path);
  const result=await command('node',['-e',mountProbe,JSON.stringify([path])]);assert.equal(result.exit,0);
  const p=JSON.parse(result.output),s=await stat(path,{bigint:true});
  assert.equal(p.points[0].ino,String(s.ino));assert.equal(p.points[0].dev,String(s.dev));
  assert.equal(p.points[0].path,await realpath(path));
  assert.equal(p.boot,(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim());
  assert.equal(p.mountinfo,await readFile('/proc/self/mountinfo','utf8'));
  const rows=mountRows(p.mountinfo),backing=rows.filter(r=>path===r.target || path.startsWith(r.target==='/'?'/':r.target+'/')).sort((a,b)=>b.target.length-a.target.length)[0];
  assert.ok(backing,'actual probe mountinfo must cover the real temporary directory');
  if(['ext2','ext3','ext4','xfs','tmpfs'].includes(backing.filesystem)) {
   const identity=filesystemIdentity(rows,path,p.points[0]);assert.equal(identity.device,backing.device);assert.equal(identity.inode,String(s.ino));
  } else {
   // The actual metadata is still checked above; unsupported host backing must
   // fail closed, including overlay in the existing Docker validator.
   assert.throws(()=>filesystemIdentity(rows,path,p.points[0]),/filesystem backing unsupported/);
  }
  assert.deepEqual(Object.keys(p).sort(),['boot','mountinfo','points']);
 } finally {await rm(root,{recursive:true,force:true});}
});
namespaceTest('unrelated deleted WSL roots remain in mountinfo; ambiguous relevant roots and targets fail closed',async()=>{
 const x=await namespaceFixture();try {
  const base=await readFile('/proc/self/mountinfo','utf8'),s=await stat(x.root,{bigint:true});
  const stale=Array.from({length:8},(_,i)=>`${i+10} 0 8:1 /tmp/old-${i}//deleted /mnt/wsl/docker-desktop-bind-mounts/Ubuntu-24.04/old-${i} rw - ext4 /dev/test rw`);
  const rows=mountRows(base+stale.join('\n'));
  assert.equal(rows.length,9);assert.equal(rows[1].root,'/tmp/old-0//deleted');
  assert.deepEqual(filesystemIdentity(rows,x.root,s),filesystemIdentity(mountRows(base),x.root,s));
  for(const [root,target] of [
   ['/stale//deleted',x.root],['/stale//deleted',x.root+'/child'],['/stale//deleted','/tmp'],
   ['/',x.root+'/../'+x.root.split('/').at(-1)],['/',x.root+'/../elsewhere'],
   ['/','/unrelated/../elsewhere'],['/',x.root+'//child'],['/','relative-target'],
  ]) {
   const table=mountRows(base+`99 0 8:1 ${root} ${target} rw - ext4 /dev/test rw`);
   assert.equal(table.at(-1).root,root);assert.equal(table.at(-1).target,target);
   assert.throws(()=>filesystemIdentity(table,x.root,s),{message:'Isolation mountinfo path is ambiguous'});
  }
  const probe=x.probes.get('engine'),original=probe.mountinfo;
  probe.mountinfo=original+'\n'+stale.join('\n');
  await inspectIsolation(x.c,x.production,[x.prospective(x.root+'/test')],x.docker,{fixture:true});
  for(const target of ['/mounted-0','/mounted-0//child']) {
   probe.mountinfo=original+`\n99 0 8:1 /stale//deleted ${target} rw - ext4 /dev/test rw`;
   await assert.rejects(inspectIsolation(x.c,x.production,[x.prospective(x.root+'/test')],x.docker,{fixture:true}),/ambiguous|stacked|nested/);
  }
 } finally {await rm(x.root,{recursive:true,force:true});}
});
namespaceTest('installer isolation boundary fails safely before journal/root/volume/pause; check success remains resource-free',async()=>{
 const x=await namespaceFixture();try {
  const root=x.root+'/installation';
  for(const unknown of [false,true]) {
   const docker=unknown?async()=>{throw Error('PRIVATE');}:x.docker;
   await assert.rejects(installationAttempt(root,async d=>{
    await d.stage('production-and-provenance-preflight');
    await inspectIsolation(x.c,x.production,[x.prospective(unknown?x.root+'/test':x.root+'/prod')],docker,{fixture:true,hostPaths:[root]});
    await d.createRoot({});assert.fail('unsafe mapping advanced to resource creation');
   }),e=>{assert.equal(e.diagnostic.stage,'production-and-provenance-preflight');assert.equal(e.diagnostic.journal,null);assert.doesNotMatch(e.message,/PRIVATE/);return true;});
   await assert.rejects(lstat(root),{code:'ENOENT'});
  }
  const result=await installationAttempt(root,async()=>{
   await inspectIsolation(x.c,x.production,[x.prospective(x.root+'/test')],x.docker,{fixture:true,hostPaths:[root]});
   return {status:'preflight-passed',rootCreated:false};
  });assert.equal(result.status,'preflight-passed');await assert.rejects(lstat(root),{code:'ENOENT'});
 } finally {await rm(x.root,{recursive:true,force:true});}
});

namespaceTest('unsupported layered/shared backing fails isolation before installer root/volume effects',async()=>{
 const x=await namespaceFixture();try {
  const original=structuredClone(x.probes.get('engine'));
  for(const filesystem of ['overlay','btrfs','fuse','nfs','unknown']) {
   const p=structuredClone(original);
   // Different st_dev conceals an upperdir alias in the old checker.
   p.points[0].dev='257';
   p.mountinfo=`1 0 1:1 / /mounted-0 ro - ${filesystem} backing rw,upperdir=${x.root}/new`;
   x.probes.set('engine',p);
   const root=join(x.root,'new','install');
   await assert.rejects(installationAttempt(root,async d=>{
    await inspectIsolation(x.c,x.production,[x.prospective(x.root+'/test')],x.docker,{fixture:true,hostPaths:[root]});
    await d.createRoot({});
   }),e=>{assert.match(e.diagnostic.reason,/filesystem backing unsupported/);assert.equal(e.diagnostic.journal,null);return true;});
   await assert.rejects(stat(root),{code:'ENOENT'});
  }
  assert.ok(x.calls.every(a=>['exec','inspect'].includes(a[0])));
 } finally {await rm(x.root,{recursive:true,force:true});}
});

async function connectedNamespaceFixture() {
 const n=await namespaceFixture(),x=await credentialFree(),c=x.c;
 c.integration={productionProject:'prod',productionEngine:'engine',productionAuth:'auth'};
 for(const [i,p] of n.production.entries()) {p.State={Running:true};p.Config={Labels:{'com.docker.compose.project':'prod','com.docker.compose.service':i?'github-auth':'symphony'}};}
 for(const k of ['stateRoot','deploymentRoot','gateRoot','launchRoot','inboxRoot','ledgerRoot']) await mkdir(c[k]);
 const volumePaths={};for(const name of [c.dataVolume,c.codexVolume]) {volumePaths[name]=join(x.root,name);await mkdir(volumePaths[name]);}
 let live,seq=0;const effects=[];
 const make=async b=>{
  const e=b.inspect.symphony,paths=e.mounts.map(m=>m.type==='volume'?volumePaths[m.source]:m.source);
  const p=await n.make('candidate-'+(++seq),paths,e.mounts.map(m=>m.type));
  const probe=n.probes.get(p.Id);
  for(const [i,m] of p.Mounts.entries()) {
   const expected=e.mounts[i],old=m.Destination;
   m.Destination=expected.destination;m.RW=expected.rw;
   probe.points[i].path=m.Destination;
   probe.mountinfo=probe.mountinfo.replace(' '+old+' ',' '+m.Destination+' ');
   if(m.Type==='volume') {m.Name=expected.source;n.volumes.set(m.Name,{Name:m.Name,Driver:'local',Options:{},Mountpoint:m.Source});}
  }
  p.Image=b.image;p.State={Running:true,Health:{Status:'healthy'}};
  p.Config={...x.images[b.image].Config,Env:Object.entries({...Object.fromEntries(x.images[b.image].Config.Env.map(v=>v.split('='))),...fixtureEnvironmentValues}).map(([k,v])=>k+'='+v)};
  p.HostConfig={Privileged:e.privileged,CapAdd:e.capAdd,CapDrop:e.capDrop,SecurityOpt:e.securityOpt,NetworkMode:e.networkMode,ReadonlyRootfs:e.readonly,PortBindings:e.ports};
  live=p;
 };
 await make(c.previous);
 const docker=async a=>{
  effects.push(a);
  if(a[0]==='compose' && a.includes('up')) {await make(a[a.indexOf('-f')+1]===c.previous.composeFile?c.previous:c.target);return '';}
  if(a[0]==='stop') {live.State.Running=false;return '';}
  if(a[0]==='inspect' && !a.includes('--format')) return JSON.stringify([n.records.get(a[1])]);
  if(a[0]==='exec' && n.records.get(a[1]).State?.Running===false) throw Error('Docker exec: container is not running');
  if(a[0]==='run') {
   assert.ok(a.includes('--rm') && a.includes('--read-only'));
   for(const [flag,value] of [['--pull','never'],['--network','none'],['--cap-drop','ALL'],['--security-opt','no-new-privileges'],['--user','1000:1000'],['--entrypoint','node']]) assert.equal(a[a.indexOf(flag)+1],value);
   assert.equal(a[a.indexOf('--volumes-from')+1],live.Id+':ro');
   assert.equal(a[a.indexOf('--entrypoint')+2],live.Image);
   return JSON.stringify(n.probes.get(live.Id));
  }
  return n.docker(a);
 };
 const containers=async()=>({symphony:live});
 const isolation=recovery=>integrationIsolation(c,{symphony:live},docker,{fixture:true,recovery});
 const files=b=>bundleFiles(c,b,x.docker,{fixture:true});
 return {n,x,c,docker,effects,containers,isolation,files,live:()=>live,clean:async()=>{await rm(n.root,{recursive:true,force:true});await rm(x.root,{recursive:true,force:true});}};
}

namespaceTest('connected fixture replacement rolls back and verifies when stopped candidate rejects exec',async()=>{
 const x=await connectedNamespaceFixture();try {
  let paused=false,t=0;const phases=[];
  const state=async()=>({admission:{contract:1,configured:true,paused,generation:x.c.deploymentId,running:[],retrying:[],claimed:[],blocked:[],pending_dispatch:false}});
  const verify=async b=>{
   const p=x.live();const mounts=await fixtureMountSources(p,b.inspect.symphony,x.docker);
   assert.equal(p.State.Running,true);assert.deepEqual(runtimeIdentity({...p,Mounts:mounts}),b.inspect.symphony);
   await x.isolation(false);return {auth:'not-exercised',image:p.Image};
  };
  const io={load:async()=>null,authorize:async()=>{},preflight:()=>x.isolation(false),save:async j=>phases.push(j.phase),gate:async p=>{paused=p;},state,now:()=>t,sleep:async()=>{t++;},ownersIdle:async()=>true,backup:async()=>{},preReplace:()=>x.isolation(false),replace:b=>replaceConnectedBundle(x.c,b,{files:x.files,isolation:x.isolation,docker:x.docker,containers:x.containers,isolatedStop:true}),verify,report:async()=>{}};
  const j=await deploy(x.c,io,{fixture:true});
  assert.equal(j.phase,'rolled_back',JSON.stringify(j));assert.ok(phases.includes('rollback_verified'));
  assert.equal(j.rollbackVerification.image,x.c.previous.image);assert.equal(paused,false);
  assert.ok(x.effects.some(a=>a[0]==='exec' && a[1]==='candidate-2'));
  assert.ok(x.effects.some(a=>a[0]==='run'));
  assert.equal(x.effects.filter(a=>a[0]==='compose' && a.includes('up')).length,2);
 } finally {await x.clean();}
});

namespaceTest('recovery probe rejects changed bind correspondence, volumes, production backing and unsafe failed runtime',async()=>{
 for(const fault of ['bind','volume','production','runtime','missing-probe','stale']) {
  const x=await connectedNamespaceFixture();try {
   await replaceConnectedBundle(x.c,x.c.target,{files:x.files,isolation:x.isolation,docker:x.docker,containers:x.containers,isolatedStop:true});
   const live=x.live(),probe=x.n.probes.get(live.Id);
   await assert.rejects(x.isolation(false),/probe unavailable/);
   assert.ok(!x.effects.some(a=>a[0]==='run'),'ordinary isolation must not launch recovery helper');
   if(fault==='bind') probe.points.find(p=>p.path==='/run/momoflow-launch').ino='99999999999';
   if(fault==='volume') x.n.volumes.get(x.c.dataVolume).Options={device:'/production'};
   if(fault==='production') x.n.probes.get('engine').mountinfo=x.n.probes.get('engine').mountinfo.replace(' - ext4 ',' - overlay ');
   if(fault==='runtime') live.Mounts.push({Type:'bind',Source:'/secret',Destination:'/unexpected',RW:false});
   const docker=async a=>{
    if(fault==='missing-probe' && a[0]==='run') throw Error('private helper failure');
    if(fault==='stale' && a[0]==='inspect' && a.includes('--format') && a.at(-1)===live.Id) return '[]';
    return x.docker(a);
   };
   await assert.rejects(integrationIsolation(x.c,{symphony:live},docker,{fixture:true,recovery:true}),/correspondence|driver|backing|authority|probe unavailable|changed/);
   assert.equal(x.effects.filter(a=>a[0]==='compose' && a.includes('up')).length,1);
   if(fault==='runtime') assert.ok(!x.effects.some(a=>a[0]==='run'),'reject unsafe runtime before inheriting mounts');
  } finally {await x.clean();}
 }
});
