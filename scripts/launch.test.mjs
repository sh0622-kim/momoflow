// Imported by the existing pinned host harness via post-pr.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from './post-pr-fixture.mjs';
import {launch,launchConfig,authMetadata} from './launch.mjs';
import {digest,budget,reconcile,withControllerLock,atomic} from './post-pr.mjs';
function setup() {
  const c={...fixture().c,authority:{...fixture().c.authority,launch:true},launchId:'a'.repeat(64),iterationLimit:2,launchRoot:'/tmp/launch',runnerSource:'s',composeImage:'docker:cli@sha256:'+'0'.repeat(64)};
  launchConfig(c);
  const f={c,calls:[],intent:null,manifest:null,ledger:null,labels:[],pads:[],sleeps:0,reconciles:0};
  f.state={running:[],retrying:[],momoflow_launch:{contract:1,source:'s',repo:c.repo,concurrency:1,role_flow:true,launch_root:'/run/momoflow-launch',inbox_root:'/run/momoflow-resume',launch_read_only:true,inbox_read_only:true}};
  f.api=async(m,p,b)=>{
    f.calls.push({m,p,b});const root='/repos/fixture/repo';
    if(m==='GET'&&p===root)return {full_name:c.repo,archived:false,disabled:false};
    if(m==='GET'&&p===root+'/issues/1')return {number:1,state:'open',labels:f.labels.map(name=>({name}))};
    if(m==='GET'&&p===root+'/branches/main')return {name:'main'};
    if(m==='GET'&&p.includes('issues?'))return f.labels.includes('momoflow:ready')?[{number:1}]:[];
    if(m==='GET'&&p.endsWith('/comments?per_page=100'))return structuredClone(f.pads);
    if(m==='POST'&&p.endsWith('/comments')) {f.pads.push({id:12,body:b.body});return {};}
    if(m==='PATCH'&&p.includes('/issues/comments/12')) {f.pads[0].body=b.body;return {};}
    if(m==='GET'&&p.endsWith('/labels?per_page=100'))return f.labels.map(name=>({name}));
    if(m==='POST'&&p.endsWith('/labels')) {f.labels.push(...b.labels);return {};}
    if(m==='DELETE'&&p.endsWith('/labels/momoflow%3Aready')) {f.labels=[];return {};}
    throw Error('Unexpected '+m+' '+p);
  };
  f.io={settings:'settings',api:(...args)=>f.api(...args),authorize:async()=>{},engine:async()=>{const state=structuredClone(f.state);state.momoflow_launch.manifest=f.engineManifest===undefined?(f.manifest?{status:'present',value:structuredClone(f.manifest)}:{status:'absent'}):structuredClone(f.engineManifest);return state;},
    load:async()=>structuredClone(f.intent),save:async x=>{f.intent=structuredClone(x);},
    ledger:async()=>structuredClone(f.ledger),manifest:async()=>structuredClone(f.manifest),controllers:async()=>{},
    install:async m=>{assert.equal(f.manifest,null);f.manifest=structuredClone(m);},
    sleep:async()=>{f.sleeps++;f.ledger={launch:c.launch,stage:'plan',in_flight:false};},
    reconcile:async()=>{f.reconciles++;return {done:true};}};
  return f;
}
test('launch read-only preflight has zero local/remote mutations or model dispatch',async()=>{
  const f=setup();for(const k of ['save','install','sleep','reconcile']) f.io[k]=async()=>assert.fail(k);
  assert.equal((await launch(f.c,f.io,{preflight:true})).limit,2);
  assert.ok(f.calls.every(x=>x.m==='GET'));assert.equal(f.manifest,null);assert.equal(f.intent,null);
});
test('one explicit launch persists intent/manifest before ready, waits for missing ledger, then reuses reconcile',async()=>{
  const f=setup(),api=f.api;
  f.api=async(m,p,b)=>{if(m==='POST'&&p.endsWith('/labels')&&b.labels.includes('momoflow:ready')) {assert.ok(f.intent);assert.deepEqual(f.manifest,f.c.launch);assert.equal(f.reconciles,0);}return api(m,p,b);};
  assert.deepEqual(await launch(f.c,f.io),{done:true});
  assert.equal(f.sleeps,1);assert.equal(f.reconciles,1);assert.ok(f.intent.observed&&f.intent.done);
  assert.equal(f.calls.filter(x=>x.m==='POST'&&x.p.endsWith('/labels')).length,1);
  assert.match(f.pads[0].body,/runner ledger 생성 전 정상 준비 대기/);
  await assert.rejects(launch(f.c,f.io),/terminal/);
});
for(const [name,mutate,pattern] of [
  ['closed',f=>{const api=f.api;f.api=async(m,p,b)=>p.endsWith('/issues/1')?{state:'closed',number:1}:api(m,p,b);},/closed/],
  ['wrong scope',f=>f.state.momoflow_launch.repo='other/repo',/mismatch/],
  ['wrong installed code',f=>f.state.momoflow_launch.source='other',/mismatch/],
  ['writable mount',f=>f.state.momoflow_launch.launch_read_only=false,/mismatch/],
  ['concurrency',f=>f.state.momoflow_launch.concurrency=2,/mismatch/],
  ['unknown state',f=>delete f.state.running,/Unknown/],
  ['other running',f=>f.state.running=[{issue_id:'2'}],/running/],
  ['other retry',f=>f.state.retrying=[{issue_id:'2'}],/running/],
  ['already ready',f=>f.labels=['momoflow:ready'],/already ready/],
  ['missing enrolled ledger',f=>f.io.enrollment=async()=>true,/Enrolled ledger missing/],
  ['legacy ledger',f=>f.ledger={stage:'await_validation'},/adopted/],
  ['old manifest',f=>f.manifest=f.c.launch,/manifest/],
  ['hold',f=>f.c.hold=true,/hold/],
  ['launch permission',f=>f.c.authority.launch=false,/authority/],
  ['auth failure',f=>f.io.authorize=async()=>{throw Error('GitHub App token write permission missing');},/permission/],
  ['terminal existing',f=>{f.intent={contract:digest(f.c.launch),settings:'settings',dispatched:true};f.manifest=f.c.launch;f.ledger={launch:f.c.launch,stage:'blocked'};},/Terminal/],
  ['lost ledger',f=>{f.intent={contract:digest(f.c.launch),settings:'settings',dispatched:true,observed:true};f.manifest=f.c.launch;},/disappeared/],
  ['changed limit',f=>{f.intent={contract:digest(f.c.launch),settings:'settings',dispatched:true};f.manifest=f.c.launch;f.c.iterationLimit=3;},/manifest/],
  ['partial intent',f=>{f.intent={contract:digest(f.c.launch),settings:'settings',dispatched:false};f.manifest=f.c.launch;},/Partial/]
]) test('launch blocks '+name+' before effects',async()=>{
  const f=setup();mutate(f);await assert.rejects(launch(f.c,f.io,{preflight:true}),pattern);assert.ok(f.calls.every(x=>x.m==='GET'));
});
test('lost ready response preserves intent, removes ready and blocks re-entry; no second dispatch',async()=>{
  const f=setup(),api=f.api;let grants=0;
  f.api=async(m,p,b)=>{const r=await api(m,p,b);if(m==='POST'&&p.endsWith('/labels')&&b.labels.includes('momoflow:ready')) {grants++;throw Error('lost response');}return r;};
  await assert.rejects(launch(f.c,f.io),/lost response/);
  assert.ok(!f.labels.includes('momoflow:ready'));assert.match(f.intent.blocker,/lost response/);assert.match(f.pads[0].body,/개입 필요/);
  await assert.rejects(launch(f.c,f.io),/terminal/);assert.equal(grants,1);
});
test('restart of confirmed dispatch observes same intent without another ready grant',async()=>{
  const f=setup();f.intent={contract:digest(f.c.launch),settings:'settings',dispatched:true,started:Date.now()};f.manifest=f.c.launch;f.labels=['momoflow:ready'];
  await launch(f.c,f.io);assert.equal(f.calls.filter(x=>x.m==='POST'&&x.p.endsWith('/labels')).length,0);assert.ok(f.intent.done);
});
test('pre-ledger timeout stops once and preserves recovery evidence',async()=>{
  const f=setup();f.intent={contract:digest(f.c.launch),settings:'settings',dispatched:true,started:0};f.manifest=f.c.launch;f.labels=['momoflow:ready'];
  await assert.rejects(launch(f.c,f.io),/deadline/);assert.equal(f.sleeps,0);assert.ok(f.intent.blocker);assert.ok(!f.labels.includes('momoflow:ready'));
});
test('exclusive engine-wide ownership blocks same and other scopes across watch sleep; stale lock never expires',async()=>{
  const root=await mkdtemp('/tmp/launch-lock-');const f=setup();f.c.stateRoot=root;
  try {
    await withControllerLock(f.c,async()=>{
      await Promise.resolve();
      for(const issue of ['1','2']) await assert.rejects(withControllerLock({...f.c,issue},async()=>assert.fail('duplicate')),/EEXIST/);
    });
    await atomic(join(root,'controller.lock'),{pid:99999999});
    await assert.rejects(withControllerLock(f.c,async()=>assert.fail('stale')),/EEXIST/);
  } finally {await rm(root,{recursive:true,force:true});}
});
for(const limit of [1,2,3]) test(`host uses persisted limit ${limit} and rechecks before inbox`,async()=>{
  const f=fixture();f.c.launch={v:1,id:'a'.repeat(64),repo:f.c.repo,issue:f.c.issue,base:f.c.base,limit};f.ledger.launch=structuredClone(f.c.launch);f.ledger.iterations=limit;
  f.result.kind='code_failure';Object.assign(f.result.checks.find(x=>x.name==='contracts'),{exit:2,failures:1});
  assert.equal(budget(f.c,f.ledger),limit);await assert.rejects(reconcile(f.c,f.io),/exhausted/);assert.equal(f.envelope,undefined);
});
test('host rejects dropped/changed launch config and budget drift during resume guard',async()=>{
  const f=fixture();f.c.launch={v:1,id:'a'.repeat(64),repo:f.c.repo,issue:'1',base:'main',limit:2};f.ledger.launch=structuredClone(f.c.launch);
  const original=f.c.launch;delete f.c.launch;assert.throws(()=>budget(f.c,f.ledger),/missing/);f.c.launch={...original,limit:3};assert.throws(()=>budget(f.c,f.ledger),/changed/);
  f.c.launch=original;f.result.kind='code_failure';Object.assign(f.result.checks.find(x=>x.name==='contracts'),{exit:2,failures:1});
  const authorize=f.io.authorize;let n=0;f.io.authorize=async()=>{await authorize?.();if(++n===2)f.ledger.iterations=2;};
  await assert.rejects(reconcile(f.c,f.io),/exhausted/);assert.equal(f.envelope,undefined);
});

test('issuer metadata blocks expired, unscoped, missing and insufficient actual token permissions',()=>{
  const c=setup().c;
  const token={repository:c.repo,expires_at:new Date(Date.now()+3600000).toISOString(),permissions:{contents:'write',issues:'write',pull_requests:'write',checks:'read'}};
  authMetadata(c,token);
  for(const mutate of [t=>delete t.permissions,t=>t.permissions.issues='read',t=>t.repository='other/repo',t=>t.expires_at='invalid',t=>delete t.permissions.checks]) {
    const t=structuredClone(token);mutate(t);assert.throws(()=>authMetadata(c,t));
  }
});

test('controller human-review waiting remains normal waiting on subsequent launch cycles',async()=>{
  const f=setup();let n=0;
  f.io.reconcile=async()=>{f.reconciles++;if(++n===1){f.labels=['momoflow:needs-review'];return {waiting:'Human review human'};}return {done:true};};
  await launch(f.c,f.io);assert.equal(f.reconciles,2);assert.ok(!f.intent.blocker);
});

test('manifest install failure before or after file creation preserves intent and never grants ready',async()=>{
  for(const after of [false,true]) {
    const f=setup();f.io.install=async m=>{if(after)f.manifest=m;throw Error('install interrupted');};
    await assert.rejects(launch(f.c,f.io),/interrupted/);assert.ok(f.intent.blocker);
    assert.equal(f.calls.filter(x=>x.m==='POST'&&x.b?.labels?.includes('momoflow:ready')).length,0);
    assert.ok(f.labels.includes('momoflow:needs-decision'));
    await assert.rejects(launch(f.c,f.io),/terminal/);
  }
});
test('small budget requires explicit integer 1..3 and existing usage cannot seed a new launch',async()=>{
  for(const limit of [0,4,'2',null]) {const f=setup();f.c.iterationLimit=limit;assert.throws(()=>launchConfig(f.c),/iterationLimit/);}
  for(const used of [1,10,20]) {
    const f=setup();f.pads=[{id:12,body:`<!-- momoflow:workpad -->\n| 누적 반복 | ${used} / 3 |`}];
    await assert.rejects(launch(f.c,f.io,{preflight:true}),/workpad use/);
    assert.ok(f.calls.every(x=>x.m==='GET'));
  }
});

for(const pin of [undefined, '', 'docker:latest', 'docker@sha256:abc', 'docker@sha256:'+'G'.repeat(64)]) {
  test(`launch rejects missing/malformed Compose pin ${pin} before any effects`,async()=>{
    for(const preflight of [true,false]) {
      const f=setup();f.c.composeImage=pin;
      for(const k of ['save','install','sleep','reconcile']) f.io[k]=async()=>assert.fail(k);
      await assert.rejects(launch(f.c,f.io,{preflight}),/Pinned trusted Compose image required/);
      assert.equal(f.calls.length,0);assert.equal(f.intent,null);
    }
  });
}
for(const state of [undefined,{status:'invalid'},{status:'present',value:{}}]) {
  test(`preflight rejects incompatible engine-visible manifest ${JSON.stringify(state)}`,async()=>{
    const f=setup();f.io.engine=async()=>({...f.state,momoflow_launch:{...f.state.momoflow_launch,manifest:state}});
    await assert.rejects(launch(f.c,f.io,{preflight:true}),/Engine-visible launch manifest/);
    assert.equal(f.intent,null);assert.equal(f.manifest,null);assert.ok(f.calls.every(x=>x.m==='GET'));
  });
}
for(const wrong of ['empty bind','different identity','different limit','different base','different scope','malformed']) {
  test(`installed engine ${wrong} blocks ready and dispatch`,async()=>{
    const f=setup(),install=f.io.install;
    f.io.install=async m=>{
      await install(m);
      const value={...m};
      if(wrong==='different identity')value.id='b'.repeat(64);
      if(wrong==='different limit')value.limit=3;
      if(wrong==='different base')value.base='other';
      if(wrong==='different scope')value.issue='2';
      f.engineManifest=wrong==='empty bind'?{status:'absent'}:wrong==='malformed'?{status:'invalid'}:{status:'present',value};
    };
    await assert.rejects(launch(f.c,f.io),/Engine-visible launch manifest/);
    assert.ok(f.intent.blocker);assert.equal(f.reconciles,0);assert.equal(f.ledger,null);
    assert.equal(f.calls.filter(x=>x.m==='POST'&&x.b?.labels?.includes('momoflow:ready')).length,0);
    await assert.rejects(launch(f.c,f.io),/terminal/);
  });
}
test('fresh check detects engine manifest drift immediately before ready',async()=>{
  const f=setup(),api=f.api;
  f.api=async(m,p,b)=>{const r=await api(m,p,b);if(m==='POST'&&p.endsWith('/comments'))f.engineManifest={status:'absent'};return r;};
  await assert.rejects(launch(f.c,f.io),/Engine-visible launch manifest/);
  assert.equal(f.calls.filter(x=>x.m==='POST'&&x.b?.labels?.includes('momoflow:ready')).length,0);
  assert.equal(f.reconciles,0);
});
