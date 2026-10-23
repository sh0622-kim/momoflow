// Mock external ports for contract tests; never used by the controller CLI.
import assert from 'node:assert/strict';
import {digest} from './post-pr.mjs';
export function fixture(ledgerInput) {
  const head = 'a'.repeat(40), tree = 'b'.repeat(40);
  const c = { repo: 'fixture/repo', issue: '1', base: 'main', controllerVersion: 'c'.repeat(40), engineURL: 'http://127.0.0.1:4000',
    stateRoot: '/tmp/state', inboxRoot: '/tmp/inbox', ledgerRoot: '/tmp/ledger', tokenFile: '/tmp/token', trustedRoot: '/tmp/trusted',
    requiredChecks: [{name:'ci', appId:42}], requiredReviewers: [], authority: {validate:true,resume:true,merge:true,close:true}, hold:false };
  const snapshot = {head:'d'.repeat(40),diff_sha256:'e'.repeat(64)};
  const event = (role, id) => ({role,result:{status:'complete'},after:snapshot,session:{thread_id:id,effective_settings:{
    model:role === 'review' ? 'gpt-6-astra':'gpt-6.1-sol', reasoningEffort:role === 'review'?'high':'medium',serviceTier:'default',
    sandbox:{type:'workspaceWrite',networkAccess:false},approvalPolicy:{granular:Object.fromEntries(['sandbox_approval','rules','mcp_elicitations','request_permissions','skill_approval'].map(k=>[k,false]))}}}});
  let ledger = ledgerInput || {issue:'1',stage:'await_validation',iterations:1,in_flight:false,events:[event('review','review'),event('publish','publish')],
    publication:{repo:c.repo,issue:c.issue,pr:2,base:c.base,head,tree,base_head:'9'.repeat(40),snapshot,review_thread:'review',generation:2}};
  const p = ledger.publication;
  let journal = null, envelope, issueState = 'open', merged = false, labels = [], prComments = [], pad = {id:12,body:'<!-- momoflow:workpad -->\n누적 반복 1 / 3'};
  const calls = [], preserved = [];
  const pr = () => ({state:merged?'closed':'open',merged,merge_commit_sha:merged?'f'.repeat(40):null,head:{sha:p.head,repo:{full_name:c.repo}},base:{ref:'main',sha:p.base_head,repo:{full_name:c.repo}},draft:false,mergeable:true,mergeable_state:'clean',user:{login:'bot'}});
  let result = { origin:c.controllerVersion,request:digest(p),head:p.head,tree:p.tree,image:'sha256:'+'1'.repeat(64),tests:99,kind:'passed',
    checks:['compose','build','contracts','node','sandbox','readiness'].map(name=>({name,exit:0,diagnostic:'contract_failure_example: expected 1, received 2',log:'2'.repeat(64),...(name==='contracts'?{tests:64,failures:0}:name==='node'?{tests:35,failures:0}:{})})) };
  const responses = new Map();
  const api = async (method,path,body) => {
    calls.push({method,path,body});
    const override = responses.get(`${method} ${path}`);
    if (override) return typeof override === 'function' ? override(body) : structuredClone(override);
    const root = '/repos/fixture/repo';
    if (path === `${root}/pulls/2` && method === 'GET') return pr();
    if (path.endsWith('/git/commits/'+'f'.repeat(40))) return {parents:[{sha:p.base_head},{sha:p.head}]};
    if (path.includes('/git/commits/')) return {tree:{sha:p.tree}};
    if (path === `${root}/issues/1` && method === 'GET') return {state:issueState};
    if (path.includes('/branches/') && !path.includes('/rules/')) return {protected:false};
    if (path.includes('/rules/branches/')) return [];
    if (path.includes('/check-runs?')) return {total_count:1,check_runs:[{name:'ci',head_sha:p.head,app:{id:42},status:'completed',conclusion:'success'}]};
    if (path.includes('/statuses?') || path.includes('/reviews?')) return [];
    if (path === '/graphql') return {data:{repository:{pullRequest:{reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}}}}}};
    if (path === `${root}/pulls/2/merge`) { assert.equal(body.sha,p.head); assert.ok(preserved.length); merged=true; return {merged:true,sha:'f'.repeat(40)}; }
    if (path === `${root}/issues/1/comments?per_page=100`) return [structuredClone(pad)];
    if (path === `${root}/issues/2/comments?per_page=100`) return structuredClone(prComments);
    if (path === `${root}/issues/comments/12`) {pad.body=body.body;return pad;}
    if (path === `${root}/issues/2/comments` && method === 'POST') {prComments.push(body);return {id:20};}
    if (path.endsWith('/labels?per_page=100')) return labels.map(name=>({name}));
    if (path.endsWith('/labels') && method === 'POST') {labels=body.labels;return {};}
    if (path.includes('/labels/momoflow%3A')) {labels=[];return null;}
    if (path === `${root}/issues/1` && method === 'PATCH') {issueState=body.state;return {state:issueState};}
    throw new Error(`Unexpected mock request: ${method} ${path}`);
  };
  const io = {api,engine:async()=>({running:[],retrying:[]}),ledger:async()=>structuredClone(ledger),load:async()=>structuredClone(journal),
    save:async x=>{journal=structuredClone(x);},validate:async()=>structuredClone(result),resume:async e=>{envelope=e;},preserve:async x=>{preserved.push(x);}};
  return {c,io,calls,responses,p,result,get ledger(){return ledger;},preserved,pr,get journal(){return journal;},get envelope(){return envelope;},get comments(){return prComments;},get pad(){return pad;},set merged(x){merged=x;},set issueState(x){issueState=x;},set ledger(x){ledger=x;}};
}

