import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reconcile, receipt, validation, config, digest, atomic, json, runOnce } from './post-pr.mjs';
import { materialize, command, diagnostic } from './post-pr-docker.mjs';
import { createHash } from 'node:crypto';

import {fixture} from './post-pr-fixture.mjs';

test('production reconcile validates, rechecks, SHA merges, preserves, reports, closes idempotently', async()=>{
 const f=fixture(); assert.deepEqual(await reconcile(f.c,f.io),{done:true,merge:'f'.repeat(40)});
 await reconcile(f.c,f.io);
 assert.equal(f.calls.filter(x=>x.method==='PUT').length,1);
 assert.equal(f.calls.filter(x=>x.method==='PATCH'&&x.path.endsWith('/issues/1')).length,1);
 assert.equal(f.comments.length,1); assert.ok(f.journal.done); assert.ok(f.preserved.length>=2);
});
test('code failure emits one stable same-PR envelope and no merge or new budget',async()=>{
 const f=fixture(); f.result.kind='code_failure'; Object.assign(f.result.checks.find(x=>x.name==='contracts'),{exit:2,failures:1});
 const first=await reconcile(f.c,f.io);const second=await reconcile(f.c,f.io);
 assert.equal(first.request,second.request);assert.equal(f.envelope.generation,f.ledger.events.length);assert.deepEqual(f.envelope.publication,f.p);
 assert.equal(f.ledger.iterations,1);assert.equal(f.calls.filter(x=>x.method==='PUT').length,0);assert.equal(f.comments.length,1);
});
for (const [name,mutate,pattern] of [
 ['stale head',f=>{f.responses.set('GET /repos/fixture/repo/pulls/2',{...f.pr(),head:{sha:'0'.repeat(40),repo:{full_name:f.c.repo}}});},/head/],
 ['base changed',f=>f.responses.set('GET /repos/fixture/repo/pulls/2',{...f.pr(),base:{...f.pr().base,sha:'0'.repeat(40)}}),/base/],
 ['wrong tree',f=>f.responses.set(`GET /repos/fixture/repo/git/commits/${f.p.head}`,{tree:{sha:'0'.repeat(40)}}),/tree/],
 ['empty checks',f=>{f.result.checks=[];},/Empty/],
 ['zero tests',f=>{f.result.tests=0;},/Zero/],
 ['forged origin',f=>{f.result.origin='x';},/Untrusted/],
 ['wrong result head',f=>{f.result.head='0'.repeat(40);},/Untrusted/],
 ['missing merge authority',f=>{f.c.authority.merge=false;},/authority/],
 ['operator hold',f=>{f.c.hold=true;},/hold/],
 ['protected branch',f=>f.responses.set('GET /repos/fixture/repo/branches/main',{protected:true}),/rules/],
 ['unreadable rules',f=>f.responses.set('GET /repos/fixture/repo/rules/branches/main?per_page=100',()=>{throw new Error('GitHub 403');}),/403/],
 ['active rules',f=>f.responses.set('GET /repos/fixture/repo/rules/branches/main?per_page=100',[{type:'merge_queue'}]),/rules/],
 ['wrong producer',f=>f.responses.set(`GET /repos/fixture/repo/commits/${f.p.head}/check-runs?per_page=100`,{total_count:1,check_runs:[{name:'ci',app:{id:41}}]}),/producer/],
 ['failed required check',f=>f.responses.set(`GET /repos/fixture/repo/commits/${f.p.head}/check-runs?per_page=100`,{total_count:1,check_runs:[{name:'ci',head_sha:f.p.head,app:{id:42},status:'completed',conclusion:'failure'}]}),/failed/],
 ['unresolved review',f=>f.responses.set('GET /repos/fixture/repo/pulls/2/reviews?per_page=100',[{user:{login:'human'},state:'CHANGES_REQUESTED'}]),/requested/],
 ['unresolved thread',f=>f.responses.set('POST /graphql',{data:{repository:{pullRequest:{reviewThreads:{nodes:[{isResolved:false}],pageInfo:{hasNextPage:false}}}}}}),/threads/],
 ['budget exhausted',f=>{f.ledger.iterations=3;f.result.kind='code_failure';Object.assign(f.result.checks.find(x=>x.name==='contracts'),{exit:2,failures:1});},/exhausted/],
 ['host failure',f=>{f.result.kind='host_failure';},/Host/],
 ['ambiguous code failure',f=>{f.result.kind='code_failure';f.result.checks[0].exit=1;},/Ambiguous/],
 ['external close',f=>{f.issueState='closed';},/closed/],
 ['external merge',f=>{f.merged=true;},/Externally/],
 ['revoke before merge',f=>{f.io.authorize=async()=>{throw new Error('policy changed');};},/policy changed/]
]) test(`fail closed: ${name}`,async()=>{
 const f=fixture();mutate(f);await assert.rejects(reconcile(f.c,f.io),pattern);
 assert.equal(f.calls.filter(x=>x.method==='PUT').length,0);assert.equal(f.envelope,undefined);
 assert.equal(f.calls.filter(x=>x.method==='PATCH'&&x.path.endsWith('/issues/1')).length,0);
 assert.match(f.pad.body,/개입 필요/);
});
test('routine pending CI and missing human approval wait without needs-decision/model dispatch',async()=>{
 for (const human of [false,true]) {
  const f=fixture();if(human) f.c.requiredReviewers=['human'];
  else f.responses.set(`GET /repos/fixture/repo/commits/${f.p.head}/check-runs?per_page=100`,{total_count:1,check_runs:[{name:'ci',head_sha:f.p.head,app:{id:42},status:'in_progress'}]});
  assert.ok((await reconcile(f.c,f.io)).waiting);assert.equal(f.envelope,undefined);assert.equal(f.calls.filter(x=>x.method==='PUT').length,0);assert.doesNotMatch(f.pad.body,/개입 필요/);
 }
});
test('in-flight/claimed upstream worker waits before examining partial ledger',async()=>{
 const f=fixture();f.io.engine=async()=>({running:[{issue_id:'1'}],retrying:[]});f.io.ledger=async()=>{throw Error('must not inspect active ledger');};
 assert.ok((await reconcile(f.c,f.io)).waiting);assert.equal(f.calls.length,0);
});
for (const point of ['POST /repos/fixture/repo/issues/2/comments','PATCH /repos/fixture/repo/issues/1']) {
 test(`restart after remote effect with lost response: ${point}`,async()=>{
  const f=fixture();const orig=f.io.api;let once=true;
  f.io.api=async(m,p,b)=>{const r=await orig(m,p,b);if(once&&`${m} ${p}`===point){once=false;throw Error('lost response');}return r;};
  await assert.rejects(reconcile(f.c,f.io),/lost/);await reconcile(f.c,f.io);
  assert.ok(f.journal.done);assert.equal(f.calls.filter(x=>x.method==='PUT').length,1);assert.equal(f.comments.length,2); // blocker + final
 });
}
test('preservation failure after merge never closes; retry recovers without remerge',async()=>{
 const f=fixture();const orig=f.io.preserve;let n=0;
 f.io.preserve=async x=>{if(++n===2)throw Error('disk full');await orig(x);};
 await assert.rejects(reconcile(f.c,f.io),/disk/);assert.equal(f.calls.filter(x=>x.path.endsWith('/issues/1')&&x.method==='PATCH').length,0);
 await reconcile(f.c,f.io);assert.ok(f.journal.done);assert.equal(f.calls.filter(x=>x.method==='PUT').length,1);
});
test('receipt rejects terminal/in-flight/stale generation/reused review session/settings drift',()=>{
 for(const mutate of [l=>l.stage='done',l=>l.in_flight=true,l=>l.publication.generation++,l=>l.events[1].session.thread_id='review',l=>l.events[0].session.effective_settings.serviceTier='fast']) {
  const f=fixture();mutate(f.ledger);assert.throws(()=>receipt(f.c,f.ledger));
 }
});
test('required producer list cannot be empty and lock prevents concurrent controllers',async()=>{
 const f=fixture();f.c.requiredChecks=null;assert.throws(()=>config(f.c),/Explicit/);
 const d=await mkdtemp('/tmp/post-pr-lock-');try{
 const c={...fixture().c,stateRoot:d};const lock=join(d,digest('fixture/repo:1'),'lock');await atomic(lock,{pid:1});
 await assert.rejects(runOnce(c),/EEXIST/);
 }finally{await rm(d,{recursive:true,force:true});}
});
test('materializer verifies blob, rejects traversal/truncation, never writes through symlinks',async()=>{
 const d=await mkdtemp('/tmp/post-pr-tree-');try{
 const bytes=Buffer.from('fixture');const sha=createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes])).digest('hex');
 const api=async(m,p)=>p.includes('/trees/')?{sha:'a',truncated:false,tree:[{type:'blob',path:'sub/file',mode:'100755',sha}]}:{encoding:'base64',content:bytes.toString('base64')};
 await materialize(api,'fixture/repo','a',d);assert.equal(await readFile(join(d,'sub/file'),'utf8'),'fixture');
 await assert.rejects(materialize(async()=>({sha:'a',tree:[],truncated:true}),'fixture/repo','a',d),/Incomplete/);
 await assert.rejects(materialize(async()=>({sha:'a',tree:[{type:'blob',path:'../escape',mode:'100644'}]}),'fixture/repo','a',d),/path/);
 }finally{await rm(d,{recursive:true,force:true});}
});
test('fixed command never interprets shell metacharacters',async()=>{
 const r=await command('printf',['%s','$(echo unsafe); echo unsafe']);assert.equal(r.exit,0);assert.equal(r.output.toString(),'$(echo unsafe); echo unsafe');
});

test('fixed Docker harness runs real command path with mock daemon, exact tree, constrained mounts and no auth', async()=>{
 const {writeFile,chmod,mkdir}=await import('node:fs/promises');
 const {validateDocker}=await import('./post-pr-docker.mjs');
 const root=await mkdtemp('/tmp/post-pr-daemon-');const old=process.env.PATH;
 try {
  const trace=join(root,'trace');
  const driver=String.raw`#!${process.execPath}
const fs=require('node:fs');const a=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({args:a,env:process.env})+'\n');
if(a[0]==='build')fs.writeFileSync(a[a.indexOf('--iidfile')+1],'sha256:'+'1'.repeat(64));
if(a[0]==='exec'&&a.includes('/candidate/scripts/test-role-flow.sh')) { if(fs.existsSync(${JSON.stringify(join(root,'fail'))})) {fs.writeSync(1,'failing_harness_case: expected 1, received 2\n74 tests, 1 failures');process.exit(1);} fs.writeSync(1,'74 tests, 0 failures'); }
else if(a[0]==='exec'&&a.includes('/candidate/scripts/post-pr.test.mjs'))fs.writeSync(1,'# tests 35\n# fail 0');
else fs.writeSync(1,'mock daemon response');
`;
  await writeFile(join(root,'docker'),driver,{mode:0o755});process.env.PATH=`${root}:${old}`;
  const f=fixture();f.c.composeImage='docker:cli@sha256:'+'0'.repeat(64);f.c.trustedRoot=root;
  const out=join(root,'evidence');await mkdir(out);
  const result=await validateDocker(f.c,f.p,out,async()=>({sha:f.p.tree,tree:[],truncated:false}));
  assert.equal(result.kind,'passed');assert.equal(result.tests,109);validation(f.c,f.p,result);
  const calls=(await readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(x=>x.args[0]==='build').length,1);
  for(const call of calls) {
   assert.equal(call.env.GITHUB_TOKEN,undefined);assert.equal(call.env.GITHUB_TOKEN_FILE,undefined);
   assert.notEqual(call.env.DOCKER_CONFIG,process.env.DOCKER_CONFIG);
   assert.ok(!call.args.some(x=>/docker\.sock|momoflow-auth|codex-home/.test(x)));
  }
  const compose=calls.find(x=>x.args.includes('compose'));
  assert.ok(compose.args.includes('--read-only'));assert.ok(compose.args.includes('none'));assert.ok(!compose.args.includes('--privileged'));
  const startup=calls.find(x=>x.args.includes('--detach'));
  for(const arg of ['none','ALL','no-new-privileges','1000:1000','--pids-limit','--memory','--cpus'])assert.ok(startup.args.includes(arg));
  assert.ok(startup.args.includes(`seccomp=${root}/security/codex-seccomp.json`));
  assert.equal(calls.at(-1).args[0],'rm');
  await writeFile(join(root,'fail'),'1');
  const failed=await validateDocker(f.c,f.p,out,async()=>({sha:f.p.tree,tree:[],truncated:false}));
  assert.equal(failed.kind,'code_failure');validation(f.c,f.p,failed);
  assert.match(failed.checks.find(x=>x.name==='contracts').diagnostic,/failing_harness_case/);
  f.io.validate=async()=>failed;await reconcile(f.c,f.io);
  assert.match(f.envelope.evidence,/failing_harness_case/);
 }finally{process.env.PATH=old;await rm(root,{recursive:true,force:true});}
});

test('runner generation/worker changes during host validation prevent merge',async()=>{
 for (const worker of [false,true]) {
  const f=fixture();const orig=f.io.validate;f.io.validate=async()=>{const r=await orig();if(worker)f.io.engine=async()=>({running:[{}],retrying:[]});else f.ledger.stage='blocked';return r;};
  await assert.rejects(reconcile(f.c,f.io));assert.equal(f.calls.filter(x=>x.method==='PUT').length,0);
 }
});

test('all context links remain in candidate: absolute, parent, chained, Docker ignores and allowed links',async()=>{
 for(const paths of [
  [['Dockerfile','/tmp/host-canary']], [['.dockerignore','../host-canary']],
  [['Dockerfile.dockerignore','sub/escape'],['sub/escape','../../host-canary']],
  [['Dockerfile','sub/alias'],['sub/alias','/tmp/host-canary']],
  [['Dockerfile','missing']], [['Dockerfile','loop'],['loop','Dockerfile']]
 ]) {
  const d=await mkdtemp('/tmp/post-pr-link-');try {
   const blobs=new Map();const tree=paths.map(([path,target])=>{const bytes=Buffer.from(target);const sha=createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes])).digest('hex');blobs.set(sha,bytes);return {type:'blob',mode:'120000',path,sha};});
   await assert.rejects(materialize(async(m,p)=>p.includes('/trees/')?{sha:'a',tree}:{encoding:'base64',content:blobs.get(p.split('/').at(-1)).toString('base64')},'fixture/repo','a',d));
  }finally{await rm(d,{recursive:true,force:true});}
 }
 const d=await mkdtemp('/tmp/post-pr-link-ok-');try {
  const blobs=new Map();const tree=[['sub/real','FROM scratch','100644'],['sub/alias','real','120000'],['Dockerfile','sub/alias','120000']].map(([path,txt,mode])=>{const bytes=Buffer.from(txt);const sha=createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes])).digest('hex');blobs.set(sha,bytes);return {type:'blob',mode,path,sha};});
  await materialize(async(m,p)=>p.includes('/trees/')?{sha:'a',tree}:{encoding:'base64',content:blobs.get(p.split('/').at(-1)).toString('base64')},'fixture/repo','a',d);
  assert.equal(await readFile(join(d,'Dockerfile'),'utf8'),'FROM scratch');
 }finally{await rm(d,{recursive:true,force:true});}
});

for(const when of ['validation','report','inbox','worker','ledger']) test(`correction reauthorizes after ${when}`,async()=>{
 const f=fixture();f.result.kind='code_failure';Object.assign(f.result.checks.find(x=>x.name==='contracts'),{exit:2,failures:1});
 let revoked=false;f.io.authorize=async()=>{if(revoked)throw Error('revoked');};
 if(when==='validation') {const orig=f.io.validate;f.io.validate=async()=>{const r=await orig();revoked=true;return r;};}
 if(when==='report') {const orig=f.io.api;f.io.api=async(m,p,b)=>{const r=await orig(m,p,b);if(m==='POST'&&p.endsWith('/comments'))revoked=true;return r;};}
 if(when==='inbox') {const orig=f.io.resume;f.io.resume=async e=>{await orig(e);revoked=true;};}
 if(when==='worker'||when==='ledger') {const orig=f.io.validate;f.io.validate=async()=>{const r=await orig();if(when==='worker')f.io.engine=async()=>({running:[{}],retrying:[]});else f.ledger.publication.generation++;return r;};}
 await assert.rejects(reconcile(f.c,f.io));
 if(when!=='inbox')assert.equal(f.envelope,undefined);
 assert.equal(f.calls.filter(x=>x.method==='POST'&&x.path.endsWith('/labels')&&x.body.labels.includes('momoflow:ready')).length,0);
});

for(const state of ['unknown','blocked','absent','unknown-cleanCI','blocked-cleanCI'])test(`routine ${state} waits then proceeds at same head`,async()=>{
 const f=fixture();const path=`GET /repos/fixture/repo/commits/${f.p.head}/check-runs?per_page=100`;
 if(state==='absent')f.responses.set(path,{total_count:0,check_runs:[]});
 else {
  f.responses.set('GET /repos/fixture/repo/pulls/2',{...f.pr(),mergeable:state.startsWith('unknown')?null:true,mergeable_state:state.startsWith('unknown')?'unknown':'blocked'});
  if(!state.endsWith('cleanCI'))f.responses.set(path,{total_count:1,check_runs:[{name:'ci',head_sha:f.p.head,app:{id:42},status:'in_progress'}]});
 }
 assert.ok((await reconcile(f.c,f.io)).waiting);assert.doesNotMatch(f.pad.body,/개입 필요/);assert.equal(f.envelope,undefined);
 assert.equal(f.calls.filter(x=>x.method==='PUT').length,0);
 f.responses.clear();assert.ok((await reconcile(f.c,f.io)).done);
});

for(const changed of ['review','check','thread','rules','mergeability'])test(`complete final gate refresh catches ${changed} during preservation`,async()=>{
 const f=fixture();const orig=f.io.preserve;
 f.io.preserve=async x=>{await orig(x);
  if(changed==='review')f.responses.set('GET /repos/fixture/repo/pulls/2/reviews?per_page=100',[{user:{login:'human'},state:'CHANGES_REQUESTED'}]);
  if(changed==='check')f.responses.set(`GET /repos/fixture/repo/commits/${f.p.head}/check-runs?per_page=100`,{total_count:1,check_runs:[{name:'ci',head_sha:f.p.head,app:{id:42},status:'completed',conclusion:'failure'}]});
  if(changed==='thread')f.responses.set('POST /graphql',{data:{repository:{pullRequest:{reviewThreads:{nodes:[{isResolved:false}],pageInfo:{hasNextPage:false}}}}}});
  if(changed==='rules')f.responses.set('GET /repos/fixture/repo/rules/branches/main?per_page=100',[{type:'merge_queue'}]);
  if(changed==='mergeability')f.responses.set('GET /repos/fixture/repo/pulls/2',{...f.pr(),mergeable:null,mergeable_state:'unknown'});
 };
 if(changed==='mergeability')assert.ok((await reconcile(f.c,f.io)).waiting);else await assert.rejects(reconcile(f.c,f.io));
 assert.equal(f.calls.filter(x=>x.method==='PUT').length,0);assert.notEqual(f.journal.done,true);
});

test('confirmed response and final gate are journaled; merge parent/base verified',async()=>{
 const f=fixture();await reconcile(f.c,f.io);assert.equal(f.journal.mergeAttempt.state,'confirmed');
 assert.equal(f.journal.mergeAttempt.gate.checks[0].head_sha,f.p.head);assert.ok(f.journal.mergeAttempt.gate.checkedAt);
 const bad=fixture();bad.responses.set('GET /repos/fixture/repo/git/commits/'+'f'.repeat(40),{parents:[{sha:'0'.repeat(40)},{sha:bad.p.head}]});
 await assert.rejects(reconcile(bad.c,bad.io),/parent\/base/);assert.equal(bad.calls.filter(x=>x.method==='PATCH'&&x.path.endsWith('/issues/1')).length,0);
});

for(const refusal of ['403','lost','crash'])test(`unqualified merge after ${refusal} never closes or remerges`,async()=>{
 const f=fixture();const orig=f.io.api;let once=true;
 f.io.api=async(m,p,b)=>{
  if(once&&m==='PUT') {once=false;if(refusal==='403')throw Object.assign(Error('denied'),{status:403});if(refusal==='crash')throw Error('crash before effect');await orig(m,p,b);throw Error('lost response');}
  return orig(m,p,b);
 };
 await assert.rejects(reconcile(f.c,f.io));
 assert.equal(f.journal.mergeAttempt.state,refusal==='403'?'rejected':'uncertain');
 f.merged=true;f.responses.set('GET /repos/fixture/repo/pulls/2/reviews?per_page=100',[{state:'CHANGES_REQUESTED',user:{login:'human'}}]);
 await assert.rejects(reconcile(f.c,f.io),/Externally or ambiguously/);
 assert.equal(f.calls.filter(x=>x.method==='PATCH'&&x.path.endsWith('/issues/1')).length,0);
 assert.notEqual(f.journal.done,true);
});

test('diagnostic excerpts are bounded, sanitized, and delivered in head-bound inbox',async()=>{
 const text='\x1b[31mfailing_case: expected 1, received 2\x1b[0m\nAuthorization: Bearer ghp_secret\n'+('x'.repeat(10000));
 const clean=diagnostic(Buffer.from(text));assert.match(clean,/failing_case/);assert.doesNotMatch(clean,/ghp_secret|\x1b/);assert.ok(clean.length<=6100);
 const f=fixture();f.result.kind='code_failure';Object.assign(f.result.checks.find(x=>x.name==='contracts'),{exit:2,failures:1,diagnostic:clean});
 await reconcile(f.c,f.io);const evidence=JSON.parse(f.envelope.evidence);
 assert.match(evidence.checks.find(x=>x.name==='contracts').diagnostic,/failing_case/);assert.equal(evidence.head,f.p.head);assert.ok(Buffer.byteLength(JSON.stringify(f.envelope))<65536);
 const bad=fixture();bad.result.kind='code_failure';Object.assign(bad.result.checks.find(x=>x.name==='contracts'),{exit:2,failures:1,diagnostic:''});await assert.rejects(reconcile(bad.c,bad.io),/diagnostics/);assert.equal(bad.envelope,undefined);
});

test('uncertain request while PR remains open is never automatically retransmitted',async()=>{
 const f=fixture();let puts=0;const orig=f.io.api;
 f.io.api=async(m,p,b)=>{if(m==='PUT'){puts++;throw Error('timeout before result');}return orig(m,p,b);};
 await assert.rejects(reconcile(f.c,f.io),/timeout/);await assert.rejects(reconcile(f.c,f.io),/operator assessment/);
 assert.equal(puts,1);assert.notEqual(f.journal.done,true);
});
test('negative merge response cannot qualify later external merge',async()=>{
 const f=fixture();f.responses.set('PUT /repos/fixture/repo/pulls/2/merge',{merged:false});
 await assert.rejects(reconcile(f.c,f.io),/response not confirmed/);assert.equal(f.journal.mergeAttempt.state,'rejected');
 f.merged=true;await assert.rejects(reconcile(f.c,f.io),/Externally or ambiguously/);assert.notEqual(f.journal.done,true);
});
test('restart after crash before durable confirmed response cannot infer success from intent',async()=>{
 const f=fixture();const save=f.io.save;let crashed=false;
 f.io.save=async j=>{if(j.mergeAttempt?.state==='confirmed'||crashed){crashed=true;throw Error('simulated crash');}await save(j);};
 await assert.rejects(reconcile(f.c,f.io),/crash/);assert.equal(f.journal.mergeAttempt.state,'attempting');
 f.io.save=save;await assert.rejects(reconcile(f.c,f.io),/Externally or ambiguously/);
 assert.equal(f.calls.filter(x=>x.method==='PUT').length,1);assert.equal(f.calls.filter(x=>x.method==='PATCH'&&x.path.endsWith('/issues/1')).length,0);
});

for (const when of ['validation', 'preservation']) test(`source issue closed during ${when} stops merge and preserves closure reason`, async()=>{
 const f=fixture();
 const close=()=>f.responses.set('GET /repos/fixture/repo/issues/1',{state:'closed',state_reason:'not_planned'});
 if(when==='validation') {const orig=f.io.validate;f.io.validate=async()=>{const r=await orig();close();return r;};}
 else {const orig=f.io.preserve;f.io.preserve=async x=>{await orig(x);close();};}
 await assert.rejects(reconcile(f.c,f.io),/Source issue closed/);
 assert.equal(f.calls.filter(x=>x.method==='PUT').length,0);
 assert.equal(f.calls.filter(x=>x.method==='PATCH'&&x.path.endsWith('/issues/1')).length,0);
 assert.notEqual(f.journal.done,true);assert.equal(f.envelope,undefined);
});

test('final merge evidence includes fresh open source issue; confirmed merge recovery respects later closure',async()=>{
 const f=fixture();const orig=f.io.preserve;let n=0;
 f.io.preserve=async x=>{await orig(x);if(++n===2){
  f.responses.set('GET /repos/fixture/repo/issues/1',{state:'closed',state_reason:'not_planned'});
  throw Error('crash after confirmed merge and external issue close');
 }};
 await assert.rejects(reconcile(f.c,f.io),/crash/);
 assert.equal(f.journal.mergeAttempt.gate.issue.state,'open');
 await reconcile(f.c,f.io);
 assert.ok(f.journal.done);assert.equal(f.calls.filter(x=>x.method==='PUT').length,1);
 assert.equal(f.calls.filter(x=>x.method==='PATCH'&&x.path.endsWith('/issues/1')).length,0);
 assert.match(f.pad.body,/closed \(not_planned\)/);
});

test('closure during final report is refreshed before close and never reclassified',async()=>{
 const f=fixture();const orig=f.io.api;
 f.io.api=async(m,p,b)=>{const r=await orig(m,p,b);if(m==='POST'&&p.endsWith('/comments'))
  f.responses.set('GET /repos/fixture/repo/issues/1',{state:'closed',state_reason:'not_planned'});
  return r;
 };
 assert.ok((await reconcile(f.c,f.io)).done);
 assert.equal(f.calls.filter(x=>x.method==='PATCH'&&x.path.endsWith('/issues/1')).length,0);
});

for(const suite of ['contracts','node']) for(const scenario of [
 {label:'exit zero with assertions',exit:0,failures:1,kind:'host_failure'},
 {label:'raw exit two without assertions',exit:2,failures:0,kind:'host_failure'},
 {label:'normal pass',exit:0,failures:0,kind:'passed'},
 {label:'normal assertion failure',exit:1,failures:1,kind:'code_failure'},
 {label:'assertion exit two',exit:2,failures:1,kind:'code_failure'},
 {label:'tool failure',exit:125,failures:0,kind:'host_failure'},
 {label:'tool failure despite assertion summary',exit:125,failures:1,kind:'host_failure'}
]) test(`production harness -> reconcile: ${suite} ${scenario.label}`,async()=>{
 const {writeFile,mkdir}=await import('node:fs/promises');
 const {validateDocker}=await import('./post-pr-docker.mjs');
 const root=await mkdtemp('/tmp/post-pr-summary-');const old=process.env.PATH;
 try {
  const driver=`#!${process.execPath}
const fs=require('node:fs');const a=process.argv.slice(2);
if(a[0]==='build')fs.writeFileSync(a[a.indexOf('--iidfile')+1],'sha256:'+'1'.repeat(64));
const suite=a.includes('/candidate/scripts/test-role-flow.sh')?'contracts':a.includes('/candidate/scripts/post-pr.test.mjs')?'node':null;
if(suite){const failures=suite===${JSON.stringify(suite)}?${scenario.failures}:0;
fs.writeSync(1,suite==='contracts'?'assertion_case\\n74 tests, '+failures+(failures===1?' failure':' failures'):'assertion_case\\n# tests 59\\n# fail '+failures);
process.exit(suite===${JSON.stringify(suite)}?${scenario.exit}:0);}
`;
  await writeFile(join(root,'docker'),driver,{mode:0o755});process.env.PATH=`${root}:${old}`;
  const f=fixture();f.c.composeImage='docker:cli@sha256:'+'0'.repeat(64);f.c.trustedRoot=root;
  const out=join(root,'evidence');await mkdir(out);
  const result=await validateDocker(f.c,f.p,out,async()=>({sha:f.p.tree,tree:[],truncated:false}));
  const check=result.checks.find(x=>x.name===suite);
  assert.equal(check.exit,scenario.exit);assert.equal(check.failures,scenario.failures);
  assert.equal(result.kind,scenario.kind);f.io.validate=async()=>result;
  if(scenario.kind==='host_failure') {
   await assert.rejects(reconcile(f.c,f.io),/Host/);assert.equal(f.envelope,undefined);
   assert.equal(f.calls.filter(x=>x.method==='PUT').length,0);
   assert.equal(f.calls.filter(x=>x.method==='PATCH'&&x.path.endsWith('/issues/1')).length,0);
  } else if(scenario.kind==='code_failure') {
   assert.ok((await reconcile(f.c,f.io)).waiting);assert.ok(f.envelope);
   assert.equal(f.calls.filter(x=>x.method==='PUT').length,0);
   assert.equal(f.ledger.iterations,1);
  } else assert.ok((await reconcile(f.c,f.io)).done);
 }finally{process.env.PATH=old;await rm(root,{recursive:true,force:true});}
});

test('validation independently rejects contradictory assertion evidence and missing failure counts',()=>{
 for(const kind of ['passed','code_failure']) {
  const f=fixture();f.result.kind=kind;
  Object.assign(f.result.checks.find(x=>x.name==='contracts'),kind==='passed'?{exit:0,failures:1}:{exit:2,failures:0});
  assert.throws(()=>validation(f.c,f.p,f.result),/Ambiguous/);
 }
 const f=fixture();delete f.result.checks.find(x=>x.name==='node').failures;
 assert.throws(()=>validation(f.c,f.p,f.result),/Ambiguous/);
});

// Keep launch regressions in the fixed host harness entrypoint.
await import('./launch.test.mjs');
