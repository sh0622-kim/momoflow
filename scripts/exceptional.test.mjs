// Local contracts only: filesystem/subprocess are real; GitHub/Docker effects are mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exceptionalScope, exceptionalPlan, classifyChanges, requireSupported, approvalResponse, pinOriginals, verifyOriginals, requireApproval, recordResponse } from './exceptional.mjs';
import { digest, atomic } from './post-pr.mjs';
import { command } from './post-pr-docker.mjs';
const plan={v:1,kind:'exceptional-completion-v1',config:'/operator/original.json',controllerVersion:'a'.repeat(40),validationOrigin:'b'.repeat(40),unchanged:{auth:true,permissions:true,rolePolicy:true,data:true,checks:true}};
const prepared={scope:exceptionalScope,request:{repo:'fixture/repo',issue:'1'}};
function response(){return {prepared:digest(prepared),scope:exceptionalScope,actor:'external-operator',authority:'existing-scope',source:'https://github.com/fixture/repo/issues/1#issuecomment-123',action:'approve',at:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};}
test('exceptional declaration is narrow and rejects arbitrary hooks/expanded policy',()=>{
 assert.equal(exceptionalPlan(plan),plan);
 for(const patch of [{command:'shell'},{exceptional:true},{unchanged:{...plan.unchanged,auth:false}},{unchanged:{...plan.unchanged,budget:true}},{kind:'all-exceptions'},{controllerVersion:'latest'}])assert.throws(()=>exceptionalPlan({...plan,...patch}));
});
test('classify engine/dashboard/installed-host paths but block auth/data/role policy and renames explicitly',()=>{
 const files=['engine/admission.ex','engine/work_status.ex','patches/work-status.patch','scripts/finish.mjs','scripts/exceptional.test.mjs'].map(filename=>({filename,status:'modified'}));
 const r=requireSupported(files);assert.equal(r.blockers.length,0);assert.equal(r.exclusions.length,files.length);
 for(const filename of ['WORKFLOW.md','engine/role_runner.ex','patches/role-flow.patch','scripts/github-app-auth.mjs','Dockerfile','compose.yaml','security/codex-seccomp.json','data/schema.json','AGENTS.md','docs/deployment.md','scripts/test-role-flow.sh','scripts/smoke.sh','unexpected.js']) {
  assert.equal(classifyChanges([{filename,status:'modified'}]).blockers.length,1);
  assert.throws(()=>requireSupported([{filename,status:'modified'}]),new RegExp(filename.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 }
 assert.throws(()=>requireSupported([{filename:'engine/work_status.ex',previous_filename:'auth.js',status:'renamed'}]),/rename/);
 assert.throws(()=>requireSupported([{filename:'engine/admission.ex'}]),/unknown change status/);
 assert.throws(()=>requireSupported(files,{rows:[]}),/differs/);
});
test('operator response binds all prepared content/scope; shared source URL grants no expanded authority',()=>{
 assert.equal(approvalResponse(prepared,response()).action,'approve');
 for(const mutate of [r=>r.prepared='0'.repeat(64),r=>r.scope=['deploy'],r=>r.actor='app',r=>r.authority='expanded',r=>r.source='https://github.com/fixture/repo/issues/2',r=>r.source='https://github.com/fixture/repo/issues/1/../../2',r=>r.source='https://github.com/fixture/repo/pull/1',r=>r.action='continue',r=>r.expiresAt=new Date(Date.now()-10).toISOString(),r=>r.expiresAt=new Date(Date.now()+172800000).toISOString(),r=>r.at=new Date(Date.now()+10000).toISOString(),r=>r.hook='shell']){
  const r=response();mutate(r);assert.throws(()=>approvalResponse(prepared,r));
 }
 const r=response();assert.throws(()=>approvalResponse({...prepared,target:'changed'},r),/digest/);
 // Historical approval is allowed only for verification/reporting of a saved completion.
 assert.equal(approvalResponse(prepared,r,Date.now()+172800000,{historical:true}).action,'approve');
});
test('raw original records stay byte-pinned; revoked/expired decisions block forward authorization',async()=>{
 const root=await mkdtemp('/tmp/exceptional-contract-');
 try {
  const path=join(root,'original');await writeFile(path,'{ "original": true }\n',{mode:0o600});
  const pins=await pinOriginals([path]);await verifyOriginals(pins);const before=await readFile(path);
  const a=await recordResponse(prepared,root,response());await requireApproval(prepared,root);
  a.response.action='revoke';a.result='revoked';await atomic(join(root,'approval.json'),a);await assert.rejects(requireApproval(prepared,root),/revoked/);
  a.response.action='approve';a.result='approved';a.response.expiresAt=new Date(Date.now()-10).toISOString();await atomic(join(root,'approval.json'),a);await assert.rejects(requireApproval(prepared,root),/expired/);
  assert.deepEqual(await readFile(path),before);
  await writeFile(path,'{"original":true}');await assert.rejects(verifyOriginals(pins),/Original evidence/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('installed exceptional CLI preparation/responses use real immutable files and preserve originals (mock GitHub; no Docker)',async()=>{
 const r=await command(process.execPath,[fileURLToPath(new URL('./exceptional-process-fixture.mjs',import.meta.url))],{timeout:60000});
 assert.equal(r.exit,0,r.output.toString());const out=JSON.parse(r.output);assert.equal(out.evidenceKind,'mock-github-real-installed-subprocess-files-no-docker');assert.ok(out.checks>=10);
});
test('exceptional CLI rejects unknown action/commands before effects',async()=>{
 const r=await command(process.execPath,[fileURLToPath(new URL('./exceptional.mjs',import.meta.url)),'shell','/tmp/unused'],{timeout:10000});assert.equal(r.exit,1);assert.match(r.output.toString(),/Usage:/);
});

import { deploymentEvidence } from './deploy.mjs';
import { fixture } from './post-pr-fixture.mjs';
test('exceptional classification preserves fresh exact-head review/check/image/merge evidence and ordinary exclusion',async()=>{
 const f=fixture();f.merged=true;
 f.result.checks.find(x=>x.name==='contracts').tests=87;f.result.checks.find(x=>x.name==='node').tests=126;f.result.tests=213;
 for(const row of f.result.checks)row.log=digest('log');
 const e={ledger:f.ledger,publication:f.p,validation:f.result,merge:'f'.repeat(40)};
 const c={...f.c,validationOrigin:f.c.controllerVersion,target:{commit:e.merge,image:f.result.image,runnerSource:digest('source')},evidence:{hash:digest(e)}};
 f.responses.set(`GET /repos/fixture/repo/contents/engine/role_runner.ex?ref=${e.merge}`,{encoding:'base64',content:Buffer.from('source').toString('base64')});
 f.responses.set(`GET /repos/fixture/repo/git/commits/${e.merge}`,{tree:{sha:f.p.tree},parents:[{sha:f.p.base_head},{sha:f.p.head}]});
 f.responses.set('GET /repos/fixture/repo/pulls/2/files?per_page=100',[{filename:'scripts/finish.mjs',status:'modified'}]);
 await assert.rejects(deploymentEvidence(c,e,f.io.api,async()=>Buffer.from('log')),/separate exceptional deployment/);
 const options={classifyExceptional:files=>requireSupported(files)};
 assert.equal((await deploymentEvidence(c,e,f.io.api,async()=>Buffer.from('log'),options)).head,f.p.head);
 f.responses.set(`GET /repos/fixture/repo/commits/${f.p.head}/check-runs?per_page=100`,{total_count:1,check_runs:[{name:'ci',head_sha:f.p.head,app:{id:42},status:'completed',conclusion:'failure'}]});
 await assert.rejects(deploymentEvidence(c,e,f.io.api,async()=>Buffer.from('log'),options),/check\/producer/);
 f.responses.delete(`GET /repos/fixture/repo/commits/${f.p.head}/check-runs?per_page=100`);
 f.responses.set('GET /repos/fixture/repo/pulls/2/reviews?per_page=100',[{state:'CHANGES_REQUESTED',user:{login:'reviewer'}}]);
 await assert.rejects(deploymentEvidence(c,e,f.io.api,async()=>Buffer.from('log'),options),/review finding/);
 f.responses.delete('GET /repos/fixture/repo/pulls/2/reviews?per_page=100');
 c.target.image='sha256:'+'9'.repeat(64);await assert.rejects(deploymentEvidence(c,e,f.io.api,async()=>Buffer.from('log'),options),/tested image/);
 assert.ok(f.calls.every(x=>x.method==='GET' || x.path==='/graphql'));
});

import { isolatedExceptional } from './exceptional-isolated.mjs';
test('isolated exceptional prepare/respond preserve originals and distinguish synthetic approval; arbitrary faults and production rejected',async()=>{
 const root=await mkdtemp('/tmp/isolated-exceptional-contract-');
 try {
  const requestFile=join(root,'request.json'),completionPlan=join(root,'completion.json'),planFile=join(root,'plan.json');
  const request={repo:'smoke/fixture',issue:'40',fixtureMode:'credential-free-v1',integration:{scope:'synthetic'},manifest:{status:'absent'},deploymentId:'a'.repeat(64)};
  await atomic(requestFile,request);await atomic(completionPlan,{kind:'isolated-completion-v1',request:requestFile});
  await atomic(planFile,{kind:'isolated-exceptional-v1',completionPlan,fault:'none'});
  const p=await isolatedExceptional('prepare',planFile);assert.equal(p.prepared.humanApproval,'not-exercised');await verifyOriginals(p.prepared.originals);
  assert.equal((await isolatedExceptional('prepare',planFile)).digest,p.digest);
  const r={...response(),prepared:p.digest,scope:p.prepared.scope,source:'https://github.com/smoke/fixture/issues/40'};
  const responseFile=join(root,'response.json');await atomic(responseFile,r);
  assert.equal((await isolatedExceptional('respond',p.preparedFile,responseFile)).result,'approved');await requireApproval(p.prepared,join(root,'exceptional-fixture-'+p.prepared.id));
  await verifyOriginals(p.prepared.originals);assert.deepEqual(JSON.parse(await readFile(requestFile)),request);
  await atomic(planFile,{kind:'isolated-exceptional-v1',completionPlan,fault:'shell-hook'});await assert.rejects(isolatedExceptional('prepare',planFile),/Fixed isolated/);
  await atomic(planFile,{kind:'isolated-exceptional-v1',completionPlan,fault:'none'});await atomic(requestFile,{...request,repo:'production/repo'});await assert.rejects(isolatedExceptional('prepare',planFile),/credential-free/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('response rejection, concurrency and processing history never become replacement approval',async()=>{
 const root=await mkdtemp('/tmp/exceptional-response-contract-');
 try {
  const r={...response(),action:'reject'};await writeFile(join(root,'response.lock'),'held',{mode:0o600});
  await assert.rejects(recordResponse(prepared,root,r),/EEXIST/);await assert.rejects(readFile(join(root,'approval.json')),/ENOENT/);await rm(join(root,'response.lock'));
  const rejected=await recordResponse(prepared,root,r);assert.equal(rejected.result,'rejected');assert.deepEqual(await recordResponse(prepared,root,r),rejected);
  await assert.rejects(recordResponse(prepared,root,response()),/already processed/);await assert.rejects(requireApproval(prepared,root),/rejected/);
 }finally{await rm(root,{recursive:true,force:true});}
});

import { exceptionalReport } from './exceptional.mjs';
test('workpad and PR reporting must both succeed before close; reporting retry preserves the same records',async()=>{
 const root=await mkdtemp('/tmp/exceptional-report-contract-'),f=fixture(),beforeFetch=globalThis.fetch;
 try {
  const c={...f.c,tokenFile:join(root,'mock-token.json')};await atomic(c.tokenFile,{token:'mock-unused',expires_at:new Date(Date.now()+3600000).toISOString()});
  const p={id:'a'.repeat(64),scope:exceptionalScope,publication:f.p,controllerVersion:c.controllerVersion,validationOrigin:c.controllerVersion,classification:{exclusions:[{path:'scripts/finish.mjs'}]},request:{repo:c.repo,issue:c.issue,target:{commit:'f'.repeat(40),image:f.result.image}}};
  await recordResponse(p,root,{...response(),prepared:digest(p),scope:p.scope});
  let offline=true;
  f.responses.set('GET /repos/fixture/repo/issues/2/comments?per_page=100',()=>f.comments.map(x=>({...x,id:20})));
  f.responses.set('PATCH /repos/fixture/repo/issues/comments/20',body=>{f.comments[0].body=body.body;return {id:20,...body};});
  globalThis.fetch=async(url,options)=>{
   const path=url.slice('https://api.github.com'.length);
   if(offline && path==='/repos/fixture/repo/issues/2/comments' && options.method==='POST')throw Error('mock PR reporting unavailable');
   const x=await f.io.api(options.method,path,options.body?JSON.parse(options.body):undefined);return {ok:true,status:200,json:async()=>x};
  };
  await assert.rejects(exceptionalReport(c,p,{phase:'complete'},root),/unavailable/);
  assert.ok(!f.calls.some(x=>x.method==='PATCH' && x.path.endsWith('/issues/1')));
  offline=false;await exceptionalReport(c,p,{phase:'complete'},root);await exceptionalReport(c,p,{phase:'complete'},root);
  assert.equal(f.comments.length,1);assert.ok(f.pad.body.includes('누적 반복 1 / 3'));assert.equal(JSON.parse(await readFile(join(root,'report.json'))).closed,true);
  const closedReport=JSON.parse(await readFile(join(root,'report.json')));
  for(const phase of ['awaiting_approval','approved'])await exceptionalReport(c,p,{phase},root,{close:false});
  assert.equal(JSON.parse(await readFile(join(root,'report.json'))).phase,'complete');assert.equal(JSON.parse(await readFile(join(root,'report.json'))).closed,true);
  assert.deepEqual(JSON.parse(await readFile(join(root,'report.json'))).execution,closedReport.execution);
  f.issueState='open';const closes=f.calls.filter(x=>x.method==='PATCH' && x.path.endsWith('/issues/1')).length;
  await recordResponse(p,root,{...response(),prepared:digest(p),scope:p.scope,action:'revoke'});
  await assert.rejects(exceptionalReport(c,p,{phase:'complete'},root),/revoked/);
  assert.equal(f.calls.filter(x=>x.method==='PATCH' && x.path.endsWith('/issues/1')).length,closes);
  assert.equal(JSON.parse(await readFile(join(root,'report.json'))).closed,false);
 }finally{globalThis.fetch=beforeFetch;await rm(root,{recursive:true,force:true});}
});

for(const decision of ['approve','reject','revoke'])test(`report replay and concurrent publisher preserve durable ${decision} and execution outcome`,async()=>{
 const root=await mkdtemp('/tmp/exceptional-report-race-'),f=fixture(),beforeFetch=globalThis.fetch;
 try {
  const c={...f.c,tokenFile:join(root,'mock-token.json')};await atomic(c.tokenFile,{token:'mock-unused',expires_at:new Date(Date.now()+3600000).toISOString()});
  const p={id:'a'.repeat(64),scope:exceptionalScope,publication:f.p,controllerVersion:c.controllerVersion,validationOrigin:c.controllerVersion,classification:{exclusions:[{path:'scripts/finish.mjs'}]},request:{repo:c.repo,issue:c.issue,target:{commit:'f'.repeat(40),image:f.result.image}}};
  f.responses.set('GET /repos/fixture/repo/issues/2/comments?per_page=100',()=>f.comments.map(x=>({...x,id:20})));
  f.responses.set('PATCH /repos/fixture/repo/issues/comments/20',body=>{f.comments[0].body=body.body;return {id:20,...body};});
  let suspend=false,entered,release;
  globalThis.fetch=async(url,options)=>{
   if(suspend){suspend=false;entered();await new Promise(r=>{release=r;});}
   const x=await f.io.api(options.method,url.slice('https://api.github.com'.length),options.body?JSON.parse(options.body):undefined);return {ok:true,status:200,json:async()=>x};
  };
  const r={...response(),prepared:digest(p),scope:p.scope,action:decision==='revoke'?'approve':decision};
  await recordResponse(p,root,r);if(decision==='revoke')await recordResponse(p,root,{...r,action:'revoke'});
  const phase={approve:'approved',reject:'rejected',revoke:'revoked'}[decision];
  await exceptionalReport(c,p,{phase:'awaiting_approval'},root,{close:false});
  assert.equal(JSON.parse(await readFile(join(root,'report.json'))).phase,phase);
  let pending;
  const waiting=new Promise(r=>{entered=r;});suspend=true;
  pending=exceptionalReport(c,p,{phase:'approved'},root,{close:false});await waiting;
  const complete={phase:'complete',request:digest(p),approval:{hash:'synthetic-only'},verification:{kind:'mock-no-deployment'}};
  await atomic(join(root,'completion.json'),complete);
  await assert.rejects(exceptionalReport(c,p,complete,root,{close:false}),/EEXIST/);
  release();await pending;
  await exceptionalReport(c,p,complete,root,{close:false});
  const after=JSON.parse(await readFile(join(root,'report.json')));
  for(const hint of ['awaiting_approval','approved',phase])await exceptionalReport(c,p,{phase:hint},root,{close:false});
  const final=JSON.parse(await readFile(join(root,'report.json')));
  assert.equal(final.phase,'complete');assert.deepEqual(final.execution,after.execution);assert.equal(final.decision.result,phase);
  assert.ok(f.pad.body.includes('결과 complete'));assert.equal(f.comments.length,1);
  assert.ok(!f.calls.some(x=>x.method==='PATCH' && x.path.endsWith('/issues/1')),'report-only replays never close or deploy');
 }finally{globalThis.fetch=beforeFetch;await rm(root,{recursive:true,force:true});}
});
