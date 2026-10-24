// Actual CLI entrypoints/production adapters and real temporary archives. Docker,
// GitHub, native session provenance and filesystem mount tables are simulated.
import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,readFile,writeFile,stat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {budgetFixture} from './reconcile-budget-fixture.mjs';
import {atomic,digest,keyFor} from './post-pr.mjs';
import {command} from './post-pr-docker.mjs';
import {runtimeIdentity} from './deploy.mjs';
test('v4 actual CLI prepare/check/apply/duplicate against old engine and new installed controller',async()=>{
 const f=await budgetFixture();try {
  const c=f.input.config,source=fileURLToPath(new URL('..',import.meta.url));
  for(const dir of ['scripts','engine'])await cp(join(source,dir),join(c.trustedRoot,dir),{recursive:true});
  const boot=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),s=await stat(f.root,{bigint:true}),n=s.dev;
  const device=`${((n>>8n)&0xfffn)|((n>>32n)&0xfffff000n)}:${(n&0xffn)|((n>>12n)&0xffffff00n)}`;
  const probes={},services=[];
  for(const [service,x] of Object.entries(f.all).sort(([a],[b])=>a.localeCompare(b))) {
   const points=[],rows=[],mountHashes=[];
   for(const [i,m] of x.Mounts.entries()) {
    const st=await stat(m.Source,{bigint:true});points.push({path:m.Destination,dev:String(st.dev),ino:String(st.ino)});
    rows.push(`${i+1} 0 ${device} ${m.Source} ${m.Destination} rw - ext4 /dev/simulated rw`);
    mountHashes.push({type:m.Type,destination:m.Destination,rw:m.RW,identityHash:digest({device,path:m.Source,inode:String(st.ino)})});
   }
   probes[x.Id]={boot,mountinfo:rows.join('\n'),points};const r=runtimeIdentity(x);
   services.push({service,id:x.Id,image:x.Image,runtimeHash:digest({...r,mounts:r.mounts.map(m=>m.type==='bind'?{...m,source:null}:m)}),mountHashes:mountHashes.sort((a,b)=>a.destination.localeCompare(b.destination))});
  }
  const proof=JSON.parse(await readFile(f.paths.ownership));proof.serviceEvidence={kernel:boot,services};await f.pin('ownership',proof);await f.saveInput();
  const api={};
  for(const t of [c,c.installation])for(const path of [`/repos/${c.repo}/issues/${t.issue}`,`/repos/${c.repo}/pulls/${t.pr}`,`/repos/${c.repo}/git/commits/${t.head}`,`/repos/${c.repo}/git/commits/${t.merge}`])api[path]=await f.io.api('GET',path);
  api[`/repos/${c.repo}/issues?state=open&labels=momoflow%3Aready&per_page=100`]=[];
  for(const ref of ['0'.repeat(40)])api[`/repos/${c.repo}/contents/engine/role_runner.ex?ref=${ref}`]=await f.io.api('GET',`/repos/${c.repo}/contents/engine/role_runner.ex?ref=${ref}`);
  for(const t of [c,c.installation])api[`/repos/${c.repo}/contents/sample.txt?ref=${t.head}`]=await f.io.api('GET',`/repos/${c.repo}/contents/sample.txt?ref=${t.head}`);
  const fixtureFile=join(f.root,'cli-fixture.json'),preload=join(f.root,'cli-preload.mjs'),trace=join(f.root,'cli-trace.jsonl'),out=join(f.root,'cli-prepared');
  await atomic(fixtureFile,{all:f.all,probes,paths:f.paths,api,commit:c.controllerVersion,tree:c.controllerTree,oldSource:c.runnerSource,manifest:f.manifest,state:await f.io.engine(),mountinfo:`1 0 ${device} / / rw - ext4 /dev/simulated rw\n`,trace});
  await writeFile(preload,`import fs from 'node:fs/promises';import syncfs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const fixture=JSON.parse(await fs.readFile(${JSON.stringify(fixtureFile)},'utf8')),read=fs.readFile,lstat=fs.lstat;
fs.readFile=async(path,...args)=>path==='/proc/self/mountinfo'?fixture.mountinfo:read(path,...args);
fs.lstat=async(path,...args)=>{if(path==='/.dockerenv')throw Object.assign(Error('simulated host'),{code:'ENOENT'});return lstat(path,...args);};
const trace=x=>syncfs.appendFileSync(fixture.trace,JSON.stringify(x)+'\\n');
console.log=(...a)=>syncfs.writeSync(1,a.join(' ')+'\\n');console.error=(...a)=>syncfs.writeSync(2,a.join(' ')+'\\n');
const spawn=cp.spawn;
cp.spawn=(file,args,options)=>{try{trace({file,args});let value;
 if(file==='git')value=args.includes('status')?'':args.includes('HEAD^{tree}')?fixture.commit+'\\n'+fixture.tree:fixture.commit;
 else if(file==='docker') {
  if(args[0]==='ps')value=Object.values(fixture.all).map(x=>JSON.stringify({ID:x.Id})).join('\\n');
  else if(args[0]==='inspect'){const x=Object.values(fixture.all).find(x=>x.Id===args.at(-1));if(!x)throw Error('unknown inspect');value=JSON.stringify(args.includes('--format')?x.Mounts:[x]);}
  else if(args[0]==='top')value='PID COMMAND\\n1 beam.smp\\n';
  else if(args[0]==='exec') {
   if(args[4].includes('role_runner.ex'))value=fixture.oldSource;
   else if(args[4].includes('const paths=JSON.parse'))value=JSON.stringify(fixture.probes[args[1]]);
   else {let manifest=null;try{manifest=JSON.parse(syncfs.readFileSync(fixture.paths.manifest));}catch(e){if(e.code!=='ENOENT')throw e;}
    value=JSON.stringify({rows:[{file:${JSON.stringify(keyFor(c)+'.json')},bytes:syncfs.readFileSync(fixture.paths.ledger).toString('base64'),enrollment:syncfs.readFileSync(fixture.paths.enrollment).toString('base64')}],manifest});}
  } else throw Error('unexpected Docker mutation');
 }else throw Error('unexpected command');
 return spawn(process.execPath,['-e','require("fs").writeSync(1,'+JSON.stringify(value)+')'],options);
}catch(e){return spawn(process.execPath,['-e','require("fs").writeSync(2,'+JSON.stringify(e.message)+');process.exit(1)'],options);}};
globalThis.fetch=async url=>{trace({url:String(url)});let value;
 if(String(url).includes('/api/v1/state')){value=structuredClone(fixture.state);const g=JSON.parse(syncfs.readFileSync(fixture.paths.gate));value.admission.generation=g.generation;value.admission.paused=g.paused;
  try{value.momoflow_launch.manifest={status:'present',value:JSON.parse(syncfs.readFileSync(fixture.paths.manifest))};}catch(e){if(e.code!=='ENOENT')throw e;value.momoflow_launch.manifest={status:'absent'};}}
 else value=fixture.api[new URL(url).pathname+new URL(url).search];if(value===undefined)throw Error('unexpected remote request');return {ok:true,status:200,json:async()=>value};};syncBuiltinESMExports();`);
  const run=async(file,args)=>{const r=await command(process.execPath,['--import',preload,join(c.trustedRoot,'scripts',file),...args],{timeout:30000});assert.equal(r.exit,0,r.output.toString());return JSON.parse(r.output);};
  const prepared=await run('prepare-reconciliation.mjs',[f.inputFile,out]);
  const request=prepared.request;assert.equal((await run('prepare-reconciliation.mjs',[f.inputFile,out])).id,prepared.id);
  const requestBytes=await readFile(request);
  const installedCheck=await run('reconcile-external.mjs',[request,'--check','--operator','a'.repeat(64),'sha256:'+'b'.repeat(64),'1001']);
  assert.equal(installedCheck.id,prepared.id);assert.deepEqual(await readFile(request),requestBytes);
  assert.equal((await run('reconcile-external.mjs',[request,'--check'])).status,'eligible');
  const original=await readFile(f.paths.ledger);assert.equal((await run('reconcile-external.mjs',[request,'--apply'])).status,'externally-reconciled');
  assert.equal((await run('reconcile-external.mjs',[request,'--apply'])).unchanged,true);
  assert.equal((await run('reconcile-external.mjs',[request,'--check'])).unchanged,true);
  assert.deepEqual(await readFile(f.paths.ledger),original);await assert.rejects(fsLstat(f.paths.controllerJournal),{code:'ENOENT'});
  const receipt=JSON.parse(await readFile(join(f.dir,'external-reconciliation.json')));assert.equal(receipt.id,prepared.id);assert.equal(receipt.binding.runnerSource,c.runnerSource);
  assert.notEqual(JSON.parse(await readFile(join(out,'validation.json'))).runnerSource,c.runnerSource);
  const calls=(await readFile(trace,'utf8')).trim().split('\n').map(x=>JSON.parse(x));assert.ok(calls.some(x=>x.args?.[0]==='exec'&&x.args[4]?.includes('role_runner.ex')));assert.ok(calls.some(x=>x.args?.[0]==='top'));assert.ok(calls.every(x=>!x.args||!['up','run','restart','stop','rm','kill'].includes(x.args[0])));
 }finally{await f.clean();}
});
const fsLstat=async path=>{const {lstat}=await import('node:fs/promises');return lstat(path);};
