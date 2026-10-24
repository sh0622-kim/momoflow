// Install this CLI from a reviewed, pinned checkout OUTSIDE the engine/candidate workspace.
// There is deliberately no build, pull, shell command hook, policy editor or ledger writer.
import { verifiedExternalReceipt } from './reconcile-external.mjs';
import { fixtureMountSources, verifiedMountSources, mountContext, identitiesOverlap } from './deploy-mount-identity.mjs';
import { readFile, readdir, lstat, realpath, mkdir, open, rm, copyFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { atomic, digest, json, receipt, validation, list, github, verifyInstall, verifyIndependentOperator } from './post-pr.mjs';
import { command } from './post-pr-docker.mjs';
import { fixtureEvidence, inspectIsolation, fixtureRuntime, fixtureEnvironment, fixtureEmptyState } from './deploy-fixture.mjs';
export class DeploymentError extends Error {}
const require = (v, m) => { if (!v) throw new DeploymentError(m); };
const reason = e => e instanceof DeploymentError ? e.message : /^GitHub (GET|POST|PATCH) \/[^\s]+: [0-9]{3}$/.test(e.message || '') ? e.message : `External I/O/auth/config parsing failed${/^E[A-Z0-9_]+$/.test(e.code || '') ? ' ('+e.code+')' : ''}; inspect operator logs privately`;
const hex = x => /^[a-f0-9]{64}$/.test(x || '');
const sha = x => /^[a-f0-9]{40}$/.test(x || '');
const iid = x => /^sha256:[a-f0-9]{64}$/.test(x || '');
// Structural identity is distinct from byte/evidence fingerprints. Object key order is not data.
const same = isDeepStrictEqual;
const optional = async p => { try { return await json(p); } catch(e) { if(e.code === 'ENOENT') return null; throw e; } };
const sleep = ms => new Promise(r => setTimeout(r,ms));
export function deploymentConfig(c,{fixture=false,ownership=false}={}) {
  if(c.authBindProof!==undefined) {
    const p=c.authBindProof;
    require(!fixture && p && same(Object.keys(p).sort(),['hash','path','sourceRequest']) && p.sourceRequest && same(Object.keys(p.sourceRequest).sort(),['hash','path']) && [p,p.sourceRequest].every(x=>hex(x.hash) && typeof x.path==='string' && resolve(x.path)===x.path && !x.path.startsWith('/data/workspaces/')) && typeof c.operatorContainer==='string','Pinned host auth bind proof/sourceRequest and independent operator required');
  }
  const currentOnly=ownership && c.ownershipVersion===1;
  if(currentOnly) {
    require(!fixture && !c.fixtureMode && !c.fixtureSource && !c.fixtureRepository && c.current && !c.previous && !c.target,'Current-only ownership request required');
    require(c.authority?.observe===true && c.hold===false && /^[\w.-]+\/[\w.-]+$/.test(c.repo) && /^[1-9][0-9]*$/.test(c.issue) && typeof c.base==='string' && c.base.length>0,'Explicit read-only ownership authority/scope required');
    for(const k of ['stateRoot','inboxRoot','launchRoot','gateRoot','trustedRoot','ledgerRoot','tokenFile'])require(typeof c[k]==='string' && resolve(c[k])===c[k],'Absolute ownership path required: '+k);
    require(sha(c.controllerVersion) && /^[a-z0-9][a-z0-9_-]+$/.test(c.project) && /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(c.dataVolume || '') && /^http:\/\/(127\.0\.0\.1|host\.docker\.internal):[0-9]+$/.test(c.engineURL) && Number.isInteger(c.verifyMs) && c.verifyMs>=1 && c.verifyMs<=300000,'Pinned ownership installation/deadline required');
    const b=c.current;
    require(sha(b.commit) && iid(b.image) && iid(b.authImage) && hex(b.runnerSource) && hex(b.composeHash) && typeof b.composeFile==='string' && resolve(b.composeFile)===b.composeFile && b.files?.[b.composeFile]===b.composeHash && Object.values(b.files).every(hex) && b.inspect?.symphony && b.inspect?.['github-auth'],'Complete pinned current engine/auth bundle required');
    return c;
  }
  require(fixture ? c.fixtureMode==='credential-free-v1' && c.fixtureSource && c.fixtureRepository && c.integration && c.repo==='smoke/fixture' && same(c.manifest,{status:'absent'}) && c.tokenFile===undefined : !c.fixtureMode && !c.fixtureSource && !c.fixtureRepository, 'Fixture requests require the separate isolated integration entrypoint');
  require(hex(c.deploymentId) && /^[\w.-]+\/[\w.-]+$/.test(c.repo) && /^[1-9][0-9]*$/.test(c.issue), 'Explicit deployment scope required');
  require(c.authority?.deploy===true && c.hold === false && c.compatibility === 'unchanged-data' && c.exceptional === false, 'Explicit deployment authority, unchanged data and ordinary scope required; exceptional changes need separate handling');
  require(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(c.dataVolume || ''),'Explicit data named volume required');
  require(/^[a-z0-9][a-z0-9_-]+$/.test(c.project), 'Explicit Compose project required');
  for(const k of ['stateRoot','deploymentRoot','gateRoot','trustedRoot',...(fixture?['launchRoot']:['tokenFile']),'inboxRoot','ledgerRoot']) require(typeof c[k] === 'string' && resolve(c[k]) === c[k], `Absolute operator path required: ${k}`);
  require(Number.isInteger(c.drainMs) && c.drainMs >= 1 && c.drainMs <= 3600000 && Number.isInteger(c.verifyMs) && c.verifyMs >= 1 && c.verifyMs <= 300000, 'Bounded drain/verification deadlines required');
  require(/^http:\/\/(127\.0\.0\.1|host\.docker\.internal):[0-9]+$/.test(c.engineURL), 'Independent host-published endpoint required');
  require(sha(c.controllerVersion) && sha(c.validationOrigin), 'Pinned installer/validator versions required');
  for(const b of [c.target,c.previous]) {
    require(b && sha(b.commit) && iid(b.image) && (fixture ? b.authImage===undefined : iid(b.authImage)) && hex(b.runnerSource) && hex(b.composeHash), 'Pinned image/commit/config/source bundle required');
    require(typeof b.composeFile === 'string' && resolve(b.composeFile) === b.composeFile && b.files && Object.keys(b.files).length > 0, 'Complete operator bundle required');
    require(b.files[b.composeFile] === b.composeHash && Object.values(b.files).every(hex), 'Compose/file identity missing');
    require(b.inspect?.symphony && (fixture ? same(Object.keys(b.inspect),['symphony']) : b.inspect?.['github-auth']), 'Expected runtime contract required for both services');
  }
  if(fixture) {
    require(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(c.codexVolume || '') && c.codexVolume!==c.dataVolume,'Distinct fixture Codex volume required');
    const controls=['stateRoot','deploymentRoot','gateRoot','launchRoot','inboxRoot','ledgerRoot'].map(k=>c[k]);
    require(controls.every((p,i)=>controls.every((q,j)=>i===j || !(p===q || p.startsWith(q+'/') || q.startsWith(p+'/')))),'Fixture control roots must be disjoint');
  }
  require(c.target.image !== c.previous.image && c.target.commit !== c.previous.commit, 'A deployment must replace a version, not count a no-op as success');
  require(c.target.authImage === c.previous.authImage, 'MVP preserves isolated auth service/image; auth upgrades require separate operation');
  require(c.evidence && hex(c.evidence.hash) && typeof c.evidence.path === 'string', 'Pinned trusted host merge evidence required');
  return c;
}
export function drained(s, generation) {
  const a=s.admission;
  require(a?.contract === 1 && a.configured === true && a.paused === true && a.generation === generation && !a.error, 'Admission acknowledgement missing/mismatched (bootstrap unsupported)');
  for(const k of ['running','retrying','claimed','blocked']) require(Array.isArray(a[k]), `Incomplete admission state: ${k}`);
  require(typeof a.pending_dispatch === 'boolean', 'Unknown pending dispatch');
  return !a.pending_dispatch && ['running','retrying','claimed','blocked'].every(k=>a[k].length===0);
}
export function activeContract(c,b,s,paused) {
  const a=s.admission, l=s.momoflow_launch;
  require(a?.contract===1 && a.configured===true && a.paused===paused && a.generation===c.deploymentId && !a.error, 'Admission contract mismatch');
  require(l?.contract===1 && l.source===b.runnerSource && l.repo===c.repo && l.concurrency===1 && l.role_flow===true && l.launch_read_only===true && l.inbox_read_only===true && l.launch_root==='/run/momoflow-launch' && l.inbox_root==='/run/momoflow-resume', 'Active execution contract mismatch');
  const m=c.manifest;
  require(m && (same(m,{status:'absent'}) || (m.status==='present' && same(Object.keys(m).sort(),['status','value']) &&
    m.value?.v===1 && hex(m.value.id) && m.value.repo===c.repo && /^[1-9][0-9]*$/.test(m.value.issue) && m.value.base===c.base &&
    [1,2,3].includes(m.value.limit) && same(Object.keys(m.value).sort(),['base','id','issue','limit','repo','v']))),'Invalid launch manifest');
  require(same(l.manifest,m), 'Launch manifest/limit changed');
}
export async function deploymentEvidence(c, e, api, log) {
  require(digest(e)===c.evidence.hash, 'Host evidence identity mismatch');
  const p=receipt({...c,launch:e.ledger?.launch},e.ledger);
  require(same(p,e.publication) && p.repo===c.repo && p.issue===c.issue && p.base===c.base && e.merge===c.target.commit, 'Publication/merge scope mismatch');
  const v=validation({...c,controllerVersion:c.validationOrigin},p,e.validation);
  require(v.kind==='passed' && v.image===c.target.image, 'Deploy the tested image itself');
  for(const row of v.checks) require(digest(await log(row.log))===row.log, 'Host validation log corrupt/missing');
  // Preserve the existing baseline, even if older validators accepted fewer tests.
  require(v.checks.find(x=>x.name==='contracts').tests>=87 && v.checks.find(x=>x.name==='node').tests>=126, 'Required role87/host126 evidence missing');
  const root=`/repos/${c.repo}`, pr=await api('GET',`${root}/pulls/${p.pr}`);
  require(pr.merged===true && pr.merge_commit_sha===c.target.commit && pr.head?.sha===p.head && pr.head.repo?.full_name===c.repo && pr.base?.ref===c.base && pr.base.repo?.full_name===c.repo, 'Exact merged PR mismatch');
  const commit=await api('GET',`${root}/git/commits/${c.target.commit}`);
  require(commit.tree?.sha===p.tree && commit.parents?.length===2 && commit.parents[0].sha===p.base_head && commit.parents[1].sha===p.head, 'Merge tree/parents mismatch');
  const branch=await api('GET',`${root}/branches/${encodeURIComponent(c.base)}`);
  require(branch.protected===false && (await list(api,`${root}/rules/branches/${encodeURIComponent(c.base)}`)).length===0, 'Unsupported protection/rules require operator handling');
  const checks=await list(api,`${root}/commits/${p.head}/check-runs`,'check_runs');
  require(Array.isArray(c.requiredChecks) && Array.isArray(c.requiredReviewers), 'Explicit check/reviewer policy required');
  for(const req of c.requiredChecks) {
    const rows=checks.filter(x=>x.name===req.name);
    require(rows.length===1 && rows[0].app?.id===req.appId && rows[0].head_sha===p.head && rows[0].status==='completed' && rows[0].conclusion==='success','Required exact-head check/producer mismatch');
  }
  const statuses=await list(api,`${root}/commits/${p.head}/statuses`), latest=new Map();
  for(const x of statuses) if(!latest.has(x.context)) latest.set(x.context,x);
  require([...latest.values()].every(x=>x.state==='success'),'Unsuccessful commit status');
  const reviews=await list(api,`${root}/pulls/${p.pr}/reviews`), byUser=new Map();
  for(const r of reviews) if(!['COMMENTED','PENDING'].includes(r.state)) byUser.set(r.user?.login,r);
  require(![...byUser.values()].some(x=>x.state==='CHANGES_REQUESTED'),'Unresolved review finding');
  for(const user of c.requiredReviewers) {
    const r=byUser.get(user);
    require(r?.state==='APPROVED' && r.commit_id===p.head && r.user?.type==='User' && r.user.login!==pr.user?.login,'Required independent human review missing');
    require(['admin','maintain','write'].includes((await api('GET',`${root}/collaborators/${encodeURIComponent(user)}/permission`)).permission),'Reviewer authority missing');
  }
  const source=await api('GET',`${root}/contents/engine/role_runner.ex?ref=${c.target.commit}`);
  require(source.encoding==='base64' && digest(Buffer.from(source.content,'base64'))===c.target.runnerSource,'Runner source does not match exact merged candidate');
  const files=await list(api,`${root}/pulls/${p.pr}/files`);
  // Engine, auth, host execution and their verification/configuration remain exceptional.
  // Check both sides of renames; preserving runtime shape does not prove unchanged policy.
  const policy=/^(AGENTS\.md$|WORKFLOW\.md$|README\.md$|Dockerfile(?:\.|$)|compose(?:\.[^/]+)?\.ya?ml$|\.dockerignore$|\.env(?:\.|$)|docs\/(agent-policy|constitution|deployment|deployment-fixture|post-pr|github-flow|human-actions|records)\.md$|security\/|\.github\/|\.codex\/|\.agents\/|scripts\/|engine\/|patches\/)/;
  require(!files.some(x=>policy.test(x.filename) || (x.previous_filename && policy.test(x.previous_filename))),'Policy/check/permission/budget changes require separate exceptional deployment');
  const [owner,name]=c.repo.split('/');
  const response=await api('POST','/graphql',{query:'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved} pageInfo{hasNextPage}}}}}',variables:{owner,name,number:p.pr}});
  const threads=response.data?.repository?.pullRequest?.reviewThreads;
  require(!response.errors && threads && threads.pageInfo?.hasNextPage===false && threads.nodes.every(x=>x.isResolved===true),'Unresolved/incomplete review threads');
  return {head:p.head,tree:p.tree,merge:c.target.commit,image:v.image,request:v.request};
}

// Real state machine, injected ports only for local contract tests. Production uses fixed ports below.
export async function deploy(c,io,{preflight=false,fixture=false}={}) {
  deploymentConfig(c,{fixture});
  const fingerprint=digest(c), old=await io.load();
  await io.authorize();
  if(preflight) { await io.preflight(); return {prepared:true,id:c.deploymentId}; }
  if(old) {
    require(old.request===fingerprint,'Deployment ID reused with another request');
    if(old.phase==='complete' || old.phase==='rolled_back') {
      await io.observe();
      await io.verify(old.phase==='complete'?c.target:c.previous,false);
      await io.report(old); return old;
    }
    await io.gate(true);
    const observed=await io.observe(); // Never replay an uncertain external effect.
    const stopped={...old,observed,phase:'blocked',next:'Operator must inspect journal, gate, actual containers and lock ownership; no automatic replay or ledger edits'};
    await io.save(stopped); await io.report(stopped);
    throw new DeploymentError('Interrupted/blocked deployment requires operator recovery; admission remains held');
  }
  await io.preflight(); // No intent or fence if authority/evidence/bootstrap is invalid.
  let j={v:1,evidenceKind:c.fixtureSource?'isolated-fixture':'github-merged',id:c.deploymentId,request:fingerprint,target:c.target,previous:c.previous,started:new Date().toISOString(),events:[],phase:'intent'};
  const record=async(phase,extra={})=>{j={...j,...extra,phase,updated:new Date().toISOString(),events:[...j.events,{phase,at:new Date().toISOString()}]}; await io.save(j);};
  await record('intent');
  let replacement=false, resumeAttempted=false;
  try {
    await record('pause_intent'); await io.gate(true);
    await record('draining',{pauseAdmission:(await io.state()).admission});
    const deadline=io.now()+c.drainMs;
    while(true) {
      await io.authorize();
      const s=await io.state(),a=s.admission;
      require(a?.contract===1 && a.configured===true && !a.error,'Admission unavailable while waiting for acknowledgement');
      // File publication precedes asynchronous engine acknowledgement. A valid older
      // generation is not proof of drain; wait within the SAME deadline, then fail closed.
      if(a.generation===c.deploymentId && a.paused===true && drained(s,c.deploymentId) && await io.ownersIdle()) break;
      require(io.now()<deadline,'Drain timeout; deployment deferred; active work was not stopped');
      await io.sleep();
    }
    await record('drained',{drainedAdmission:(await io.state()).admission});
    await record('backup_intent'); await io.backup();
    await record('preserved');
    await io.authorize(); await io.preReplace();
    require(drained(await io.state(),c.deploymentId) && await io.ownersIdle(),'Drain/owner state changed before replacement');
    await record('replace_intent'); replacement=true; await io.replace(c.target);
    await record('verify_intent');
    await record('verified',{targetVerification:await io.verify(c.target,true)});
    await io.authorize();
    await record('resume_intent'); resumeAttempted=true; await io.gate(false); const resumedVerification=await io.verify(c.target,false);
    await record('complete',{resumedVerification,next:'Observe runtime; automatic promotion remains disabled'});
  } catch(e) {
    // Local messages contain no command output, environment, keys or API response bodies.
    await record('failure',{reason:reason(e),next:'Admission held; inspect deployment journal'});
    await io.gate(true);
    if(replacement) {
      try {
        // Once resume was attempted, a worker may already have started. Fence and drain
        // again; never kill it merely to roll back an uncertain resume.
        if(resumeAttempted) {
          const end=io.now()+c.drainMs;
          while(!drained(await io.state(),c.deploymentId) || !await io.ownersIdle()) {
            require(io.now()<end,'Resume uncertainty: work is active; rollback deferred'); await io.sleep();
          }
        }
        await record('rollback_intent'); await io.replace(c.previous);
        await record('rollback_verify_intent');
        await record('rollback_verified',{rollbackVerification:await io.verify(c.previous,true)});
        await io.authorize();
        await record('rollback_resume_intent'); await io.gate(false); const resumedVerification=await io.verify(c.previous,false);
        await record('rolled_back',{resumedVerification,next:'Previous bundle verified; correct candidate before a new authorized deployment'});
      } catch(r) {
        await io.gate(true);
        await record('blocked',{rollbackReason:reason(r),next:'Rollback failed; leave admission closed and inspect actual containers/config/auth. Do not reset ledgers'});
      }
    } else await record('deferred',{next:'Admission closed; let work finish and explicitly recover this request after inspecting owners/ledgers'});
  }
  // A failed GitHub write never causes a second deployment. Journal is already durable.
  await io.report(j);
  return j;
}

// Docker stores Compose seccomp files as inline JSON. Canonicalize object keys only;
// array order and every profile value remain part of the effective identity.
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x==='object'
  ? Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])) : x;
export function profileIdentity(text) {
  const profile=JSON.parse(text);
  require(profile && typeof profile==='object' && !Array.isArray(profile),'Seccomp JSON object required');
  return 'seccomp='+JSON.stringify(canonical(profile));
}
function securityIdentity(options) {
  return options?.map(x=>x.startsWith('seccomp=') ? profileIdentity(x.slice(8)) : x.replace(/^no-new-privileges:true$/,'no-new-privileges'));
}
// Inspect only security/config fields, never Env (which can contain credentials).
export function runtimeIdentity(x,{fixture=false}={}) {
  return {image:x.Image,user:x.Config.User,entrypoint:fixture?(x.Config.Entrypoint ?? null):x.Config.Entrypoint,command:x.Config.Cmd,
    mounts:x.Mounts.map(m=>({type:m.Type,source:m.Type==='volume'?m.Name:m.Source,destination:m.Destination,rw:m.RW})).sort((a,b)=>a.destination.localeCompare(b.destination)),
    privileged:x.HostConfig.Privileged,capAdd:x.HostConfig.CapAdd,capDrop:x.HostConfig.CapDrop,
    securityOpt:securityIdentity(x.HostConfig.SecurityOpt),networkMode:x.HostConfig.NetworkMode,readonly:x.HostConfig.ReadonlyRootfs,
    ports:x.HostConfig.PortBindings || {},environmentHash:digest([...(x.Config.Env || [])].sort())};
}
export async function matchDeploymentBundle(c,b,{containers,docker,fixture=false}) {
  const all=await containers(),services=fixture?['symphony']:['symphony','github-auth'];
  const authKeyIdentityHash=c.authBindProof?await boundAuthKeyProof(c,b,all,docker):null;
  for(const service of services) {
    const x=all[service];require(x && b.inspect[service],'Missing expected deployment service');
    const normalized={...x,Mounts:await verifiedMountSources(x,b.inspect[service],docker,service==='github-auth'?{authKeyIdentityHash}:undefined)};
    require(same(runtimeIdentity(normalized,{fixture}),b.inspect[service]) && x.State.Running && x.State.Health?.Status==='healthy','Actual image/config/security/health mismatch');
  }
  const after=await containers();
  for(const service of services)require(after[service]?.Id===all[service].Id && same(runtimeIdentity(after[service],{fixture}),runtimeIdentity(all[service],{fixture})) && after[service].State.Running && after[service].State.Health?.Status==='healthy','Deployment service changed during proof');
  return all;
}
export function safeRuntime(c,b,{fixture=false}={}) {
  if(fixture) return fixtureRuntime(c,b);
  const e=b.inspect.symphony, a=b.inspect['github-auth'];
  require(e.image===b.image && a.image===b.authImage && e.user==='momo' && !e.privileged && !a.privileged && !e.capAdd?.length && !a.capAdd?.length,'Unsafe image/user/capability');
  for(const x of [e,a]) {
    require(x.capDrop?.includes('ALL') && x.securityOpt?.some(s=>/^no-new-privileges(?::true|=true)?$/.test(s)) && !x.networkMode?.startsWith('container:') && x.networkMode!=='host','Unsafe sandbox/network');
    require(x.mounts.every(m=>!m.destination.includes('docker.sock') && !m.source.includes('docker.sock')),'Engine/auth must not receive Docker socket');
  }
  const allowed=['/data','/home/momo/.codex','/config/WORKFLOW.md','/run/momoflow-launch','/run/momoflow-resume','/run/momoflow-admission','/run/momoflow-auth'];
  require(e.mounts.every(m=>allowed.includes(m.destination) && (!m.rw || ['/data','/home/momo/.codex'].includes(m.destination))),'Unexpected engine mount/write authority');
  require(a.readonly===true,'Auth root filesystem must remain read-only');
  require(a.mounts.length===2 && a.mounts.every(m=>['/run/momoflow-auth','/run/secrets/github-app.pem'].includes(m.destination)),'Unexpected auth mount');
  require(hex(e.environmentHash) && hex(a.environmentHash),'Pinned effective environment required');
  const port=String(new URL(c.engineURL).port);
  require(Object.keys(e.ports || {}).join()==='4000/tcp' && e.ports['4000/tcp'].length===1 && e.ports['4000/tcp'][0].HostIp==='127.0.0.1' && e.ports['4000/tcp'][0].HostPort===port,'Independent loopback port mismatch');
  for(const dest of ['/config/WORKFLOW.md','/run/momoflow-launch','/run/momoflow-resume','/run/momoflow-admission','/run/momoflow-auth']) require(e.mounts.some(m=>m.destination===dest && m.rw===false),'Required read-only contract mount missing');
  require(e.mounts.some(m=>m.destination==='/data' && m.type==='volume' && m.source===c.dataVolume && m.rw),'Data volume mismatch');
  require(e.mounts.find(m=>m.destination==='/run/momoflow-admission').source===c.gateRoot,'Gate bind source mismatch');
  require(!e.mounts.some(m=>m.destination.includes('secrets') || m.destination.endsWith('.pem')) && a.mounts.some(m=>m.destination==='/run/secrets/github-app.pem' && !m.rw),'App key custody mismatch');
  require(e.securityOpt.some(s=>s.startsWith('seccomp=') && s!=='seccomp=unconfined'),'Seccomp profile required');
  // This entrypoint intentionally supports image + WORKFLOW changes only. Other runtime/auth
  // permission/mount/network/policy changes require a separate explicit operation.
}
// Only the explicitly supported Compose surface can reach `up`. Predict the effective
// identity from the rendered service + immutable image defaults, before Docker creates it.
export function composeIdentity(c,b,doc,images,profiles={}, {fixture=false}={}) {
  const keys=(x,allowed)=>require(x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).every(k=>allowed.includes(k)),'Unsupported Compose field');
  keys(doc,['name','services','volumes','networks']);
  require(doc.name===c.project && Object.keys(doc.services).sort().join()===(fixture?'symphony':'github-auth,symphony'),'Compose project/services mismatch');
  keys(doc.networks,['default']);keys(doc.networks.default,['name','external','ipam',...(fixture?['internal']:[])]);
  // Compose emits an empty IPAM object for the default network.
  // Accept only that serialization default; address/driver settings remain forbidden.
  if(Object.hasOwn(doc.networks.default,'ipam')) keys(doc.networks.default.ipam,[]);
  if(fixture) require(doc.networks.default.internal===true && !doc.networks.default.external,'Fixture network must block external traffic');
  const network=doc.networks.default.name;
  require(network===`${c.project}_default`,'Compose network mismatch');
  for(const v of Object.values(doc.volumes || {})) {keys(v,['name','external']);require(v.external===true && typeof v.name==='string','Existing external named volumes required');}
  const result={};
  for(const service of (fixture?['symphony']:['symphony','github-auth'])) {
    const s=doc.services[service], image=images[service], base=image.Config;
    keys(s,['image','user','entrypoint','command','environment','volumes','ports','networks','privileged','cap_add','cap_drop','security_opt','read_only','init','restart','stop_grace_period','healthcheck','depends_on']);
    require(image.Id===b.inspect[service].image && s.image===image.Id && !Object.keys(base.Volumes || {}).length,'Pinned image/default volumes mismatch');
    require(Array.isArray(s.networks) ? same(s.networks,['default']) : same(s.networks,{default:null}),'Only default project network supported');
    if(s.depends_on) {
      require(!fixture && service==='symphony','Unsupported dependency'); keys(s.depends_on,['github-auth']);keys(s.depends_on['github-auth'],['condition','required','restart']);
      require(s.depends_on['github-auth'].condition==='service_healthy' && s.depends_on['github-auth'].required!==false && !s.depends_on['github-auth'].restart,'Auth dependency mismatch');
    }
    if(s.healthcheck) {keys(s.healthcheck,['test','interval','timeout','start_period','start_interval','retries']);require(Array.isArray(s.healthcheck.test) && ['CMD','CMD-SHELL'].includes(s.healthcheck.test[0]),'Unsupported healthcheck');}
    require(s.init===true && s.restart==='unless-stopped','Expected init/restart required');
    const env=Object.fromEntries((base.Env || []).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];}));
    require(s.environment && !Array.isArray(s.environment) && Object.values(s.environment).every(x=>typeof x==='string'),'Resolved environment required');
    Object.assign(env,s.environment);
    if(fixture) fixtureEnvironment(c,env);
    const mounts=(s.volumes || []).map(m=>{
      keys(m,['type','source','target','read_only','bind','volume']);
      require(['bind','volume'].includes(m.type) && typeof m.source==='string' && typeof m.target==='string','Resolved mount required');
      // compose-go omits the false bool in config JSON. Only the dedicated fixture
      // accepts its canonical empty bind object; true remains forbidden everywhere.
      if(m.type==='bind') {keys(m.bind,['create_host_path']);require(m.bind.create_host_path===false || (fixture && !Object.hasOwn(m.bind,'create_host_path')),'Bind creation is outside deployment scope');}
      if(m.type==='volume') {keys(m.volume,['nocopy']);require(m.volume.nocopy===true,'Volume copying is outside deployment scope');}
      const source=m.type==='volume'?doc.volumes?.[m.source]?.name:m.source;
      require(typeof source==='string' && (m.type!=='bind' || resolve(source)===source),'Unknown mount source');
      return {type:m.type,source,destination:m.target,rw:m.read_only!==true};
    }).sort((a,b)=>a.destination.localeCompare(b.destination));
    require(new Set(mounts.map(x=>x.destination)).size===mounts.length,'Duplicate mount target');
    const ports={};
    for(const p of s.ports || []) {
      keys(p,['target','published','host_ip','protocol','mode']);
      require(p.protocol==='tcp' && p.mode==='ingress' && Number.isInteger(p.target) && typeof p.published==='string' && p.host_ip==='127.0.0.1','Resolved loopback port required');
      (ports[`${p.target}/tcp`] ||= []).push({HostIp:p.host_ip,HostPort:p.published});
    }
    require((s.entrypoint===undefined || s.entrypoint===null || Array.isArray(s.entrypoint)) && (s.command===undefined || s.command===null || Array.isArray(s.command)),'Use explicit argv arrays');
    const securityOpt=securityIdentity((s.security_opt || []).map(x=>{
      if(!x.startsWith('seccomp=')) return x;
      const path=x.slice(8);
      require(Object.hasOwn(profiles,path),'Pinned seccomp file content required');
      return profiles[path];
    }));
    const expected=b.inspect[service];
    // Docker normalizes no-new-privileges:true to no-new-privileges.
    const identity={image:image.Id,user:s.user ?? base.User,entrypoint:s.entrypoint ?? base.Entrypoint ?? null,
      command:s.command ?? (s.entrypoint?.length?null:base.Cmd),mounts,privileged:s.privileged ?? false,
      capAdd:s.cap_add?.length?s.cap_add:null,capDrop:s.cap_drop?.length?s.cap_drop:null,
      securityOpt,networkMode:network,readonly:s.read_only ?? false,ports,
      environmentHash:digest(Object.entries(env).map(([k,v])=>`${k}=${v}`).sort())};
    require(same(identity,{...expected,securityOpt:securityIdentity(expected.securityOpt)}),'Rendered Compose/runtime contract mismatch');
    result[service]=identity;
  }
  safeRuntime(c,{...b,inspect:result},{fixture});
  return result;
}
export async function bundleFiles(c,b,docker,{fixture=false}={}) {
  safeRuntime(c,b,{fixture});
  const contents={};
  for(const [path,hash] of Object.entries(b.files)) {
    await privateFile(path);const bytes=await readFile(path);
    require(digest(bytes)===hash,'Pinned bundle file changed');contents[path]=bytes;
  }
  const doc=await json(b.composeFile), images={};
  for(const [service,id] of (fixture?[['symphony',b.image]]:[['symphony',b.image],['github-auth',b.authImage]])) images[service]=JSON.parse(await docker(['inspect',id]))[0];
  const profiles={};
  for(const service of Object.values(doc.services || {})) for(const opt of service.security_opt || []) if(opt.startsWith('seccomp=')) {
    const path=opt.slice(8);
    require(resolve(path)===path && Object.hasOwn(contents,path),'Unpinned seccomp file');
    profiles[path]=profileIdentity(contents[path].toString('utf8'));
  }
  // Validate BEFORE even rendering: no unsupported host interpolation/indirection.
  composeIdentity(c,b,doc,images,profiles,{fixture});
  for(const service of Object.values(doc.services)) {
    for(const m of service.volumes || []) if(m.type==='bind' && !m.target.includes('secrets') && !['/run/momoflow-launch','/run/momoflow-resume','/run/momoflow-admission'].includes(m.target)) require(b.files[m.source],'Unpinned bind file in Compose');
  }
  const env=doc.services.symphony.environment;
  if(!fixture) require(env.MOMOFLOW_ADMISSION_ROOT==='/run/momoflow-admission' && env.MOMOFLOW_ROLE_FLOW==='1' && env.GITHUB_REPO===c.repo && env.GITHUB_TOKEN_FILE==='/run/momoflow-auth/token.json' && !env.GITHUB_TOKEN,'Token-file/role/admission environment required');
  const rendered=JSON.parse(await docker(['compose','--project-name',c.project,'-f',b.composeFile,'config','--format','json']));
  require(same(rendered,doc),'Compose bundle must already be fully rendered');
  composeIdentity(c,b,rendered,images,profiles,{fixture});
  return doc;
}
// Runs inside the already identified live data volume. Missing roles is valid only
// for the normal fresh image layout; malformed/unreadable/symlink state still fails.
export function readRoleRows(fs,root) {
  for(const p of [root,root+'/log',root+'/workspaces']) if(!fs.lstatSync(p).isDirectory()) throw Error('Invalid data layout');
  const dir=root+'/log/roles';
  try {if(!fs.lstatSync(dir).isDirectory()) throw Error('Invalid roles layout');}
  catch(e) {if(e.code==='ENOENT') return [];throw e;}
  const names=fs.readdirSync(dir);
  for(const n of names) if(!/^[a-f0-9]{64}\.json(?:\.enrolled)?$/.test(n) || (n.endsWith('.enrolled') && !names.includes(n.slice(0,-9)))) throw Error('Unknown ledger owner');
  return names.filter(n=>n.endsWith('.json')).map(file=>{
    if(!/^[a-f0-9]{64}\.json$/.test(file) || !fs.lstatSync(dir+'/'+file).isFile()) throw Error('Invalid role ledger file');
    const source=dir+'/'+file;
    const bytes=fs.readFileSync(source),x=JSON.parse(bytes);
    const enrolled=source+'.enrolled';let enrollment=null;
    try {
      const st=fs.lstatSync(enrolled);
      if(!st.isFile() || st.isSymbolicLink() || (st.mode&0o022) || fs.realpathSync(enrolled)!==enrolled) throw Error('Invalid enrollment file');
      enrollment=fs.readFileSync(enrolled).toString('base64');
    } catch(e) {if(e.code!=='ENOENT') throw e;}
    if((fs.lstatSync(source).mode&0o022) || fs.realpathSync(source)!==source) throw Error('Invalid role ledger permissions/path');
    return {file,issue:x.issue,publication:x.publication,stage:x.stage,in_flight:x.in_flight,active_session:!!x.active_session,bytes:bytes.toString('base64'),enrollment};
  });
}
// Executed only in the identified engine. Never read a host ledger mirror.
export async function observeDeploymentOwners(c,{containers,docker,fixture=false,contextFor=mountContext}) {
  const all=await containers(),engine=all.symphony;
  require(engine.Mounts.some(m=>m.Destination==='/data' && m.Type==='volume' && m.Name===c.dataVolume && m.RW),'Live data volume mismatch');
  let mounts=engine.Mounts;
  if(fixture) {
    const b=[c.previous,c.target].find(b=>b.image===engine.Image);
    require(b,'Unknown fixture ownership image');
    mounts=await fixtureMountSources(engine,b.inspect.symphony,docker);
  }
  const launch=mounts.find(m=>m.Destination==='/run/momoflow-launch');
  if(c.launchRoot) {
    require(launch?.Type==='bind' && launch.RW===false,'Live launch mount mismatch');
    if(fixture)require(launch.Source===c.launchRoot,'Live launch mount mismatch');
    else {
      const context=await contextFor(docker,Object.values(all)),host=await context.host(c.launchRoot),actual=context.mounted.get(launch);
      require(actual && host.inode && same(actual,host),'Live launch mount correspondence mismatch');
    }
  }
  const script=`const fs=require('fs');const rows=(${readRoleRows.toString()})(fs,'/data');let manifest=null;
    if(${!!launch}) { const p='/run/momoflow-launch/active.json';try {
      const st=fs.lstatSync(p);if(!st.isFile() || st.isSymbolicLink() || fs.realpathSync(p)!==p || (st.mode&0o022)) throw Error('Invalid live manifest');
      manifest=JSON.parse(fs.readFileSync(p));
    }catch(e){if(e.code!=='ENOENT')throw e;}}
    process.stdout.write(JSON.stringify({rows,manifest}));`;
  const observation=JSON.parse(await docker(['exec',engine.Id,'node','-e',script]));
  const after=await containers();
  for(const [service,x] of Object.entries(all)) {
    const y=after[service];
    require(y?.Id===x.Id && ['Mounts','Image','Config','HostConfig'].every(k=>same(y[k],x[k])) && y.State?.Running===x.State?.Running,'Ownership engine/mount changed');
  }
  if(fixture) require(observation.rows.length===0,'Credential-free fixture must not contain role ledgers');
  return {...observation,engine:engine.Id};
}
export function runtimeOwnersIdle(s) {
  const a=s.admission;
  return ['running','retrying'].every(k=>Array.isArray(s[k]) && s[k].length===0) &&
    a?.contract===1 && a.configured===true && !a.error && a.pending_dispatch===false &&
    ['running','retrying','claimed','blocked'].every(k=>Array.isArray(a[k]) && a[k].length===0);
}
// Hashed live metadata only: no key, token, Env or role body is emitted. A host
// proof authenticates canonical binds; a helper can recheck the same objects
// without mounting the auth private key into its own namespace.
export async function ownershipServiceEvidence(all,docker) {
  const context=await mountContext(docker,Object.values(all)),kernel=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
  const services=Object.entries(all).sort(([a],[b])=>a.localeCompare(b)).map(([service,x])=>{
    require(x.State?.Running && x.State.Health?.Status==='healthy','Ownership service unhealthy');
    const runtime=runtimeIdentity(x);
    const mountHashes=x.Mounts.map(m=>{const identity=context.mounted.get(m);require(identity,'Missing ownership mount identity');return {type:m.Type,destination:m.Destination,rw:m.RW,identityHash:digest(identity)};}).sort((a,b)=>a.destination.localeCompare(b.destination));
    return {service,id:x.Id,image:x.Image,runtimeHash:digest({...runtime,mounts:runtime.mounts.map(m=>m.type==='bind'?{...m,source:null}:m)}),mountHashes};
  });
  return {kernel,services};
}
// Operator-bound, original full host check. Only the unchanged auth key bind may
// use this proof; every other bind still requires fresh host/live correspondence.
export async function boundAuthKeyProof(c,b,all,docker) {
  const binding=c.authBindProof;
  require(binding && !c.fixtureMode,'Host auth bind proof required');
  const read=async ref=>{await privateFile(ref.path);const bytes=await readFile(ref.path);require(digest(bytes)===ref.hash,'Host auth proof/sourceRequest bytes changed');return JSON.parse(bytes);};
  const proof=await read(binding),source=await read(binding.sourceRequest);
  require(!source.authBindProof && source.ownershipVersion===1,'Original full host ownership check required; no chained proof');
  deploymentConfig(source,{ownership:true});
  require(proof.kind==='deployment-ownership-v1' && proof.effects==='none' && same(proof.sourceRequest,binding.sourceRequest) && proof.controllerVersion===source.controllerVersion && proof.engineImage===source.current.image && proof.dataVolume===source.dataVolume && proof.repo===source.repo && proof.base===source.base && proof.project===source.project && ['repo','base','project','dataVolume'].every(k=>source[k]===c[k]),'Host ownership proof scope/sourceRequest mismatch');
  require(b.authImage===source.current.authImage && same(b.inspect['github-auth'],source.current.inspect['github-auth']),'Auth bundle changed from full host proof');
  const live=await ownershipServiceEvidence(all,docker),auth=live.services.find(x=>x.service==='github-auth'),pinned=proof.serviceEvidence?.services?.filter(x=>x.service==='github-auth');
  require(live.kernel===proof.serviceEvidence?.kernel && pinned?.length===1 && same(auth,pinned[0]),'Auth service/kernel/runtime/mount changed from host proof');
  const key=b.inspect['github-auth'].mounts.filter(m=>m.destination==='/run/secrets/github-app.pem');
  require(key.length===1 && key[0].type==='bind' && key[0].rw===false,'Exact unchanged auth private-key bind required');
  const self=await verifyIndependentOperator(c,docker);
  require(!Object.values(all).some(x=>x.Id===self.Id),'Operator cannot be a managed service');
  // Compare live kernel identities too: opaque Docker Source names and aliases
  // cannot conceal a key or its parent mounted into the operator helper.
  const context=await mountContext(docker,[all['github-auth'],self]);
  const mounted=all['github-auth'].Mounts.find(m=>m.Destination==='/run/secrets/github-app.pem');
  const identity=context.mounted.get(mounted);
  require(identity && !self.Mounts.some(m=>{
    const a=context.mounted.get(m);return !a || identitiesOverlap(a,identity);
  }),'Operator must not mount auth key or secret parent');
  const hash=auth.mountHashes.filter(m=>m.destination==='/run/secrets/github-app.pem' && m.type==='bind' && m.rw===false);
  require(hash.length===1,'Host auth key mount evidence missing');return hash[0].identityHash;
}
export async function deploymentOwnershipCheck(c,{containers,docker,state,fixture=false,request,expectedManifest=c.manifest}) {
  deploymentConfig(c,{fixture,ownership:true});const b=c.ownershipVersion===1?c.current:c.previous;
  await bundleFiles(c,b,docker,{fixture});const all=await matchDeploymentBundle(c,b,{containers,docker,fixture});
  const s=await state();require(hex(s.admission?.generation) && typeof s.admission?.paused==='boolean','Admission observation unknown');
  activeContract({...c,manifest:expectedManifest,deploymentId:s.admission.generation},b,s,s.admission.paused);
  const observation=await observeDeploymentOwners(c,{containers,docker,fixture});
  const reconciled=await reconciledDeploymentOwners(c,observation.rows,observation),historicalOwnersIdle=await deploymentOwnersIdle(c,observation.rows,observation);
  let controllerLock=false;try{await lstat(join(c.stateRoot,'controller.lock'));controllerLock=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  const runtimeIdle=runtimeOwnersIdle(s);
  const serviceEvidence=await ownershipServiceEvidence(all,docker);
  const after=await containers();
  require(observation.engine===all.symphony.Id && Object.keys(all).every(k=>after[k]?.Id===all[k].Id && same(runtimeIdentity(after[k],{fixture}),runtimeIdentity(all[k],{fixture})) && after[k].State?.Running===true && after[k].State.Health?.Status==='healthy'), 'Ownership services changed during observation');
  return {kind:'deployment-ownership-v1',effects:'none',repo:c.repo,base:c.base,project:c.project,controllerVersion:c.controllerVersion,engine:observation.engine,engineImage:all.symphony.Image,dataVolume:c.dataVolume,...(request?{sourceRequest:request}:{}),ledgerHashes:observation.rows.map(r=>({file:r.file,ledgerHash:digest(Buffer.from(r.bytes,'base64')),enrollmentHash:r.enrollment===null?null:digest(Buffer.from(r.enrollment,'base64'))})).sort((a,b)=>a.file.localeCompare(b.file)),serviceEvidence,manifestContract:observation.manifest?digest(observation.manifest):null,reconciledOwners:[...reconciled].sort(),historicalOwnersIdle,runtimeIdle,controllerLock,ownersIdle:historicalOwnersIdle && runtimeIdle && !controllerLock};
}
export async function reconciledDeploymentOwners(c,rows,observation) {
  const reconciled=new Set();
  for(const entry of await readdir(c.stateRoot,{withFileTypes:true})) {
    if(!entry.isDirectory() || !hex(entry.name)) continue;
    if(await optional(join(c.stateRoot,entry.name,'external-reconciliation.json'))) {
      require(observation && observation.rows===rows && typeof c.launchRoot==='string' && resolve(c.launchRoot)===c.launchRoot,'Live reconciliation observation and explicit launchRoot required');
      if(await verifiedExternalReceipt(c,entry.name,observation)) reconciled.add(entry.name);
    }
  }
  return reconciled;
}
export async function deploymentOwnersIdle(c,rows,observation) {
  const reconciled=await reconciledDeploymentOwners(c,rows,observation);
  if(!await controllersIdle(c.stateRoot,reconciled)) return false;
  for(const row of rows) {
    if(reconciled.has(row.file.slice(0,-5))) continue;
    if(row.in_flight!==false || row.active_session) return false;
    if(row.stage==='done') continue;
    if(row.stage!=='await_validation') return false;
    const p=row.publication;
    if(!p || p.repo!==c.repo || p.issue!==row.issue || row.file!==`${digest(`${p.repo}:${p.issue}`)}.json`) return false;
    const j=await optional(join(c.stateRoot,row.file.slice(0,-5),'journal.json'));
    if(j?.done!==true || !same(j.publication,p) || j.request!==digest(p) || !sha(j.merged) ||
      j.mergeAttempt?.state!=='confirmed' || j.mergeAttempt.sha!==j.merged || j.validation?.kind!=='passed' ||
      j.validation.request!==j.request || j.validation.head!==p.head || j.validation.tree!==p.tree) return false;
  }
  return true;
}

async function privateFile(path) {
  const st=await lstat(path);
  require(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o022)===0 && await realpath(path)===path,'Operator file must be regular, canonical and not group/world writable');
}
export async function connected(c,requestFile,preflight=false,{isolatedStop=false}={}) {
  require(!c.fixtureMode && !c.fixtureSource && !c.fixtureRepository, 'Fixture requests require the separate isolated integration entrypoint');
  return connect(c,requestFile,preflight,{isolatedStop});
}
// Fixed completion module retains the same deployment/controller lock across retirement.
export async function connectedCompletion(c,requestFile,action) {
  require(!c.fixtureMode && !c.fixtureSource && !c.fixtureRepository,'Production completion requires GitHub evidence');
  return connect(c,requestFile,false,{completion:action});
}
// No fixture CLI flag or generic evidence callback. Isolation is mandatory here and
// production authorization is never represented by local fixture provenance.
export async function connectedFixture(c,requestFile,preflight=false,{isolatedStop=false}={}) {
  require(c.fixtureSource && c.fixtureRepository && c.integration, 'Explicit isolated fixture scope required');
  return connect(c,requestFile,preflight,{isolatedStop,fixture:true});
}
// Real fixture HTTP on its isolated loopback; never substitute another container
// or fall back to the host endpoint when the exact pinned runtime is unavailable.
// Separate isolated-only completion harness. Never accepts GitHub deployment credentials/evidence.
export async function connectedFixtureCompletion(c,requestFile,manifest,action) {
  require(c.fixtureSource && c.fixtureRepository && c.integration && c.repo==='smoke/fixture','Explicit isolated completion fixture required');
  require(manifest?.status==='present' && manifest.value?.v===1 && hex(manifest.value.id) && manifest.value.repo===c.repo && manifest.value.issue===c.issue && manifest.value.base===c.base && [1,2,3].includes(manifest.value.limit) && same(Object.keys(manifest.value).sort(),['base','id','issue','limit','repo','v']),'Exact isolated completion manifest required');
  return connect(c,requestFile,false,{fixture:true,completion:action,completionManifest:manifest});
}
export const fixtureHTTPProbe=`fetch('http://127.0.0.1:4000'+process.argv[1],{signal:AbortSignal.timeout(Number(process.argv[2]))}).then(async r=>{process.stdout.write(JSON.stringify({status:r.status,...(process.argv[1]==='/api/v1/state'?{state:await r.json()}: {})}));}).catch(()=>process.exit(1));`;
export async function fixtureHTTP(c,b,x,docker,path,timeout=5000) {
  require(c.fixtureMode==='credential-free-v1' && c.repo==='smoke/fixture' && c.integration && [c.previous,c.target].some(v=>same(v,b)),'Explicit fixture HTTP scope required');
  fixtureRuntime(c,b);
  require(['/api/v1/state','/'].includes(path) && Number.isInteger(timeout) && timeout>=1 && timeout<=5000,'Fixed fixture HTTP request required');
  require(/^[a-f0-9]{64}$/.test(x?.Id || ''),'Exact fixture container ID required');
  const check=async()=>{
    const live=JSON.parse(await docker(['inspect',x.Id]))[0];
    require(live?.Id===x.Id && live.State?.Running===true && live.State.Health?.Status==='healthy' && live.Config?.Labels?.['com.docker.compose.project']===c.project && live.Config.Labels['com.docker.compose.service']==='symphony','Fixture HTTP container identity/health mismatch');
    const normalized={...live,Mounts:await fixtureMountSources(live,b.inspect.symphony,docker)};
    require(same(runtimeIdentity(normalized,{fixture:true}),b.inspect.symphony),'Fixture HTTP pinned runtime mismatch');
  };
  await check();
  const response=JSON.parse(await docker(['exec',x.Id,'node','-e',fixtureHTTPProbe,path,String(timeout)]));
  await check();
  require(Number.isInteger(response.status) && response.status>=200 && response.status<300,'Fixture HTTP response unavailable');
  if(path==='/api/v1/state') require(response.state && typeof response.state==='object' && !Array.isArray(response.state),'Fixture HTTP state invalid');
  return response;
}
export async function integrationIsolation(c,live,docker,{fixture=false,recovery=false}={}) {
  const inspect=async id=>JSON.parse(await docker(['inspect',id]))[0];
  require(c.integration && /^momoflow-deploy-test-[a-z0-9-]+$/.test(c.project) && c.integration.productionEngine && c.integration.productionProject!==c.project,'Explicit isolated test/production identities required');
  const production=await inspect(c.integration.productionEngine);
  require(production.State.Running && production.Config.Labels?.['com.docker.compose.project']===c.integration.productionProject,'Production identity cannot be established');
  const auth=await inspect(c.integration.productionAuth);
  require(auth.State.Running && auth.Config.Labels?.['com.docker.compose.project']===c.integration.productionProject && auth.Config.Labels?.['com.docker.compose.service']==='github-auth','Production auth identity cannot be established');
  require(production.Config.Labels?.['com.docker.compose.service']==='symphony','Production engine service mismatch');
  const recoveryProbes=new Map();
  if(recovery && fixture && live.symphony.State.Running===false) {
    const x=live.symphony;
    // Validate the complete credential-free runtime surface before inheriting mounts.
    // Source correspondence is freshly proven by the helper below.
    const b=[c.target,c.previous].find(b=>b.image===x.Image);
    require(b,'Unknown failed fixture image');
    fixtureRuntime(c,b);
    const expected=b.inspect.symphony;
    const mounts=x.Mounts.map(m=>{
      const e=expected.mounts.find(e=>e.destination===m.Destination && e.type===m.Type && e.rw===m.RW);
      require(e && (m.Type==='bind' || m.Name===e.source),'Failed fixture mount authority mismatch');
      return m.Type==='bind'?{...m,Source:e.source}:m;
    });
    require(same(runtimeIdentity({...x,Mounts:mounts},{fixture:true}),expected),'Failed fixture runtime mismatch');
    recoveryProbes.set(x.Id,x.Image);
    // The helper must prove each inherited bind still equals its pinned host object.
    await fixtureMountSources(x,expected,docker,{recoveryProbes});
  }
  await inspectIsolation(c,[production,auth],Object.values(live),docker,{fixture,recoveryProbes});
  // Check prospective bundles as well, before Compose can mount anything.
  await inspectIsolation(c,[production,auth],Object.values(c.target.inspect).map(x=>({Mounts:x.mounts.map(m=>({Type:m.type,Name:m.source,Source:m.source})),HostConfig:{PortBindings:x.ports}})),docker,{fixture,live:Object.values(live),recoveryProbes});

}

export async function replaceConnectedBundle(c,b,{files,isolation,docker,containers,isolatedStop=false}) {
  await files(b);
  if(isolatedStop || c.integration) await isolation(b===c.previous);
  await docker(['compose','--project-name',c.project,'-f',b.composeFile,'up','-d','--no-build','--pull','never','--no-deps','symphony']);
  if(isolatedStop && b===c.target) {
    // Fixed, explicitly selected integration fault. No hooks, candidate commands or
    // production CLI flag. The same production verify/rollback path follows.
    await docker(['stop','--time','1',(await containers()).symphony.Id]);
  }
}

async function connect(c,requestFile,preflight,{isolatedStop=false,fixture=false,completion=null,completionManifest=null}={}) {
  deploymentConfig(c,{fixture,ownership:preflight==='ownership'});
  await privateFile(requestFile);
  const requestBytes=await readFile(requestFile), api=github(c), expectedManifest=completionManifest || c.manifest;
  require(same(JSON.parse(requestBytes),c),'Request bytes/config mismatch');
  let operationDeadline=null;
  const remaining=()=>operationDeadline ? Math.max(1,operationDeadline-Date.now()) : c.verifyMs;
  const docker=async args=>{
    const r=await command('docker',args,{timeout:remaining(),dockerConfig:c.dockerConfig});
    require(r.exit===0,`Docker operation failed: ${args[0]} (exit ${r.exit}); inspect host privately`);
    return r.output.toString().trim();
  };
  const inspect=async name=>JSON.parse(await docker(['inspect',name]))[0];
  const containers=async()=>{
    const all=JSON.parse(await docker(['ps','-a','--filter',`label=com.docker.compose.project=${c.project}`,'--format','json']).then(t=>'['+t.split('\n').filter(Boolean).join(',')+']'));
    const result={};
    for(const row of all) {
      const x=await inspect(row.ID), service=x.Config.Labels['com.docker.compose.service'];
      require((fixture?['symphony']:['symphony','github-auth']).includes(service) && !result[service],'Unexpected/duplicate project container');
      result[service]=x;
    }
    require(result.symphony && (fixture || result['github-auth']),'Both project services must already exist'); return result;
  };
  const fixtureRequest=async(path,b,all)=>{
    all ||= await containers();
    b ||= [c.previous,c.target].find(b=>b.image===all.symphony.Image);
    require(b,'Unknown fixture HTTP image');
    return fixtureHTTP(c,b,all.symphony,docker,path,Math.min(5000,remaining()));
  };
  const state=async()=>{if(fixture) return (await fixtureRequest('/api/v1/state')).state;const r=await fetch(`${c.engineURL}/api/v1/state`,{signal:AbortSignal.timeout(Math.min(5000,remaining()))}); require(r.ok,'State API unavailable');return r.json();};
  const gate=async paused=>atomic(join(c.gateRoot,'active.json'),{v:1,generation:c.deploymentId,paused},0o644);
  const authorize=async()=>{
    require(same(await readFile(requestFile),requestBytes),'Operator request changed');
    await verifyInstall(fixture?{...c,tokenFile:join(c.stateRoot,'unused-token-path')}:c);
    try {
      await lstat('/.dockerenv');
      await verifyIndependentOperator(c,docker);
    } catch(e) {if(e.code!=='ENOENT') throw e;}
  };
  const files=b=>bundleFiles(c,b,docker,{fixture});
  const observed=async()=>Object.fromEntries(Object.entries(await containers()).map(([k,x])=>[k,{...runtimeIdentity(x,{fixture}),running:x.State.Running,health:x.State.Health?.Status}]));
  const match=b=>matchDeploymentBundle(c,b,{containers,docker,fixture});
  if(preflight==='ownership') {
    await authorize();return deploymentOwnershipCheck(c,{containers,docker,state,fixture,request:{path:requestFile,hash:digest(requestBytes)}});
  }
  const observeOwners=async()=>observeDeploymentOwners(c,{containers,docker,fixture});
  const ownersIdle=async()=>{
    const observation=await observeOwners();
    return deploymentOwnersIdle(c,observation.rows,observation);
  };
  const isolation=async(recovery=false)=>integrationIsolation(c,await containers(),docker,{fixture,recovery});
  const fixtureState=async()=>{
    const all=await containers();
    const network=JSON.parse(await docker(['network','inspect',`${c.project}_default`]))[0];
    require(network.Internal===true,'Fixture external traffic is not blocked');
    const script=completionManifest ? fixtureEmptyState.replace("'/run/momoflow-launch',",'')+`
      const p='/run/momoflow-launch',names=fs.readdirSync(p);if(names.some(n=>n!=='active.json'))throw Error('Unexpected fixture launch files');
      if(names.length){const f=p+'/active.json',s=fs.lstatSync(f);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o022)||JSON.stringify(JSON.parse(fs.readFileSync(f)))!==JSON.stringify(${JSON.stringify(completionManifest.value)}))throw Error('Different fixture manifest');}` : fixtureEmptyState;
    await docker(['exec',all.symphony.Id,'node','-e',script]);
  };
  let controllerOwned=false;
  const preflightCheck=async()=>{
    await authorize();
    for(const path of [requestFile,c.stateRoot,c.deploymentRoot,c.gateRoot,c.inboxRoot,c.ledgerRoot,...(fixture?[c.launchRoot]:[c.tokenFile]),c.evidence.path]) {
      require(!path.startsWith(c.trustedRoot+'/') && !path.startsWith('/data/workspaces/') && !/[,\n\0]/.test(path),'Operational paths must be outside candidate/checkouts and valid Docker mount paths');
      // ledgerRoot is legacy installation metadata, never a host mirror used for drain.
      // A pristine live volume need not have log/roles yet.
      if(path===c.ledgerRoot && !fixture) continue;
      // deploymentRoot may not exist yet: preflight must not create it.
      if(path===c.deploymentRoot) {try {await lstat(path);} catch(e) {if(e.code==='ENOENT') continue;throw e;}}
      const st=await lstat(path);
      require(!st.isSymbolicLink() && await realpath(path)===path && !(st.mode&0o022),'Untrusted operational path');
    }
    if(isolatedStop || c.integration) await isolation();
    const previousDoc=await files(c.previous), targetDoc=await files(c.target);
    const shape=doc=>({...doc,services:Object.fromEntries(Object.entries(doc.services).map(([k,s])=>[k,{...s,image:k==='symphony'?null:s.image,volumes:s.volumes.map(m=>m.target==='/config/WORKFLOW.md'?{...m,source:null}:m)}]))});
    require(same(shape(previousDoc),shape(targetDoc)),'Compose runtime shape change requires separate operation');
    // All runtime fields except the image must remain identical. WORKFLOW is a pinned file
    // at the same bind path; its candidate bytes are preserved in the immutable bundle.
    const normalize=b=>({...b.inspect.symphony,image:null,mounts:b.inspect.symphony.mounts.map(m=>m.destination==='/config/WORKFLOW.md'?{...m,source:null}:m)});
    require(same(normalize(c.previous),normalize(c.target)) && same(c.previous.inspect['github-auth'],c.target.inspect['github-auth']),'Runtime permission/auth/config shape change requires separate operation');
    await privateFile(c.evidence.path);
    if(fixture) await fixtureEvidence(c,await json(c.evidence.path),docker);
    else await deploymentEvidence(c,await json(c.evidence.path),api,h=>readFile(join(dirname(c.evidence.path),'logs',h)));
    await match(c.previous);
    if(fixture) await fixtureState();
    const s=await state();
    require(s.admission?.contract===1 && s.admission.configured===true && !s.admission.error,'Admission installation/bootstrap required before automated deployment');
    activeContract({...c,manifest:expectedManifest,deploymentId:s.admission.generation},c.previous,s,s.admission.paused);
    require(c.manifest?.status==='absent' || (c.manifest?.status==='present' && [1,2,3].includes(c.manifest.value?.limit)),'Explicit manifest status required');
    await lstat(c.gateRoot); await readdir(c.stateRoot);
    if(!controllerOwned) {
      try {await lstat(join(c.stateRoot,'controller.lock'));throw Error('Controller/launch owns the installation; defer deployment');} catch(e) {if(e.code!=='ENOENT') throw e;}
    }
    // Ownership check here is read-only; execution rechecks under exclusive controller lock.
  };
  const dir=join(c.deploymentRoot,c.deploymentId);
  const io={authorize,state,gate,preflight:preflightCheck,now:Date.now,sleep:()=>sleep(500),ownersIdle,
    load:()=>optional(join(dir,'journal.json')),
    save:async j=>{await atomic(join(dir,`event-${String(j.events.length).padStart(4,'0')}.json`),j);await atomic(join(dir,'journal.json'),j);},
    observe:observed,
    preReplace:async()=>{if(c.integration) await isolation();await files(c.target);await files(c.previous);await match(c.previous);},
    backup:async()=>{
      await mkdir(join(dir,'bundle'),{recursive:true,mode:0o700});
      for(const b of [c.previous,c.target]) for(const [path,hash] of Object.entries(b.files)) {
        require(digest(await readFile(path))===hash,'Bundle changed before backup');
        await copyFile(path,join(dir,'bundle',hash));
      }
      await copyFile(c.evidence.path,join(dir,'evidence.json'));
      await docker(['image','save','--output',join(dir,'images.tar'),c.previous.image,c.target.image,...(!fixture?[c.previous.authImage]:[])]);
      // Named-volume access works on Docker Desktop: mount it read-only in an independent,
      // socketless helper. Backups are evidence only; NEVER restore stale ledgers automatically.
      await docker(['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','1000:1000',
        '--mount',`type=volume,src=${c.dataVolume},dst=/snapshot,readonly`,'--mount',`type=bind,src=${dir},dst=/backup`,
        '--entrypoint','tar',c.previous.image,'-cf','/backup/data.tar','-C','/snapshot','.']);
    },
    replace:b=>replaceConnectedBundle(c,b,{files,isolation,docker,containers,isolatedStop}),
    verify:async(b,paused,manifest=expectedManifest)=>{
      const deadline=Date.now()+c.verifyMs; operationDeadline=deadline;
      try { while(true) {
        try {
          await files(b);
          const all=await match(b), s=fixture?(await fixtureRequest('/api/v1/state',b,all)).state:await state(); activeContract({...c,manifest},b,s,paused);
          if(paused) require(drained(s,c.deploymentId),'Work appeared while fenced');
          if(fixture) await fixtureRequest('/',b,all);
          else {const dashboard=await fetch(c.engineURL,{signal:AbortSignal.timeout(Math.min(5000,remaining()))});require(dashboard.ok,'Dashboard unavailable');}
          if(fixture) {
            await isolation();
            await fixtureState();
          } else {
            await docker(['exec',all.symphony.Id,'codex','login','status']);
            // Probe the actual engine token-file reader without printing a token/body or using a model turn.
            await docker(['exec',all.symphony.Id,'node','-e',`const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.env.GITHUB_TOKEN_FILE));if(typeof x.token!=='string'||!(Date.parse(x.expires_at)>Date.now()+60000)||x.repository!==process.env.GITHUB_REPO||!['contents','issues','pull_requests'].every(k=>x.permissions?.[k]==='write')||!['read','write'].includes(x.permissions?.checks))process.exit(2);fetch('https://api.github.com/repos/'+process.env.GITHUB_REPO+'/issues?per_page=1',{headers:{Authorization:'Bearer '+x.token},signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:3)).catch(()=>process.exit(4))`]);
          }
          return {auth:fixture?'not-exercised':'passed',evidenceKind:fixture?'isolated-fixture':'github-merged',githubGate:fixture?'not-exercised':'passed',model:'not-exercised',...(fixture?{httpTransport:'fixture-container-loopback'}:{}),admission:s.admission,image:b.image,authImage:b.authImage,configHash:b.composeHash,runnerSource:b.runnerSource,paused,at:new Date().toISOString(),checks:['compose','image-config-security','dashboard','state',...(fixture?['credential-free-state','internal-network']:['codex-login','github-read']),'launch-role-contract','admission']};
        } catch(e) {if(Date.now()>=deadline) throw e;await sleep(Math.min(500,remaining()));}
      } } finally {operationDeadline=null;}
    },
    report:async j=>{
      if(fixture) return; // Private journals only; never publish a fixture as a production deployment.
      const marker=`<!-- momoflow:deployment:${c.deploymentId} -->`, path=`/repos/${c.repo}/issues/${c.issue}/comments`;
      const body=`${marker}\n배포 ${j.phase}: ${c.deploymentId}\n\n대상 ${c.target.commit} / ${c.target.image} / config ${c.target.composeHash}\n이전 ${c.previous.commit} / ${c.previous.image} / config ${c.previous.composeHash}\n시각 ${j.started} → ${j.updated}; 복구 ${j.phase==='rolled_back'?'검증 완료':j.events.some(x=>x.phase==='rollback_intent')?'시도 (journal 확인)':'없음'}.\n다음 행동: ${j.next}\n${j.reason?'실패: '+j.reason:''}${j.rollbackReason?'\n복구 실패: '+j.rollbackReason:''}\n로컬 journal: ${c.deploymentId}/journal.json; 세부 검사 단계·설정/백업은 operator 저장소에 보존.`;
      const comments=await list(api,path), found=comments.filter(x=>x.body?.includes(marker));require(found.length<=1,'Duplicate deployment report');
      await api(found.length?'PATCH':'POST',found.length?`/repos/${c.repo}/issues/comments/${found[0].id}`:path,{body});
    }
  };
  if(preflight) return deploy(c,io,{preflight:true,fixture});
  return withDeploymentLock(c,async()=>{
    controllerOwned=true;
    if(completion) return completion({...io,execute:()=>deploy(c,io,{fixture}),observeOwners,files,match,docker,containers,isolation});
    return deploy(c,io,{fixture});
  });
}
export async function controllersIdle(stateRoot,reconciled=new Set()) {
  for(const entry of await readdir(stateRoot,{withFileTypes:true})) {
    if(entry.isSymbolicLink()) return false;
    if(!entry.isDirectory()) continue;
    if(!hex(entry.name)) return false; // Unknown owner directory needs inspection.
    const dir=join(stateRoot,entry.name);
    try {await lstat(join(dir,'lock'));return false;} catch(e) {if(e.code!=='ENOENT') throw e;}
    if(reconciled.has(entry.name)) continue;
    for(const name of ['journal.json','launch.json']) {
      const journal=await optional(join(dir,name));
      if(journal && journal.done!==true) return false;
    }
  }
  return true;
}
export async function withDeploymentLock(c,action) {
  await mkdir(c.deploymentRoot,{recursive:true,mode:0o700});
  // Same lock as launch/watch. A crashed process deliberately leaves ownership evidence.
  const locks=[];
  try {
    for(const path of [join(c.deploymentRoot,'deployment.lock'),join(c.stateRoot,'controller.lock')]) {
      const f=await open(path,'wx',0o600);locks.push([path,f]);await f.writeFile(JSON.stringify({pid:process.pid,deployment:c.deploymentId}));await f.sync();
    }
    return await action();
  } finally {for(const [path,f] of locks.reverse()){await f.close();await rm(path);}}
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    require(process.argv.length<=4 && (!process.argv[3] || ['--preflight','--ownership-check'].includes(process.argv[3])),'Usage: node scripts/deploy.mjs /operator/request.json [--preflight|--ownership-check]');
    const path=resolve(process.argv[2]), result=await connected(await json(path),path,process.argv[3]==='--ownership-check'?'ownership':process.argv[3]==='--preflight');
    console.log(JSON.stringify(process.argv[3]==='--ownership-check'?result:{id:result.id,prepared:result.prepared,phase:result.phase}));
    if(result.phase && !['complete','rolled_back'].includes(result.phase)) process.exitCode=1;
  } catch(e) {console.error(reason(e));process.exitCode=1;}
}
