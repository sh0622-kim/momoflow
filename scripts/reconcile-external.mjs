// Trusted external operator only. Original runner/controller records are never rewritten.
import {readFile,lstat,realpath,readdir,mkdir,open,rename,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual as same} from 'node:util';
import {config,json,digest,keyFor,atomic,github,list,verifyInstall,withControllerLock} from './post-pr.mjs';
import {command} from './post-pr-docker.mjs';
import {mountContext} from './deploy-mount-identity.mjs';
// Resolve the receipt/deployment module cycle before CLI execution, not during an
// awaited ownership observation (dynamic import there deadlocks ESM evaluation).
import {deploymentConfig,observeDeploymentOwners,runtimeOwnersIdle,ownershipServiceEvidence} from './deploy.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
const hex=v=>typeof v==='string' && /^[a-f0-9]{64}$/.test(v);
const sha=v=>typeof v==='string' && /^[a-f0-9]{40}$/.test(v);
const controllerV2=c=>c.profile==='controller-only-v2';
const extendedBudget=c=>controllerV2(c) && c.originalIterations+c.externalIterations>c.originalLimit;
function controllerBudget(c) {
 if(!extendedBudget(c))return c.externalBudget===undefined;
 const b=c.externalBudget;
 return b && same(Object.keys(b).sort(),['externalLimit','totalLimit']) && Number.isSafeInteger(b.externalLimit) && b.externalLimit>=c.externalIterations && Number.isSafeInteger(b.totalLimit) && b.totalLimit===c.originalIterations+b.externalLimit;
}
const evidenceNames=c=>['ledger','enrollment','manifest','launchJournal','controllerJournal','gate','recovery','validation',...(controllerV2(c)?['publishArtifact','review','tests','ownership','ownershipRequest',...(extendedBudget(c)?['authorization']:[])]:[])];
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
 need(c.profile===undefined || controllerV2(c),'Unsupported external completion profile');
 for(const k of ['launchRoot','gateRoot'])need(typeof c[k]==='string' && resolve(c[k])===c[k],'Absolute reconciliation control roots required');
 need(Number.isSafeInteger(c.pr) && c.pr>0 && [c.head,c.tree,c.merge].every(sha),'Exact external PR/head/tree/merge required');
 need(Number.isInteger(c.originalIterations) && c.originalIterations>=1 && c.originalIterations<=3 && Number.isInteger(c.externalIterations) && c.externalIterations>=1,'Separate original/external iteration history required');
 need(hex(c.engineContainer) && /^sha256:[a-f0-9]{64}$/.test(c.engineImage || '') && typeof c.productionProject==='string','Pinned engine worker identity required');
 if(controllerV2(c))need((c.originalPr===undefined || Number.isSafeInteger(c.originalPr) && c.originalPr>0) && c.originalIterations===2 && c.originalLimit===3 && Number.isSafeInteger(c.externalIterations) && c.externalIterations>=1 && controllerBudget(c) && (!extendedBudget(c) || c.authority.externalBudget===true) && c.controllerVersion===c.merge && c.controllerTree===c.tree && typeof c.dataVolume==='string' && c.dataVolume.length>0,'Controller-only installed version/shared budget mismatch');
 const p=paths(c),names=evidenceNames(c);
 need(c.evidence && same(Object.keys(c.evidence).sort(),names.sort()),'Complete exact reconciliation evidence required');
 for(const name of names) {const ref=c.evidence[name];need(ref && (name==='controllerJournal'?ref.hash===null || hex(ref.hash):hex(ref.hash)),'Evidence hash required');need(typeof ref.path==='string' && resolve(ref.path)===ref.path,'Absolute evidence path required');if(p[name])need(ref.path===p[name],'Evidence path/scope mismatch');}
 return c;
}
function binding(c) {
 return {v:controllerV2(c)?2:1,...(controllerV2(c)?{profile:c.profile,...(c.originalPr!==undefined?{originalPr:c.originalPr}:{}),originalLimit:c.originalLimit,controllerTree:c.controllerTree,dataVolume:c.dataVolume,...(c.externalBudget?{externalBudget:c.externalBudget}:{})}:{}),repo:c.repo,issue:c.issue,base:c.base,pr:c.pr,head:c.head,tree:c.tree,merge:c.merge,originalIterations:c.originalIterations,externalIterations:c.externalIterations,engineContainer:c.engineContainer,engineImage:c.engineImage,runnerSource:c.runnerSource,...(c.configurationHash?{configurationHash:c.configurationHash}:{}),evidence:c.evidence};
}
function validateControllerCompletion(b,ledger,data) {
 const artifact=JSON.parse(data.publishArtifact),attempt=JSON.parse(data.recovery),review=JSON.parse(data.review),tests=JSON.parse(data.tests),install=JSON.parse(data.validation),ownership=JSON.parse(data.ownership),request=JSON.parse(data.ownershipRequest),originalManifest=JSON.parse(data.manifest);
 need(same(originalManifest,ledger.launch),'Original manifest content mismatch');
 const scoped=x=>x.repo===b.repo && x.issue===b.issue && x.pr===b.pr && x.head===b.head && x.tree===b.tree;
 need(b.v===2 && controllerV2(b) && (b.originalPr===undefined || Number.isSafeInteger(b.originalPr) && b.originalPr>0) && b.originalIterations===2 && b.originalLimit===3 && Number.isSafeInteger(b.externalIterations) && b.externalIterations>=1 && controllerBudget(b) && ledger.launch.limit===b.originalLimit && ledger.iterations===b.originalIterations,'Controller-only shared attempt history mismatch');
 need(ledger.stage==='blocked' && ledger.in_flight===true && ledger.active_session && ledger.reason==='Missing exact reviewed publication' && ledger.events?.at(-1)?.role==='review' && ledger.events.at(-1).result?.status==='complete','Original blocked publish failure required');
 if(extendedBudget(b)) {
  const a=JSON.parse(data.authorization);
  need(a.kind==='controller-external-budget-v1' && a.profile===b.profile && a.repo===b.repo && a.issue===b.issue && a.pr===b.pr && (b.originalPr===undefined || a.originalPr===b.originalPr) && a.originalIterations===b.originalIterations && a.originalLimit===b.originalLimit && a.externalLimit===b.externalBudget.externalLimit && a.totalLimit===b.externalBudget.totalLimit && a.source==='explicit-user-request' && typeof a.userRequest==='string' && a.userRequest.trim().length>0 && typeof a.operator==='string' && a.operator.trim().length>0 && ['ledger','publishArtifact','launchJournal','manifest'].every(k=>a.originalHashes?.[k]===b.evidence[k].hash),'Explicit scoped external budget authorization required');
 }
 const p=artifact.publication;
 need(artifact.status==='complete' && p?.repo===b.repo && p.issue===Number(b.issue) && p.pr===(b.originalPr ?? b.pr) && p.base===b.base && sha(p.head),'Original numeric publication artifact required');
 need(scoped(attempt) && attempt.kind==='controller-external-attempt-v2' && attempt.status==='completed' && attempt.originalUsed===2 && attempt.limit===3 && attempt.externalUsed===b.externalIterations && attempt.totalUsed===b.originalIterations+b.externalIterations && attempt.originalHead===p.head && (b.originalPr===undefined || attempt.originalPr===b.originalPr) && typeof attempt.buildSession==='string' && attempt.buildSession.length>0 && ['ledger','publishArtifact','launchJournal','manifest'].every(k=>attempt.originalHashes?.[k]===b.evidence[k].hash),'External controller attempt/original hashes mismatch');
 need(scoped(review) && review.kind==='controller-external-review-v2' && review.status==='approved' && review.model==='gpt-6-astra' && review.reasoning==='high' && review.fast===false && typeof review.session==='string' && review.session.length>0 && review.session!==attempt.buildSession,'Separate exact-head external review required');
 need(scoped(tests) && tests.kind==='controller-external-tests-v2' && tests.status==='passed' && Number.isInteger(tests.tests) && tests.tests>=356 && tests.failures===0 && tests.skipped===0 && ['node','syntax','diff'].every(name=>tests.checks?.filter(x=>x.name===name && x.exit===0).length===1 && hex(tests.logHashes?.[name])),'Exact-head external test evidence required');
 need(scoped(install) && install.kind==='controller-install-v2' && install.status==='installed' && install.commit===b.merge && install.controllerVersion===b.merge && install.controllerTree===b.tree && b.controllerTree===b.tree && install.engineUnchanged===true && install.engineContainer===b.engineContainer && install.engineImage===b.engineImage && install.ownershipHash===b.evidence.ownership.hash,'Pinned controller-only installation required');
 need(request.ownershipVersion===1 && request.authority?.observe===true && request.controllerVersion===b.merge && request.repo===b.repo && request.base===b.base && request.dataVolume===b.dataVolume,'Pinned current-only ownership request mismatch');
 const own=ownership.ledgerHashes?.find(r=>r.file===keyFor(b)+'.json');
 const services=ownership.serviceEvidence?.services;
 need(/^[a-f0-9-]{36}$/.test(ownership.serviceEvidence?.kernel || '') && Array.isArray(services) && services.length===2 && ['symphony','github-auth'].every(service=>{
  const rows=services.filter(x=>x.service===service),x=rows[0];return rows.length===1 && hex(x.id) && /^sha256:[a-f0-9]{64}$/.test(x.image) && hex(x.runtimeHash) && Array.isArray(x.mountHashes) && x.mountHashes.length>0 && x.mountHashes.every(m=>['bind','volume'].includes(m.type) && typeof m.destination==='string' && typeof m.rw==='boolean' && hex(m.identityHash));
 }) && services.find(x=>x.service==='symphony').id===b.engineContainer,'Complete engine/auth live identity proof required');
 need(ownership.kind==='deployment-ownership-v1' && ownership.effects==='none' && ownership.repo===b.repo && ownership.base===b.base && ownership.controllerVersion===b.merge && ownership.engine===b.engineContainer && ownership.engineImage===b.engineImage && ownership.dataVolume===b.dataVolume && same(ownership.sourceRequest,b.evidence.ownershipRequest) && ownership.runtimeIdle===true && ownership.controllerLock===false && ownership.manifestContract===digest(originalManifest) && own?.ledgerHash===b.evidence.ledger.hash && own.enrollmentHash===b.evidence.enrollment.hash,'Pinned read-only live ownership evidence mismatch');
}
// The receipt is an additional historical fact, never runner completion or a budget reset.
export async function verifiedExternalReceipt(c,key,observation) {
 const dir=join(c.stateRoot,key),path=join(dir,'external-reconciliation.json');
 const receipt=await optional(path);if(!receipt)return false;
 await privatePath(path);const b=receipt.binding;
 need(((receipt.v===1 && b?.v===1 && b.profile===undefined)||(receipt.v===2 && b?.v===2 && controllerV2(b))) && receipt.status==='externally-reconciled' && receipt.done===true && sha(receipt.controllerVersion) && b.repo===c.repo && b.base===c.base && key===keyFor(b) && receipt.id===digest(b) && [b.head,b.tree,b.merge].every(sha),'Invalid external reconciliation receipt');
 need(same(Object.keys(b.evidence).sort(),evidenceNames(b).sort()),'Incomplete reconciliation receipt');
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
 need(ledger.issue===b.issue && ledger.launch?.repo===b.repo && ledger.launch.base===b.base && ledger.launch.limit===(controllerV2(b)?b.originalLimit:b.originalIterations) && keyFor(ledger.launch)===key && ledger.iterations===b.originalIterations,'Receipt ledger scope/history mismatch');
 need(same(JSON.parse(await readFile(join(receipt.archive,'manifest'))),ledger.launch),'Archived manifest scope mismatch');
 if(controllerV2(b)) {
  const data={};for(const name of evidenceNames(b))if(b.evidence[name].hash!==null)data[name]=await readFile(join(receipt.archive,name));
  need(receipt.controllerVersion===b.merge,'Receipt controller version mismatch');validateControllerCompletion(b,ledger,data);
 } else {
  const recovery=JSON.parse(await readFile(b.evidence.recovery.path)),validation=JSON.parse(await readFile(b.evidence.validation.path));
  need(recovery.issue===Number(b.issue) && recovery.pr===b.pr && recovery.head===b.head && recovery.tree===b.tree && recovery.previous_iterations===b.originalIterations && recovery.additional_iterations_used===b.externalIterations && validation.commit===b.merge && validation.head===b.head && validation.tree===b.tree,'Receipt external completion/history mismatch');
 }
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
 need(ledger.issue===c.issue && ledger.launch?.repo===c.repo && ledger.launch.issue===c.issue && ledger.launch.base===c.base && same(ledger.launch,manifest) && ledger.iterations===c.originalIterations && ledger.launch.limit===(controllerV2(c)?c.originalLimit:c.originalIterations) && ledger.in_flight===true && ledger.stage==='blocked' && ledger.active_session && Array.isArray(ledger.events),'Exact interrupted runner history required');
 need(launch.contract===digest(manifest) && launch.dispatched===true && !launch.done,'Original interrupted launch journal required');
 if(controllerV2(c)) {
  validateControllerCompletion(b,ledger,data);
  need(same(await io.installedController(),{commit:c.merge,tree:c.tree}),'Installed controller commit/tree changed');
  const live=await io.ownership({retired:!!intent && !await optional(p.manifest)});
  const proof=JSON.parse(data.ownership);
  need(live.kind===proof.kind && live.effects==='none' && live.engine===c.engineContainer && live.engineImage===c.engineImage && live.dataVolume===c.dataVolume && live.controllerVersion===c.merge && same(live.sourceRequest,c.evidence.ownershipRequest) && same(live.ledgerHashes,proof.ledgerHashes) && same(live.serviceEvidence,proof.serviceEvidence) && live.runtimeIdle===true,'Current live ownership changed');
 } else {
  need(recovery.issue===Number(c.issue) && recovery.pr===c.pr && recovery.head===c.head && recovery.tree===c.tree && recovery.previous_iterations===c.originalIterations && recovery.additional_iterations_used===c.externalIterations && recovery.status==='fourth-complete-validated' && recovery.original_ledger_unchanged===true && recovery.docker_tests?.failed===0 && recovery.docker_tests.tests>0,'External recovery history/validation mismatch');
  need(validation.status==='deployed' && validation.commit===c.merge && validation.head===c.head && validation.tree===c.tree && validation.image===c.engineImage && validation.original_interrupted_ledger_preserved===true,'Pinned external completion validation mismatch');
 }
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
 for(const name of evidenceNames(c).filter(n=>!['manifest','gate'].includes(n)))await bytes(c.evidence[name]);
 if(active!==null) {await bytes(c.evidence.manifest);await rm(p.manifest);const d=await open(c.launchRoot,'r');try{await d.sync();}finally{await d.close();}}
 await checkpoint('manifest-retired');
 await io.ack(null,fence);idle(c,await io.engine(),null,fence);
 await atomic(p.intent,{v:1,id,binding:b,phase:'manifest-retired'});
 await io.authorize();
 await atomicBytes(p.gate,data.gate);await checkpoint('gate-restored');
 await io.ack(null,originalGate);idle(c,await io.engine(),null,originalGate);
 for(const name of evidenceNames(c).filter(n=>!['manifest','gate'].includes(n)))await bytes(c.evidence[name]);
 need(await io.workers()===true,'Worker appeared before reconciliation completion');
 await atomic(p.receipt,{v:b.v,id,binding:b,status:'externally-reconciled',done:true,archive,controllerVersion:c.controllerVersion,checks:['original-bytes','merged-pr-head-tree','engine-processes-idle','admission-fence','manifest-absent','original-gate-restored']});
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
 if(controllerV2(c)) {
  io.installedController=async()=>{
   const r=await command('git',['-C',c.trustedRoot,'rev-parse','HEAD','HEAD^{tree}']);need(r.exit===0,'Controller version observation unavailable');
   const [commit,tree]=r.output.toString().trim().split('\n');return {commit,tree};
  };
  io.ownership=async()=>{
   const request=JSON.parse(await bytes(c.evidence.ownershipRequest));
   for(const k of ['repo','base','stateRoot','inboxRoot','launchRoot','gateRoot','trustedRoot','controllerVersion','dataVolume','engineURL'])need(request[k]===c[k],'Ownership request installation/scope mismatch');
   need(request.ownershipVersion===1 && request.project===c.productionProject,'Explicit current-only live ownership request required');
   const containers=async()=>{
    const text=await docker(['ps','-a','--filter','label=com.docker.compose.project='+request.project,'--format','json']),all={};
    for(const line of text.trim().split('\n').filter(Boolean)) {
     const row=JSON.parse(line),x=JSON.parse(await docker(['inspect',row.ID]))[0],service=x.Config?.Labels?.['com.docker.compose.service'];
     need(['symphony','github-auth'].includes(service) && !all[service] && x.Config.Labels['com.docker.compose.project']===request.project,'Unexpected ownership service');all[service]=x;
    }
    need(all.symphony?.Id===c.engineContainer && all['github-auth'],'Ownership engine/auth missing or changed');return all;
   };
   deploymentConfig(request,{ownership:true});
   const all=await containers(),observation=await observeDeploymentOwners(request,{containers,docker}),s=await engine();
   // The pinned full CLI proof authenticated canonical host binds. Fresh hashes
   // reauthenticate those same live objects without copying key custody here.
   const serviceEvidence=await ownershipServiceEvidence(all,docker),after=await containers();
   need(observation.engine===all.symphony.Id && ['symphony','github-auth'].every(k=>after[k].Id===all[k].Id && same(after[k].Mounts,all[k].Mounts) && same(after[k].Config,all[k].Config) && same(after[k].HostConfig,all[k].HostConfig) && after[k].Image===all[k].Image && after[k].State?.Running===true && after[k].State.Health?.Status==='healthy'),'Ownership services changed during observation');
   return {kind:'deployment-ownership-v1',effects:'none',engine:observation.engine,engineImage:all.symphony.Image,dataVolume:c.dataVolume,controllerVersion:c.controllerVersion,sourceRequest:c.evidence.ownershipRequest,ledgerHashes:observation.rows.map(r=>({file:r.file,ledgerHash:digest(Buffer.from(r.bytes,'base64')),enrollmentHash:r.enrollment===null?null:digest(Buffer.from(r.enrollment,'base64'))})).sort((a,b)=>a.file.localeCompare(b.file)),serviceEvidence,runtimeIdle:runtimeOwnersIdle(s)};
  };
 }
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
// Only immutable external source refs of already verified historical receipts
// can add RO helper mounts. Source files remain live-byte checked, never replaced
// with archived copies; no caller-provided generic mount allowlist exists.
export async function historicalReceiptEvidence(c) {
 const refs=new Map();
 for(const entry of await readdir(c.stateRoot,{withFileTypes:true})) {
  need(!entry.isSymbolicLink(),'Unknown historical owner path');
  if(!entry.isDirectory() || entry.name===keyFor(c))continue;
  const r=await optional(join(c.stateRoot,entry.name,'external-reconciliation.json'));if(!r)continue;
  need(hex(entry.name) && await verifiedExternalReceipt(c,entry.name),'Invalid historical external receipt');
  for(const name of evidenceNames(r.binding).filter(n=>!['ledger','enrollment','manifest','launchJournal','controllerJournal','gate'].includes(n))) {
   const ref=r.binding.evidence[name],previous=refs.get(ref.path);
   need(!previous || previous.hash===ref.hash,'Conflicting historical external evidence');refs.set(ref.path,ref);
  }
 }
 return [...refs.values()].sort((a,b)=>a.path.localeCompare(b.path));
}
// Adapter for the existing external named-volume operator. The coding engine is
// never an operator, even if it can read a candidate copy of these scripts.
export async function verifyReconciliationOperator(c,{docker,containerized,hostname,contextFor=mountContext,canonical=realpath,historicalEvidence=historicalReceiptEvidence}) {
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
 const binds=[[c.trustedRoot,false],[dirname(c.configFile),false],[c.stateRoot,true],[c.inboxRoot,true],[c.launchRoot,true],[c.gateRoot,true],['/tmp',true],['/var/run/docker.sock',true],[c.evidence.recovery.path,false],[c.evidence.validation.path,false],...(controllerV2(c)?['publishArtifact','review','tests','ownership','ownershipRequest',...(extendedBudget(c)?['authorization']:[])].map(k=>[c.evidence[k].path,false]):[])];
 for(const ref of await historicalEvidence(c)) {
  const existing=binds.find(([path])=>path===ref.path);
  need(!existing || existing[1]===false,'Historical evidence must be read-only');if(!existing)binds.push([ref.path,false]);
 }
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
