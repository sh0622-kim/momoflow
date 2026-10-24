import test from 'node:test';
import assert from 'node:assert/strict';
import {digest,reconcile,atomic,json,keyFor} from './post-pr.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {decisionReceipt,holdDecision,applyDecision,connectedDecision} from './decision.mjs';
import {fixture} from './decision-fixture.mjs';
function setup(next='review',iterations=1) {
  const snapshot={head:'a'.repeat(40),diff_sha256:'b'.repeat(64)},reason='Confirm existing-scope continuation';
  const decision={id:'c'.repeat(64),repo:'fixture/repo',issue:'1',generation:1,snapshot,publication:null,launch:null,next,limit:3,reason,content_hash:digest(reason)};
  return fixture({issue:'1',stage:'await_decision',iterations,in_flight:false,active_session:null,decision,events:[{role:next==='build'?'review':'build',result:{status:next==='build'?'changes_requested':'complete',decision:{reason}},after:snapshot}]});
}
test('host preserves checkpoint and reuses workpad section, no dispatch or budget change',async()=>{
 const f=setup();f.labels.push('momoflow:ready');
 await holdDecision(f.c,f.io);await holdDecision(f.c,f.io);
 assert.deepEqual(f.labels,['momoflow:needs-decision']);assert.equal(f.envelope,null);assert.equal(f.ledger.iterations,1);
 assert.equal(f.pad.split('<!-- momoflow:decision:start -->').length,2);assert.equal(f.evidence.length,2);
});
test('same request dispatches once and preserves actor/source evidence; duplicate after consumption never regrants',async()=>{
 const f=setup();await applyDecision(f.c,f.io,f.response);f.labels=[];f.ledger.stage='review';
 assert.equal((await applyDecision(f.c,f.io,f.response)).duplicate,true);
 assert.equal(f.calls.filter(x=>x.m==='POST').length,1);assert.equal(f.envelope.id,f.response.request.id);assert.equal(f.ledger.iterations,1);
 assert.equal(f.evidence[0].actor,'external-operator');
});
for(const [name,mutate] of [
 ['revoked authority',f=>f.c.authority.resume=false],['hold',f=>f.c.hold=true],
 ['worker',f=>f.io.engine=async()=>({running:[{}],retrying:[]})],['retry',f=>f.io.engine=async()=>({running:[],retrying:[{}]})],
 ['stale request',f=>f.response.request={...f.response.request,generation:0}],
 ['changed snapshot',f=>f.ledger.events[0].after={head:'d'.repeat(40)}],
 ['other request',f=>f.response.unresolved.push('other')],['other review',f=>f.labels.push('momoflow:needs-review')],
 ['unauthorized actor',f=>f.response.actor='github-comment'],['no source',f=>f.response.source=''],['prefix source',f=>f.response.source='https://github.com/fixture/repo/issues/10'],
 ['unreleased ledger',f=>f.ledger.in_flight=true],['active session',f=>f.ledger.active_session={thread:'a'}],
 ['bad content hash',f=>f.ledger.decision.content_hash='0'.repeat(64)]
])test('no dispatch: '+name,async()=>{const f=setup();mutate(f);await assert.rejects(applyDecision(f.c,f.io,f.response));assert.equal(f.envelope,null);assert.equal(f.records.size,0);assert.ok(f.calls.every(x=>x.m==='GET'));});
test('reject remains held; later reordered continue cannot override it',async()=>{
 const f=setup();f.response.action='reject';await applyDecision(f.c,f.io,f.response);assert.equal(f.envelope,null);assert.ok(f.labels.includes('momoflow:needs-decision'));
 f.response.action='continue';await assert.rejects(applyDecision(f.c,f.io,f.response),/Different/);
});
test('exhausted budget rejects build, final review still allowed; remaining one uses existing count',async()=>{
 for(const [next,count,pass]of[['build',3,false],['build',2,true],['review',3,true]]){
  const f=setup(next,count);if(pass)await applyDecision(f.c,f.io,f.response);else await assert.rejects(applyDecision(f.c,f.io,f.response),/exhausted/);assert.equal(f.ledger.iterations,count);
 }
});
test('lost dispatch response is uncertain, duplicate never grants ready again',async()=>{
 const f=setup(),api=f.io.api;let grants=0;
 f.io.api=async(m,p,b)=>{const r=await api(m,p,b);if(m==='POST'&&b.labels.includes('momoflow:ready')){grants++;throw Error('lost');}return r;};
 await assert.rejects(applyDecision(f.c,f.io,f.response),/lost/);await assert.rejects(applyDecision(f.c,f.io,f.response),/Uncertain/);assert.equal(grants,1);
});
test('revocation after inbox write prevents dispatch',async()=>{
 const f=setup();f.io.resume=async e=>{f.envelope=e;f.c.authority.resume=false;};
 await assert.rejects(applyDecision(f.c,f.io,f.response),/authority/);assert.ok(!f.labels.includes('momoflow:ready'));
});
test('confirmed dispatch survives repeated pre-claim reconciliation and duplicate response without any new mutation',async()=>{
 const f=setup();await applyDecision(f.c,f.io,f.response);const before=f.calls.length,envelope=structuredClone(f.envelope);
 for(let i=0;i<2;i++)assert.match((await reconcile(f.c,f.io)).waiting,/consumption pending/);
 assert.equal((await applyDecision(f.c,f.io,f.response)).duplicate,true);
 assert.deepEqual(f.labels,['momoflow:ready']);assert.deepEqual(f.envelope,envelope);
 assert.ok(f.calls.slice(before).every(x=>x.m==='GET'));assert.equal(f.ledger.iterations,1);
 // Consumption is owned by RoleRunner: once it advances, host follows ordinary role progress.
 f.ledger.stage='review';f.ledger.decision=null;
 assert.equal((await reconcile(f.c,f.io)).waiting,'Role flow progress');
});
test('a dispatched journal cannot authorize a different request or regrant a removed signal',async()=>{
 const f=setup();await applyDecision(f.c,f.io,f.response);f.labels=[];const before=f.calls.length;
 await assert.rejects(reconcile(f.c,f.io),/signal changed/);
 assert.ok(f.calls.slice(before).every(x=>x.m==='GET'));
 f.labels=['momoflow:ready'];f.ledger.decision.reason='Changed request';f.ledger.decision.content_hash=digest('Changed request');f.ledger.events[0].result.decision.reason='Changed request';
 await assert.rejects(reconcile(f.c,f.io),/Stale or invalid decision response/);
});
test('checkpoint with no reported decision label dispatches without DELETE and verifies fresh absence',async()=>{
 const f=setup();f.labels=[];const api=f.io.api;let fresh=false;
 f.io.api=async(m,p,b)=>{
  if(m==='DELETE')throw Object.assign(Error('absent label'),{status:404});
  if(m==='GET'&&p.endsWith('/labels?per_page=100')&&f.envelope)fresh=true;
  if(m==='POST')assert.equal(fresh,true);
  return api(m,p,b);
 };
 assert.equal((await applyDecision(f.c,f.io,f.response)).state,'dispatched');
 assert.deepEqual(f.labels,['momoflow:ready']);assert.equal((await applyDecision(f.c,f.io,f.response)).duplicate,true);
});
for(const [name,status,remove,pass]of[['concurrent absence',404,true,true],['still present',404,false,false],['forbidden',403,true,false],['server failure',500,true,false]])
test('decision label removal '+name+' requires verified absence and only tolerates 404',async()=>{
 const f=setup(),api=f.io.api;let deletes=0;
 f.io.api=async(m,p,b)=>{if(m==='DELETE'){deletes++;if(remove)f.labels=[];throw Object.assign(Error('delete failed'),{status});}return api(m,p,b);};
 if(pass){assert.equal((await applyDecision(f.c,f.io,f.response)).state,'dispatched');assert.deepEqual(f.labels,['momoflow:ready']);}
 else {await assert.rejects(applyDecision(f.c,f.io,f.response),status===404?/Unresolved/:/delete failed/);assert.ok(!f.labels.includes('momoflow:ready'));await assert.rejects(applyDecision(f.c,f.io,f.response),/Uncertain/);}
 assert.equal(deletes,1);assert.equal(f.ledger.iterations,1);
});

for(const [name,mutate,pattern]of[
 ['other worker',f=>{f.io.engine=async()=>({running:[{issue_id:'2'}],retrying:[]});},/Other Symphony/],
 ['other retry',f=>{f.io.engine=async()=>({running:[],retrying:[{issue_id:'2'}]});},/Other Symphony/],
 ['unknown engine',f=>{f.io.engine=async()=>({});},/Unknown engine/],
 ['authority revoked',f=>{f.c.authority.resume=false;},/authority/],
 ['hold',f=>{f.c.hold=true;},/authority/],
 ['issue scope',f=>{f.ledger.issue='2';},/scope/],
 ['budget tamper',f=>{f.ledger.iterations=4;},/budget/],
 ['wrong consumption',f=>{f.ledger.decisions=[{decision_id:f.response.request.id,response:{}}];},/consumption changed/],
 ['historical event tamper',f=>{f.ledger.events[0].after={head:'d'.repeat(40)};},/snapshot/]
])test('confirmed dispatch remains fail closed: '+name,async()=>{
 const f=setup();await applyDecision(f.c,f.io,f.response);const observed=structuredClone(f.ledger),before=f.calls.length;
 mutate(f);await assert.rejects(holdDecision(f.c,f.io,observed),pattern);
 assert.ok(f.calls.slice(before).every(x=>x.m==='GET'));assert.equal(f.records.get(f.response.request.id).state,'dispatched');
});
test('ready disappearance is accepted only after fresh same-request claim or consumption evidence',async()=>{
 for(const consume of [false,true]){
  const f=setup();await applyDecision(f.c,f.io,f.response);const api=f.io.api,before=f.calls.length;
  let reads=0;const engine=f.io.engine;
  f.io.engine=async()=>{reads++;return engine();};
  f.io.api=async(m,p,b)=>{
   if(p.endsWith('/labels?per_page=100')){
    f.labels=[];
    if(consume){f.ledger.stage='review';f.ledger.decision=null;f.ledger.decisions=[{decision_id:f.response.request.id,response:f.envelope}];}
    else f.io.engine=async()=>{reads++;return {running:[{issue_id:'1'}],retrying:[]};};
   }
   return api(m,p,b);
  };
  assert.match((await reconcile(f.c,f.io)).waiting,/consumption pending/);assert.ok(reads>=3);
  assert.ok(f.calls.slice(before).every(x=>x.m==='GET'));assert.deepEqual(f.labels,[]);
 }
});

// Real connectedDecision files with simulated GitHub/runner transitions; no live models,
// workers or credentials. Read the actual inbox when simulating durable consumption.
async function durableDispatch(t,next='review',iterations=1) {
 const f=setup('review',iterations),d=f.ledger.decision;
 f.c.launch=f.ledger.launch=d.launch={v:1,id:'a'.repeat(64),repo:f.c.repo,issue:f.c.issue,base:f.c.base,limit:3};
 d.next=next;f.ledger.events[0].role=next==='build'?'review':next==='publish'?'review':next==='await_validation'?'publish':'build';
 if(next==='build')f.ledger.events[0].result.status='changes_requested';
 if(next==='await_validation') {
   d.publication={repo:f.c.repo,issue:f.c.issue,pr:2,base:f.c.base,head:'d'.repeat(40),base_head:'e'.repeat(40),tree:'f'.repeat(40),generation:1,snapshot:d.snapshot,review_thread:'review-fixture'};
   f.ledger.publication=d.publication;
 }
 const root=await mkdtemp('/tmp/decision-dispatch-');t.after(()=>rm(root,{recursive:true,force:true}));
 f.c.stateRoot=join(root,'host');f.c.inboxRoot=join(root,'inbox');
 const key=keyFor(f.c),ledgerPath=join(root,'ledger.json');await atomic(ledgerPath,f.ledger);
 f.io.ledger=()=>json(ledgerPath);
 const envelopePath=join(f.c.inboxRoot,key+'.json'),journalPath=join(f.c.stateRoot,key,`decision-${d.id}.json`);
 const consume=async mutate=>{
   const envelope=await json(envelopePath),l=await json(ledgerPath);
   // Match the runner's count ownership: only a resumed build increments usage.
   Object.assign(l,{stage:next,decision:null,in_flight:next!=='await_validation',iterations:l.iterations+(next==='build'?1:0),
     decisions:[{decision_id:d.id,response:Object.fromEntries(Object.entries(envelope).sort())}]});
   mutate?.(l);await atomic(ledgerPath,l);f.labels=[];
 };
 return {f,d,consume,ledger:()=>json(ledgerPath),journal:()=>json(journalPath),envelope:()=>json(envelopePath)};
}
for(const next of ['build','review','publish','await_validation'])
for(const timing of ['POST acknowledgement','before labels read','after labels read'])
test(`successful ready grant consumed at ${timing}: ${next} dispatches once durably`,async t=>{
 const h=await durableDispatch(t,next,next==='build'?2:3),{f,d}=h,api=f.io.api;
 let granted=false,grants=0,consumptions=0;
 const consume=async()=>{consumptions++;await h.consume();};
 f.io.api=async(m,p,b)=>{
   const readback=granted&&m==='GET'&&p.endsWith('/labels?per_page=100');
   if(readback&&timing==='before labels read')await consume();
   const value=await api(m,p,b);
   if(m==='POST'&&b?.labels?.includes('momoflow:ready')) {
     granted=true;grants++;if(timing==='POST acknowledgement')await consume();
   }
   if(readback&&timing==='after labels read')await consume();
   return value;
 };
 assert.deepEqual(await connectedDecision(f.c,f.io,f.response),{decision:d.id,state:'dispatched'});
 const journal=await h.journal(),l=await h.ledger();
 assert.equal(journal.state,'dispatched');assert.deepEqual(journal.response,f.response);
 assert.equal(l.stage,next);assert.equal(l.iterations,3);assert.equal(l.decisions.length,1);
 assert.equal(l.events.length,1);assert.equal(l.active_session,null);assert.equal(l.in_flight,next!=='await_validation');
 assert.deepEqual(l.decisions[0].response,await h.envelope());assert.equal(consumptions,1);
 assert.deepEqual(f.labels,[]);
 const before=f.calls.length;
 assert.equal((await connectedDecision(f.c,f.io,f.response)).duplicate,true);
 assert.equal(f.calls.length,before);assert.equal(grants,1);assert.equal((await h.ledger()).iterations,3);
});
for(const [name,mutate]of[
 ['missing consumption',l=>{l.decisions=[];}],
 ['another request',l=>{l.decisions[0].decision_id='0'.repeat(64);}],
 ['mismatched source',l=>{l.decisions[0].response.source+='0';}],
 ['mismatched request',l=>{l.decisions[0].response.request.generation=0;}],
 ['mismatched envelope kind',l=>{l.decisions[0].response.kind='code_failure';}],
 ['duplicate consumption',l=>{l.decisions.push(structuredClone(l.decisions[0]));}],
 ['issue scope',l=>{l.issue='2';}],
 ['over budget',l=>{l.iterations=4;}],
 ['launch limit changed',l=>{l.launch.limit=2;}],
 ['changed history',l=>{l.events[0].after={head:'e'.repeat(40)};}]
])test('absent ready with '+name+' remains uncertain without regrant',async t=>{
 const h=await durableDispatch(t),{f}=h,api=f.io.api;let grants=0;
 f.io.api=async(m,p,b)=>{const value=await api(m,p,b);if(m==='POST'&&b?.labels?.includes('momoflow:ready')){grants++;await h.consume(mutate);}return value;};
 await assert.rejects(connectedDecision(f.c,f.io,f.response));assert.equal((await h.journal()).state,'dispatching');
 const before=f.calls.length;await assert.rejects(connectedDecision(f.c,f.io,f.response),/Uncertain/);
 assert.equal(grants,1);assert.equal(f.calls.length,before);assert.deepEqual(f.labels,[]);
});
for(const boundary of ['lost POST response','labels read failed','ledger read failed','authority revoked','other worker','unknown engine','issue closed'])
test('exact consumption with '+boundary+' retains uncertain dispatch',async t=>{
 const h=await durableDispatch(t,'await_validation'),{f}=h,api=f.io.api;let granted=false,grants=0;
 const ledger=f.io.ledger,engine=f.io.engine;
 f.io.ledger=async()=>{if(granted&&boundary==='ledger read failed')throw Error('ledger unavailable');return ledger();};
 f.io.engine=async()=>{
   if(granted&&boundary==='other worker')return {running:[{issue_id:'2'}],retrying:[]};
   if(granted&&boundary==='unknown engine')return {};
   return engine();
 };
 f.io.api=async(m,p,b)=>{
   if(granted&&boundary==='labels read failed'&&p.endsWith('/labels?per_page=100'))throw Error('read failed');
   if(granted&&boundary==='issue closed'&&p.endsWith('/issues/1'))return {number:1,state:'closed'};
   const value=await api(m,p,b);
   if(m==='POST'&&b?.labels?.includes('momoflow:ready')){
     granted=true;grants++;await h.consume();
     if(boundary==='lost POST response')throw Error('lost POST response');
     if(boundary==='authority revoked')f.c.authority.resume=false;
   }
   return value;
 };
 await assert.rejects(connectedDecision(f.c,f.io,f.response));assert.equal((await h.journal()).state,'dispatching');
 const before=f.calls.length;await assert.rejects(connectedDecision(f.c,f.io,f.response),/Uncertain/);
 assert.equal(grants,1);assert.equal(f.calls.length,before);
});
