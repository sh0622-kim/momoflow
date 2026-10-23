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
 await git(['init']);await mkdir(join(repo,'engine'));await writeFile(join(repo,'engine/role_runner.ex'),'runner\n');await git(['add','.']);await commit();
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
