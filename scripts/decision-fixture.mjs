// Mock remote effects around real host decision code, also called by the Elixir process tests.
import {connectedDecision} from './decision.mjs';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {reconcile} from './post-pr.mjs';
export function fixture(ledger) {
  const c={repo:'fixture/repo',issue:'1',base:'main',authority:{validate:true,resume:true,merge:false,close:false},hold:false,stateRoot:'/tmp/unused',
    controllerVersion:'c'.repeat(40),engineURL:'http://127.0.0.1:4000',inboxRoot:'/tmp/inbox',ledgerRoot:'/tmp/ledger',tokenFile:'/tmp/token',trustedRoot:'/tmp/trusted',requiredChecks:[],requiredReviewers:[],
    ...(ledger.launch?{launch:ledger.launch}:{})};
  const f={c,ledger,labels:['momoflow:needs-decision'],calls:[],records:new Map(),envelope:null,evidence:[],pad:'<!-- momoflow:workpad -->\n누적 반복 1 / 3'};
  f.io={authorize:async()=>{},ledger:async()=>structuredClone(f.ledger),engine:async()=>({running:[],retrying:[]}),
    loadDecision:async id=>structuredClone(f.records.get(id)),saveDecision:async(id,r)=>{f.records.set(id,structuredClone(r));},
    resume:async e=>{f.envelope=structuredClone(e);},preserve:async e=>{f.evidence.push(structuredClone(e));},
    api:async(m,p,b)=>{
      f.calls.push({m,p,b});const root='/repos/fixture/repo';
      if(m==='GET'&&p===root+'/issues/1')return {state:'open',number:1};
      if(m==='GET'&&p===root+'/pulls/2')return {state:'open',head:{sha:ledger.publication.head,repo:{full_name:c.repo}},base:{ref:c.base,sha:ledger.publication.base_head,repo:{full_name:c.repo}}};
      if(m==='GET'&&p.includes('issues?'))return f.labels.includes('momoflow:ready')?[{number:1}]:[];
      if(m==='GET'&&p.endsWith('/comments?per_page=100'))return [{id:12,body:f.pad}];
      if(m==='PATCH'&&p.endsWith('/comments/12')){f.pad=b.body;return {};}
      if(m==='GET'&&p.endsWith('/labels?per_page=100'))return p.includes('/issues/2/')?[]:f.labels.map(name=>({name}));
      if(m==='DELETE'){f.labels=f.labels.filter(x=>!p.endsWith(encodeURIComponent(x)));return {};}
      if(m==='POST'&&p.endsWith('/labels')){f.labels.push(...b.labels);return {};}
      throw Error('Unexpected '+m+' '+p);
    }};
  f.response={request:ledger.decision,action:'continue',actor:'external-operator',authority:'existing-scope',unresolved:[ledger.decision.id],source:'https://github.com/fixture/repo/issues/1#issuecomment-123'};
  return f;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [ledgerFile,inbox,stateRoot]=process.argv.slice(2),ledger=JSON.parse(await readFile(ledgerFile,'utf8')),f=fixture(ledger);
  Object.assign(f.c,{stateRoot,inboxRoot:inbox});
  const result=await connectedDecision(f.c,f.io,f.response),before=f.calls.length;
  // New controller read: real durable journal, not the in-memory test map. Still before engine claim.
  delete f.io.loadDecision;
  assert.match((await reconcile(f.c,f.io)).waiting,/consumption pending/);
  assert.ok(f.calls.slice(before).every(x=>x.m==='GET'));
  assert.deepEqual(f.labels,['momoflow:ready']);
  assert.equal((await connectedDecision(f.c,f.io,f.response)).duplicate,true);
  console.log(JSON.stringify(result));
}
