// Trusted external operator only. Original runner/controller records are never rewritten.
import {readFile,lstat,realpath,readdir,mkdir,open,rename,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual as same} from 'node:util';
import {config,json,digest,keyFor,atomic,github,list,verifyInstall,withControllerLock} from './post-pr.mjs';
import {command} from './post-pr-docker.mjs';
import {mountContext} from './deploy-mount-identity.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
const hex=v=>typeof v==='string' && /^[a-f0-9]{64}$/.test(v);
const sha=v=>typeof v==='string' && /^[a-f0-9]{40}$/.test(v);
const optional=async p=>{try{return await json(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
async function privatePath(path,directory=false) {
 need(typeof path==='string' && resolve(path)===path && await realpath(path)===path,'Private canonical evidence path required');
 const s=await lstat(path);need(!s.isSymbolicLink() && (directory?s.isDirectory():s.isFile()) && !(s.mode&0o022),'Untrusted reconciliation evidence');
}
async function bytes(ref) {
 need(ref && typeof ref.path==='string' && (ref.hash===null || hex(ref.hash)),'Pinned evidence reference required');
 if(ref.hash===null) {try{await lstat(ref.path);throw Error('Expected absent evidence exists');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 await privatePath(ref.path);const b=await readFile(ref.path);need(digest(b)===ref.hash,'Reconciliation evidence bytes changed');return b;
}
const paths=c=>{
 const dir=join(c.stateRoot,keyFor(c));
 return {dir,receipt:join(dir,'external-reconciliation.json'),intent:join(dir,'external-reconciliation-intent.json'),
  ledger:join(c.ledgerRoot,keyFor(c)+'.json'),enrollment:join(c.ledgerRoot,keyFor(c)+'.json.enrolled'),
  launchJournal:join(dir,'launch.json'),controllerJournal:join(dir,'journal.json'),manifest:join(c.launchRoot,'active.json'),gate:c.gateRoot?join(c.gateRoot,'active.json'):undefined};
};
export function reconciliationConfig(c) {
 config(c);need(c.authority.reconcile===true && !c.hold,'Explicit external reconciliation authority required');
 for(const k of ['launchRoot','gateRoot'])need(typeof c[k]==='string' && resolve(c[k])===c[k],'Absolute reconciliation control roots required');
 need(Number.isSafeInteger(c.pr) && c.pr>0 && [c.head,c.tree,c.merge].every(sha),'Exact external PR/head/tree/merge required');
 need(Number.isInteger(c.originalIterations) && c.originalIterations>=1 && c.originalIterations<=3 && Number.isInteger(c.externalIterations) && c.externalIterations>=1,'Separate original/external iteration history required');
 need(hex(c.engineContainer) && /^sha256:[a-f0-9]{64}$/.test(c.engineImage || '') && typeof c.productionProject==='string','Pinned engine worker identity required');
 const p=paths(c),names=['ledger','enrollment','manifest','launchJournal','controllerJournal','gate','recovery','validation'];
 need(c.evidence && same(Object.keys(c.evidence).sort(),names.sort()),'Complete exact reconciliation evidence required');
 for(const name of names) {const ref=c.evidence[name];need(ref && (name==='controllerJournal'?ref.hash===null || hex(ref.hash):hex(ref.hash)),'Evidence hash required');need(typeof ref.path==='string' && resolve(ref.path)===ref.path,'Absolute evidence path required');if(p[name])need(ref.path===p[name],'Evidence path/scope mismatch');}
 return c;
}
function binding(c) {
 return {v:1,repo:c.repo,issue:c.issue,base:c.base,pr:c.pr,head:c.head,tree:c.tree,merge:c.merge,originalIterations:c.originalIterations,externalIterations:c.externalIterations,engineContainer:c.engineContainer,engineImage:c.engineImage,runnerSource:c.runnerSource,...(c.configurationHash?{configurationHash:c.configurationHash}:{}),evidence:c.evidence};
}
// The receipt is an additional historical fact, never runner completion or a budget reset.
export async function verifiedExternalReceipt(c,key,observation) {
 const dir=join(c.stateRoot,key),path=join(dir,'external-reconciliation.json');
 const receipt=await optional(path);if(!receipt)return false;
 await privatePath(path);const b=receipt.binding;
 need(receipt.v===1 && receipt.status==='externally-reconciled' && receipt.done===true && sha(receipt.controllerVersion) && b?.v===1 && b.repo===c.repo && b.base===c.base && key===keyFor(b) && receipt.id===digest(b) && [b.head,b.tree,b.merge].every(sha),'Invalid external reconciliation receipt');
 need(same(Object.keys(b.evidence).sort(),['controllerJournal','enrollment','gate','launchJournal','ledger','manifest','recovery','validation'].sort()),'Incomplete reconciliation receipt');
 const scope={...c,issue:b.issue},expected=paths(scope);
 need(receipt.archive===join(dir,'external-reconciliation',receipt.id),'Reconciliation archive path mismatch');
 await privatePath(receipt.archive,true);
 for(const [name,ref] of Object.entries(b.evidence)) {
  if(expected[name])need(ref.path===expected[name],'Reconciliation receipt source path mismatch');
  if(observation && ['ledger','enrollment'].includes(name)) {
   const row=observation.rows.find(r=>r.file===key+'.json');
   need(row,'Reconciled live ledger missing');
   const value=name==='ledger'?row.bytes:row.enrollment;
   need(typeof value==='string' && ref.hash!==null && digest(Buffer.from(value,'base64'))===ref.hash,'Reconciliation live evidence bytes changed');
  } else if(!['manifest','gate'].includes(name))await bytes(ref);
  const archived={path:join(receipt.archive,name),hash:ref.hash};await bytes(archived);
 }
 const ledger=JSON.parse(observation?Buffer.from(observation.rows.find(r=>r.file===key+'.json').bytes,'base64'):await readFile(b.evidence.ledger.path));
 need(ledger.issue===b.issue && ledger.launch?.repo===b.repo && ledger.launch.base===b.base && ledger.launch.limit===b.originalIterations && keyFor(ledger.launch)===key && ledger.iterations===b.originalIterations,'Receipt ledger scope/history mismatch');
 need(same(JSON.parse(await readFile(join(receipt.archive,'manifest'))),ledger.launch),'Archived manifest scope mismatch');
 const recovery=JSON.parse(await readFile(b.evidence.recovery.path)),validation=JSON.parse(await readFile(b.evidence.validation.path));
 need(recovery.issue===Number(b.issue) && recovery.pr===b.pr && recovery.head===b.head && recovery.tree===b.tree && recovery.previous_iterations===b.originalIterations && recovery.additional_iterations_used===b.externalIterations && validation.commit===b.merge && validation.head===b.head && validation.tree===b.tree,'Receipt external completion/history mismatch');
 const manifest=observation?observation.manifest:await optional(expected.manifest);
 need(manifest===null || (manifest && typeof manifest==='object'),'Live manifest observation required');
 need(!manifest || !same(manifest,ledger.launch),'Reconciled manifest is still active');
 return true;
}
export async function foreignOwners(c,{own=false,existing=null}={}) {
 const ownKey=keyFor(c);
 for(const file of await readdir(c.ledgerRoot)) {
  if(!/^[a-f0-9]{64}\.json(?:\.enrolled)?$/.test(file))throw Error('Unknown ledger owner requires recovery');
  if(file.endsWith('.enrolled')) {need(await optional(join(c.ledgerRoot,file.slice(0,-9))),'Enrolled foreign ledger missing');continue;}
  const key=file.slice(0,-5);if(own && key===ownKey)continue;
  const l=await json(join(c.ledgerRoot,file)),j=await optional(join(c.stateRoot,key,'journal.json'));
  if(await verifiedExternalReceipt(c,key))continue;
  need(l.in_flight===false && !l.active_session && (['done','blocked'].includes(l.stage)||j?.done===true),'Other unfinished/interrupted ledger requires recovery');
 }
 for(const entry of await readdir(c.stateRoot,{withFileTypes:true})) if(entry.isDirectory()) {
  need(hex(entry.name),'Unknown controller owner requires recovery');
  const d=join(c.stateRoot,entry.name);need(!await optional(join(d,'lock')),'Existing per-issue controller lock requires recovery');
  if(await verifiedExternalReceipt(c,entry.name))continue;
  const j=await optional(join(d,'journal.json')),l=await optional(join(d,'launch.json'));
  need((!j||j.done||(existing&&entry.name===ownKey))&&(!l||l.done||(existing&&entry.name===ownKey)),'Other controller journal requires recovery');
 }
}
function idle(c,s,manifest,gate=null) {
 const cap=s.momoflow_launch,a=s.admission;
 need(cap?.contract===1 && cap.repo===c.repo && cap.source===c.runnerSource && cap.concurrency===1 && cap.role_flow===true && cap.launch_read_only===true && cap.inbox_read_only===true && cap.launch_root==='/run/momoflow-launch' && cap.inbox_root==='/run/momoflow-resume','Engine reconciliation capability mismatch');
 need(manifest ? same(cap.manifest,{status:'present',value:manifest}):same(cap.manifest,{status:'absent'}),'Engine manifest acknowledgement mismatch');
 for(const name of ['running','retrying'])need(Array.isArray(s[name]) && s[name].length===0,'Active/unknown engine worker');
 need(a?.contract===1 && a.configured===true && !a.error && a.pending_dispatch===false,'Admission state unknown/busy');
 for(const name of ['running','retrying','claimed','blocked'])need(Array.isArray(a[name]) && a[name].length===0,'Active/unknown admission owner');
 need(typeof a.paused==='boolean' && hex(a.generation),'Admission acknowledgement unknown');
 if(gate)need(a.paused===gate.paused && a.generation===gate.generation,'Admission fence not acknowledged');
}
async function exclusive(path,data,mode=0o400) {
 let f;try{f=await open(path,'wx',mode);}catch(e){if(e.code!=='EEXIST')throw e;need(same(await readFile(path),data),'Immutable reconciliation archive changed');return;}
 try{await f.writeFile(data);await f.sync();}finally{await f.close();}
 const d=await open(dirname(path),'r');try{await d.sync();}finally{await d.close();}
}
async function atomicBytes(path,data) {
 const tmp=path+'.reconciliation-'+process.pid;const f=await open(tmp,'wx',0o644);
 try{await f.writeFile(data);await f.sync();}finally{await f.close();}
 await rename(tmp,path);const d=await open(dirname(path),'r');try{await d.sync();}finally{await d.close();}
}
export async function reconcileExternal(c,io,{check=false}={}) {
 reconciliationConfig(c);const p=paths(c),b=binding(c),id=digest(b),fence={v:1,generation:id,paused:true};
 await io.authorize();
 const intent=await optional(p.intent),receipt=await optional(p.receipt);
 if(intent)need(intent.id===id && same(intent.binding,b),'Different reconciliation already owns this scope');
 if(receipt) {need(same(receipt.binding,b) && await verifiedExternalReceipt(c,keyFor(c)),'Reconciliation receipt mismatch');return {status:'externally-reconciled',id,unchanged:true};}
 const data={};
 for(const [name,ref] of Object.entries(c.evidence)) {
  if(['gate','manifest'].includes(name) && intent)continue;
  data[name]=await bytes(ref);
 }
 const archive=join(p.dir,'external-reconciliation',id);
 for(const name of ['gate','manifest']) {
  if(intent) {data[name]=await bytes({path:join(archive,name),hash:c.evidence[name].hash});}
 }
 const ledger=JSON.parse(data.ledger),manifest=JSON.parse(data.manifest),launch=JSON.parse(data.launchJournal),recovery=JSON.parse(data.recovery),validation=JSON.parse(data.validation),originalGate=JSON.parse(data.gate);
 need(ledger.issue===c.issue && ledger.launch?.repo===c.repo && ledger.launch.issue===c.issue && ledger.launch.base===c.base && same(ledger.launch,manifest) && ledger.iterations===c.originalIterations && ledger.launch.limit===c.originalIterations && ledger.in_flight===true && ledger.stage==='blocked' && ledger.active_session && Array.isArray(ledger.events),'Exact interrupted runner history required');
 need(launch.contract===digest(manifest) && launch.dispatched===true && !launch.done,'Original interrupted launch journal required');
 need(recovery.issue===Number(c.issue) && recovery.pr===c.pr && recovery.head===c.head && recovery.tree===c.tree && recovery.previous_iterations===c.originalIterations && recovery.additional_iterations_used===c.externalIterations && recovery.status==='fourth-complete-validated' && recovery.original_ledger_unchanged===true && recovery.docker_tests?.failed===0 && recovery.docker_tests.tests>0,'External recovery history/validation mismatch');
 need(validation.status==='deployed' && validation.commit===c.merge && validation.head===c.head && validation.tree===c.tree && validation.image===c.engineImage && validation.original_interrupted_ledger_preserved===true,'Pinned external completion validation mismatch');
 need(originalGate.v===1 && hex(originalGate.generation) && typeof originalGate.paused==='boolean','Original admission gate invalid');
 await foreignOwners(c,{own:true,existing:true});
 const issue=await io.api('GET',`/repos/${c.repo}/issues/${c.issue}`),pr=await io.api('GET',`/repos/${c.repo}/pulls/${c.pr}`);
 need(issue.state==='closed' && String(issue.number)===c.issue && !issue.pull_request && !issue.labels?.some(l=>l.name==='momoflow:ready'),'External issue is not safely closed/non-ready');
 need(pr.merged===true && pr.state==='closed' && pr.head?.sha===c.head && pr.head.repo?.full_name===c.repo && pr.base?.ref===c.base && pr.base.repo?.full_name===c.repo && pr.merge_commit_sha===c.merge,'Exact merged external PR mismatch');
 const [head,merge]=await Promise.all([c.head,c.merge].map(s=>io.api('GET',`/repos/${c.repo}/git/commits/${s}`)));
 need(head.tree?.sha===c.tree && merge.tree?.sha===c.tree && merge.parents?.some(p=>p.sha===c.head),'External head/tree/merge mismatch');
 need((await list(io.api,`/repos/${c.repo}/issues?state=open&labels=momoflow%3Aready`)).length===0,'Another issue is executable');
 need(await io.workers()===true,'Active or uncertain engine processes');
 const active=await optional(p.manifest),gate=await json(p.gate);
 need(active===null ? !!intent:same(active,manifest),'Active launch manifest changed');
 need(same(gate,originalGate) || (!!intent && same(gate,fence)),'Admission gate changed');
 idle(c,await io.engine(),active,gate);
 if(check)return {status:'eligible',reason:'Exact external completion and idle runtime verified',id,originalIterations:ledger.iterations,externalIterations:c.externalIterations,manifest:active?'present':'retired',effects:'none'};
 const checkpoint=io.checkpoint || (async()=>{});
 // Archive originals before intent/fence. Exclusive files make identical crash retry safe.
 await mkdir(archive,{recursive:true,mode:0o700});await privatePath(archive,true);
 for(const [name,value] of Object.entries(data))if(value!==null)await exclusive(join(archive,name),value);
 await atomic(p.intent,{v:1,id,binding:b,phase:'intent'});await checkpoint('intent');
 // Re-read all immutable input and remote/worker evidence under the shared lock.
 await reconcileExternal(c,io,{check:true});
 await atomicBytes(p.gate,Buffer.from(JSON.stringify(fence)));await checkpoint('fence-written');
 await io.ack(active,fence);idle(c,await io.engine(),active,fence);need(await io.workers()===true,'Worker appeared under fence');
 await checkpoint('fenced');
 await reconcileExternal(c,io,{check:true});
 for(const name of ['ledger','enrollment','launchJournal','controllerJournal','recovery','validation'])await bytes(c.evidence[name]);
 if(active!==null) {await bytes(c.evidence.manifest);await rm(p.manifest);const d=await open(c.launchRoot,'r');try{await d.sync();}finally{await d.close();}}
 await checkpoint('manifest-retired');
 await io.ack(null,fence);idle(c,await io.engine(),null,fence);
 await atomic(p.intent,{v:1,id,binding:b,phase:'manifest-retired'});
 await io.authorize();
 await atomicBytes(p.gate,data.gate);await checkpoint('gate-restored');
 await io.ack(null,originalGate);idle(c,await io.engine(),null,originalGate);
 for(const name of ['ledger','enrollment','launchJournal','controllerJournal','recovery','validation'])await bytes(c.evidence[name]);
 need(await io.workers()===true,'Worker appeared before reconciliation completion');
 await atomic(p.receipt,{v:1,id,binding:b,status:'externally-reconciled',done:true,archive,controllerVersion:c.controllerVersion,checks:['original-bytes','merged-pr-head-tree','engine-processes-idle','admission-fence','manifest-absent','original-gate-restored']});
 await checkpoint('receipt');
 need(await verifiedExternalReceipt(c,keyFor(c)),'Final reconciliation receipt invalid');
 return {status:'externally-reconciled',id,originalIterations:ledger.iterations,externalIterations:c.externalIterations};
}
export async function reconciliationPorts(c) {
 await verifyInstall(c);need(!c.trustedRoot.startsWith('/data/workspaces/'),'Operator-only trusted checkout required');
 const docker=async args=>{const r=await command('docker',args,{timeout:5000,dockerConfig:c.dockerConfig});need(r.exit===0,'Operator/worker observation unavailable');return r.output.toString();};
 let containerized=false;try{await lstat('/.dockerenv');containerized=true;}catch(e){if(e.code!=='ENOENT')throw e;}
 const operator=()=>verifyReconciliationOperator(c,{docker,containerized,hostname:()=>readFile('/etc/hostname','utf8')});
 await operator();
 for(const k of ['stateRoot','ledgerRoot','launchRoot','gateRoot','inboxRoot']) {await privatePath(c[k],true);need(!c[k].startsWith(c.trustedRoot+'/') && !c[k].startsWith('/data/workspaces/'),'Operational data must be external');}
 await privatePath(c.configFile);await privatePath(dirname(c.configFile),true);await privatePath(c.tokenFile);
 need(!c.configFile.startsWith(c.trustedRoot+'/') && !c.configFile.startsWith('/data/workspaces/'),'Private operator configuration must be external');
 const settings=c.configurationHash || digest(await readFile(c.configFile));need(digest(await readFile(c.configFile))===settings,'Reconciliation authority/config changed');
 c.runnerSource=digest(await readFile(join(c.trustedRoot,'engine/role_runner.ex')));
 const api=github(c),engine=async()=>{const r=await fetch(c.engineURL+'/api/v1/state',{signal:AbortSignal.timeout(5000)});need(r.ok,'Engine unavailable');return r.json();};
 const io={api,engine,authorize:async()=>{await privatePath(c.configFile);need(digest(await readFile(c.configFile))===settings,'Reconciliation authority/config changed');await verifyInstall(c);await operator();},
  workers:()=>observeReconciliationWorkers(c,docker),
  ack:async(manifest,gate)=>{const end=Date.now()+10000;for(;;){try{idle(c,await engine(),manifest,gate);return;}catch(e){if(Date.now()>=end)throw e;await new Promise(r=>setTimeout(r,100));}}}};
 return io;
}
function engineIdentity(c,x) {
 need(x?.Id===c.engineContainer && x.Image===c.engineImage && x.State?.Running===true && x.State.Health?.Status==='healthy' && x.Config?.Labels?.['com.docker.compose.project']===c.productionProject && x.Config.Labels['com.docker.compose.service']==='symphony','Worker engine identity changed');
}
export async function observeReconciliationWorkers(c,docker) {
 const x=JSON.parse(await docker(['inspect',c.engineContainer]))[0];engineIdentity(c,x);
 const idle=observedWorkersIdle(await docker(['top',c.engineContainer,'-eo','pid,comm']));
 engineIdentity(c,JSON.parse(await docker(['inspect',c.engineContainer]))[0]);return idle;
}
// Adapter for the existing external named-volume operator. The coding engine is
// never an operator, even if it can read a candidate copy of these scripts.
export async function verifyReconciliationOperator(c,{docker,containerized,hostname,contextFor=mountContext,canonical=realpath}) {
 if(!containerized)return;
 need(hex(c.operatorContainer) && c.operatorContainer!==c.engineContainer && /^sha256:[a-f0-9]{64}$/.test(c.operatorImage || '') && /^[1-9][0-9]*$/.test(c.operatorSocketGroup || ''),'Explicit independent operator helper required');
 const inspect=async id=>JSON.parse(await docker(['inspect',id]))[0];
 const [operator,engine]=await Promise.all([inspect(c.operatorContainer),inspect(c.engineContainer)]);engineIdentity(c,engine);
 const h=operator?.HostConfig;
 need(operator?.Id===c.operatorContainer && operator.Image===c.operatorImage && operator.State?.Running===true && operator.Config?.Hostname===(await hostname()).trim() && operator.Config.User==='1000:1000' && operator.Config.Labels?.['com.docker.compose.service']==='controller','Actual operator helper identity mismatch');
 need(h?.ReadonlyRootfs===true && h.Privileged===false && !h.CapAdd?.length && same(h.CapDrop,['ALL']) && same(h.GroupAdd,[c.operatorSocketGroup]) && same(h.SecurityOpt?.map(s=>s.replace(/^no-new-privileges:true$/,'no-new-privileges')),['no-new-privileges']) && [c.engineContainer,engine.Name?.replace(/^\//,'')].some(id=>h.NetworkMode==='container:'+id),'Unsafe operator helper security/network');
 const image=await inspect(c.operatorImage);
 need(image?.Id===c.operatorImage && same([...(operator.Config.Env || [])].sort(),[...(image.Config?.Env || [])].sort()),'Operator image environment overridden');
 need(c.ledgerRoot==='/engine-data/log/roles' && c.tokenFile==='/run/momoflow-auth/token.json','Live operator ledger/auth paths required');
 const binds=[[c.trustedRoot,false],[dirname(c.configFile),false],[c.stateRoot,true],[c.inboxRoot,true],[c.launchRoot,true],[c.gateRoot,true],['/tmp',true],['/var/run/docker.sock',true],[c.evidence.recovery.path,false],[c.evidence.validation.path,false]];
 need(new Set(binds.map(([path])=>path)).size===binds.length,'Overlapping operator mount destinations');
 const mounts=operator.Mounts;
 need(Array.isArray(mounts) && mounts.length===binds.length+2 && new Set(mounts.map(m=>m.Destination)).size===mounts.length,'Unexpected operator mounts');
 // This operator contract uses identical canonical host/container paths. A
 // self-consistent mount inside the helper cannot authenticate a different host
 // controller.lock or copied journal directory; translated sources are unsupported.
 for(const [destination,rw] of binds)need(mounts.some(m=>m.Type==='bind' && m.Source===destination && m.Destination===destination && m.RW===rw),'Required operator bind source/authority mismatch');
 const context=await contextFor(docker,[engine,operator]);
 for(const [destination] of binds) {
  const m=mounts.find(m=>m.Destination===destination);
  // Debian's conventional /var/run socket destination resolves through /run.
  const path=destination==='/var/run/docker.sock'?await canonical(destination):destination;
  need(same(await context.host(path),context.mounted.get(m)),'Operator bind correspondence mismatch');
 }
 for(const [destination,engineDestination] of [[c.launchRoot,'/run/momoflow-launch'],[c.gateRoot,'/run/momoflow-admission'],[c.inboxRoot,'/run/momoflow-resume']]) {
  const m=mounts.find(m=>m.Destination===destination),matches=engine.Mounts.filter(m=>m.Destination===engineDestination),e=matches[0];
  const actual=context.mounted.get(m),expected=context.mounted.get(e);
  need(matches.length===1 && e.Type==='bind' && e.RW===false && actual && expected && same(actual,expected),'Operator live control bind correspondence mismatch');
 }
 for(const [destination,engineDestination] of [['/engine-data','/data'],['/run/momoflow-auth','/run/momoflow-auth']]) {
  const m=mounts.find(m=>m.Destination===destination),e=engine.Mounts.find(m=>m.Destination===engineDestination);
  need(m?.Type==='volume' && m.RW===false && e?.Type==='volume' && m.Name===e.Name && m.Source===e.Source && same(context.mounted.get(m),context.mounted.get(e)),'Operator live ledger/auth volume correspondence mismatch');
 }
}
export function observedWorkersIdle(text) {
 const rows=text.trim().split('\n');need(/^PID\s+COMMAND$/.test(rows.shift()?.trim() || '') && rows.length>0,'Worker process observation incomplete');
 const pids=new Set();let idle=true;
 for(const row of rows) {
  const match=row.trim().match(/^([1-9][0-9]*)\s+(\S+)$/);need(match && Number.isSafeInteger(Number(match[1])) && !pids.has(match[1]),'Worker process observation malformed/duplicate');pids.add(match[1]);
  if(!['docker-init','beam.smp','erl_child_setup','inet_gethost','epmd'].includes(match[2]))idle=false;
 }
 return idle;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 try {
  need(process.argv.length===4 && ['--check','--apply'].includes(process.argv[3]),'Use operator-config.json --check|--apply');
  const configFile=resolve(process.argv[2]),contents=await readFile(configFile),c=reconciliationConfig({...JSON.parse(contents),configFile,configurationHash:digest(contents)});
  const io=await reconciliationPorts(c),check=process.argv[3]==='--check';
  if(check)need(!await optional(join(c.stateRoot,'controller.lock')),'Controller ownership already held');
  const result=check?await reconcileExternal(c,io,{check:true}):await withControllerLock(c,()=>reconcileExternal(c,io));
  console.log(JSON.stringify(result));
 } catch(e) {console.error(e.message);process.exitCode=1;}
}
