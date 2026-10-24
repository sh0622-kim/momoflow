import { hostname } from 'node:os';
// Actual pinned finishConnected path in a subprocess. Only GitHub is mocked;
// every case must stop before Docker or deployment/retirement effects.
import assert from 'node:assert/strict';
import { writeSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command } from './post-pr-docker.mjs';
import { fixture } from './post-pr-fixture.mjs';
import { writeWorkStatus } from './work-status.mjs';
import { finishConnected } from './finish.mjs';
import { atomic, digest, keyFor, json } from './post-pr.mjs';
const mode=process.argv[2];
if(!process.argv[3]) {
 const root=await mkdtemp('/tmp/finish-connected-install-');
 try {
  const trusted=join(root,'controller');await mkdir(trusted);
  await cp(dirname(fileURLToPath(import.meta.url)),join(trusted,'scripts'),{recursive:true});
  for(const args of [['init','-q'],['add','scripts'],['-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','-qm','isolated validation copy']]) {
   const r=await command('git',['-C',trusted,...args]);assert.equal(r.exit,0,r.output.toString());
  }
  const r=await command(process.execPath,[join(trusted,'scripts/finish-connected-fixture.mjs'),mode,root],{timeout:60000});
  assert.equal(r.exit,0,r.output.toString());writeSync(1,r.output);
 } finally {await rm(root,{recursive:true,force:true});}
} else {
 const install=process.argv[3],trusted=join(install,'controller');
 const head=await command('git',['-C',trusted,'rev-parse','HEAD']);assert.equal(head.exit,0);
 let checked=0;
 async function run({file,rename=false,complete=false,drift}) {
  const root=await mkdtemp(join(install,'case-')),f=fixture();f.merged=true;
  const c={...f.c,trustedRoot:trusted,controllerVersion:head.output.toString().trim(),launchId:'a'.repeat(64),iterationLimit:3,authority:{...f.c.authority,finish:true,deploy:true,retire:true}};
  for(const k of ['stateRoot','inboxRoot','ledgerRoot','launchRoot']){c[k]=join(root,k);await mkdir(c[k],{mode:0o700});}
  if(mode==='bridge') {
   process.env.HOSTNAME=hostname();c.operatorContainer='helper';c.engineURL='http://host.docker.internal:4000';
   const bin=join(root,'bin');await mkdir(bin);
   const self={Id:'a'.repeat(64),Config:{Hostname:process.env.HOSTNAME},HostConfig:{NetworkMode:'operator_bridge'},State:{Running:true}};
   const {writeFile}=await import('node:fs/promises');
   await writeFile(join(bin,'docker'),'#!'+process.execPath+'\nrequire("fs").writeSync(1,'+JSON.stringify(JSON.stringify([self]))+');',{mode:0o700});
   process.env.PATH=bin+':'+process.env.PATH;
  }
  c.configFile=join(root,'config.json');c.tokenFile=join(root,'mock-token.json');
  await atomic(c.tokenFile,{token:'isolated-unused-token',expires_at:new Date(Date.now()+3600000).toISOString()});
  const composeFile=join(root,'previous-compose.json');await atomic(composeFile,{services:{symphony:{image:'sha256:'+'a'.repeat(64)}}});
  const composeHash=digest(await readFile(composeFile));
  const previous={commit:'0'.repeat(40),image:'sha256:'+'a'.repeat(64),authImage:'sha256:'+'b'.repeat(64),runnerSource:digest('source'),composeFile,composeHash,files:{[composeFile]:composeHash},inspect:{symphony:{image:'sha256:'+'a'.repeat(64)},'github-auth':{}}};
  c.finish={deploymentRoot:join(root,'deploy'),gateRoot:join(root,'gate'),project:'test',dataVolume:'test-data',drainMs:1000,verifyMs:1000,previous};await mkdir(c.finish.gateRoot,{mode:0o700});
  c.launch={v:1,id:c.launchId,repo:c.repo,issue:c.issue,base:c.base,limit:c.iterationLimit};
  c.configContents=structuredClone(c);await atomic(c.configFile,c.configContents);
  f.result.origin=c.controllerVersion;f.result.checks.find(x=>x.name==='contracts').tests=87;f.result.checks.find(x=>x.name==='node').tests=126;f.result.tests=213;
  for(const row of f.result.checks)row.log=digest('log');f.ledger.launch=c.launch;
  const e={ledger:structuredClone(f.ledger),publication:f.p,validation:f.result,merge:'f'.repeat(40)};
  const dir=join(c.stateRoot,keyFor(c));await mkdir(join(dir,'logs'),{recursive:true,mode:0o700});
  await atomic(join(dir,'launch.json'),{done:true,contract:digest(c.launch),settings:digest(c.configContents),finishSettings:digest(c.configContents)});
  const host={done:true,publication:f.p,request:digest(f.p),mergeAttempt:{state:'confirmed',sha:e.merge},merged:e.merge,validation:f.result};
  if(drift==='host')host.mergeAttempt.state='uncertain';
  await atomic(join(dir,'journal.json'),host);
  await atomic(join(dir,`evidence-${digest(e)}.json`),e);
  // Logs are byte hashes, never synthetic success from a real host validator.
  const {writeFile}=await import('node:fs/promises');await writeFile(join(dir,'logs',digest('log')),'log');
  const ledger=structuredClone(f.ledger);if(drift==='ledger')ledger.stage='blocked';
  const ledgerFile=join(c.ledgerRoot,keyFor(c)+'.json');await atomic(ledgerFile,ledger);await atomic(ledgerFile+'.enrolled',c.launch);
  const manifest=join(c.launchRoot,'active.json');await atomic(manifest,c.launch);
  await writeWorkStatus(c,ledger,complete?'complete':'merged');
  const statusFile=join(c.inboxRoot,keyFor(c)+'.status.json');
  assert.equal((await json(statusFile)).phase,complete?'complete':'merged');
  const original={v:1,phase:'complete',request:digest(c.configContents),evidence:{hash:digest(e)},publication:f.p,target:{commit:e.merge,image:f.result.image},archive:{path:'preserved-original',hash:digest('original')},verification:{passed:true},next:'Original completion verified'};
  const journal=join(dir,'completion.json');if(complete)await atomic(journal,original);
  const originals=new Map();for(const p of [ledgerFile,ledgerFile+'.enrolled',manifest,join(dir,'journal.json')])originals.set(p,await readFile(p));
  f.responses.set(`GET /repos/fixture/repo/contents/engine/role_runner.ex?ref=${e.merge}`,{encoding:'base64',content:Buffer.from('source').toString('base64')});
  f.responses.set(`GET /repos/fixture/repo/git/commits/${e.merge}`,{tree:{sha:f.p.tree},parents:[{sha:f.p.base_head},{sha:f.p.head}]});
  f.responses.set('GET /repos/fixture/repo/pulls/2/files?per_page=100',[rename?{filename:'app.js',previous_filename:file}:{filename:file||'app.js'}]);
  // An ordinary change must reach the next fresh GitHub gate; stop there before Docker.
  f.responses.set('POST /graphql',{errors:[{message:'isolated stop before deployment'}]});
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
   assert.ok(url.startsWith('https://api.github.com/'));
   const body=options.body?JSON.parse(options.body):undefined;
   const value=await f.io.api(options.method,url.slice('https://api.github.com'.length),body);
   return {ok:true,status:200,json:async()=>value};
  };
  try {
   await assert.rejects(finishConnected(c),drift==='ledger'?/not released/:drift==='host'?/Confirmed exact/:file?/separate exceptional deployment/:/review threads/);
  } finally {globalThis.fetch=oldFetch;}
  const result=await json(journal);
  const display=await json(statusFile);
  assert.equal(display.phase,'blocked','actual catch must invalidate even a fresh complete summary');
  assert.equal(display.head,f.p.head);
  assert.equal(display.generation,ledger.events.length);
  if(complete){const {recheck,...preserved}=result;assert.deepEqual(preserved,original);assert.equal(recheck.status,'blocked');assert.match(recheck.next,/never replayed/);assert.ok(recheck.reason);}
  else {assert.equal(result.phase,file?'excluded':'blocked');assert.equal(result.target.image,f.result.image);assert.equal(result.publication.head,f.p.head);assert.equal(result.evidence.hash,digest(e));}
  assert.match(f.pad.body,/운영 마무리:/);assert.match(f.pad.body,/다음 행동:/);
  if(complete){assert.match(f.pad.body,/현재 재검사 차단/);assert.ok(f.pad.body.includes(result.recheck.reason));
   assert.match(result.recheck.reason,drift==='ledger'?/Original runner is not released/:drift==='host'?/Confirmed exact/:file?/separate exceptional deployment/:/review threads/);}
  assert.ok(f.calls.some(x=>x.method==='PATCH' && x.path.endsWith('/issues/comments/12')));
  assert.ok(!f.calls.some(x=>x.method==='PATCH' && x.path.endsWith('/issues/1')),'blocked recheck must not close issue');
  assert.equal(f.calls.some(x=>x.path==='/graphql'),!file&&!drift);
  for(const [p,bytes] of originals)assert.deepEqual(await readFile(p),bytes);
  await assert.rejects(readFile(join(c.finish.gateRoot,'active.json')),/ENOENT/);
  await assert.rejects(readFile(c.finish.deploymentRoot),/ENOENT/);
  await assert.rejects(readFile(join(c.stateRoot,'controller.lock')),/ENOENT/);
  checked++;
 }
 if(mode==='policy') {
  for(const file of ['engine/admission.ex','patches/admission.patch','patches/github-token-file.patch','Dockerfile','Dockerfile.auth','compose.yaml','compose.github-app.yaml','scripts/git-askpass.sh','scripts/reconcile-external.mjs','scripts/github-app-auth.mjs','scripts/start-github-app.sh','scripts/init-codex.sh','scripts/finish.mjs','WORKFLOW.md','docs/agent-policy.md','docs/human-actions.md','security/codex-seccomp.json'])for(const rename of [false,true])await run({file,rename});
  await run({}); // ordinary path reaches GraphQL, not rejected by policy
 } else if(mode==='recheck') {
  for(const drift of ['ledger','host',undefined])await run({complete:true,drift});
  await run({complete:true,file:'engine/admission.ex'});
 } else if(mode==='bridge') {await run({});} else assert.fail('Unknown connected fixture mode');
 writeSync(1,JSON.stringify({mode,checked,evidenceKind:'mock-github-real-finishConnected-subprocess-files-locks-no-docker'})+'\n');
}
