import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWorkStatus } from './work-status.mjs';
import { fixture } from './post-pr-fixture.mjs';
import { reconcile } from './post-pr.mjs';

test('public summary contains only allowlisted scope and state, separate from resume authority',async()=>{
 const root=await mkdtemp(join(tmpdir(),'work-status-'));
 try {
  const c={repo:'fixture/repo',issue:'38',inboxRoot:root};
  const ledger={launch:{id:'a'.repeat(64),repo:c.repo,issue:c.issue},events:[{}],publication:{pr:2,head:'b'.repeat(40)},private:'/private/secret',session:'raw log'};
  assert.equal(await writeWorkStatus(c,ledger,'merged'),true);
  const files=await readdir(root);assert.equal(files.length,1);assert.match(files[0],/\.status\.json$/);
  const bytes=await readFile(join(root,files[0]),'utf8');const h=JSON.parse(bytes);
  assert.deepEqual(Object.keys(h).sort(),['v','repo','issue','launch','generation','pr','head','phase','observed_at'].sort());
  assert.equal(h.phase,'merged');assert.equal(h.generation,1);assert.ok(Date.parse(h.observed_at));
  assert.ok(!bytes.includes('private'));assert.ok(!bytes.includes('raw log'));
  assert.equal(await writeWorkStatus(c,ledger,'<script>'),false);
  assert.equal(await writeWorkStatus({...c,issue:'../38'},ledger,'complete'),false);
  assert.equal(await writeWorkStatus({...c,inboxRoot:join(root,'missing')},ledger,'blocked'),false);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('display write failure cannot change reconcile decisions or dispatch effects',async()=>{
 const f=fixture();const phases=[];
 f.io.status=async (_ledger,phase)=>{phases.push(phase);throw new Error('display unavailable');};
 assert.deepEqual(await reconcile(f.c,f.io),{done:true,merge:'f'.repeat(40)});
 assert.deepEqual(phases,['validating','merged']);assert.equal(f.calls.filter(x=>x.method==='PUT').length,1);
});
test('code correction display follows successful budget-preserving handoff',async()=>{
 const f=fixture(), phases=[];f.io.status=async(_,p)=>phases.push(p);
 f.result.kind='code_failure';Object.assign(f.result.checks.find(x=>x.name==='contracts'),{exit:2,failures:1});
 await reconcile(f.c,f.io);assert.deepEqual(phases,['validating','correction']);assert.equal(f.ledger.iterations,1);
});

test('completion adapter publishes verified completion and recheck drift without private records',async()=>{
 const { completionPorts }=await import('./finish.mjs');
 const { keyFor }=await import('./post-pr.mjs');
 const { writeFile }=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'completion-status-'));
 try {
  const c={repo:'fixture/repo',issue:'38',inboxRoot:root,ledgerRoot:root};
  const p={pr:2,head:'b'.repeat(40)};
  const ledger={launch:{id:'a'.repeat(64),repo:c.repo,issue:c.issue},events:[{}],publication:p};
  await writeFile(join(root,keyFor(c)+'.json'),JSON.stringify(ledger));
  const io=completionPorts(c,{}, {}, {journalFile:join(root,'completion.json'),authorize:async()=>{},report:async()=>{},publication:p});
  await io.save({phase:'complete',verification:{private:'/host/private'}});
  let value=JSON.parse(await readFile(join(root,keyFor(c)+'.status.json'),'utf8'));
  assert.equal(value.phase,'complete');assert.ok(!JSON.stringify(value).includes('private'));
  await io.save({phase:'complete',recheck:{status:'blocked'}});
  value=JSON.parse(await readFile(join(root,keyFor(c)+'.status.json'),'utf8'));assert.equal(value.phase,'blocked');
 } finally {await rm(root,{recursive:true,force:true});}
});
