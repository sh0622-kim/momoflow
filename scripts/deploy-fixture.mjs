// Operator-owned LOCAL provenance. Never a GitHub review, merge or host receipt.
import { readFile, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { digest } from './post-pr.mjs';
import { command } from './post-pr-docker.mjs';
const need=(v,m)=>{if(!v) throw Error(m);};
export const fixtureLabels=(source,commit,tree)=>({
 'org.momoflow.fixture.source':source,'org.momoflow.fixture.commit':commit,
 'org.momoflow.fixture.tree':tree,'org.momoflow.fixture.scope':'isolated-deployment-only'
});
export async function fixtureSource(repository,source,commit,version) {
 need(/^[a-f0-9]{40}$/.test(source) && /^[a-f0-9]{40}$/.test(commit) && ['A','B'].includes(version),'Pinned fixture source/version required');
 const git=async args=>{
  const r=await command('git',['--no-optional-locks','-C',repository,...args]);
  need(r.exit===0,'Fixture Git inspection failed');return args[0]==='show' ? r.output : r.output.toString().trim();
 };
 need(await git(['rev-list','--parents','-n','1',commit])===`${commit} ${source}`,'Fixture must have exactly the reviewed source parent');
 need((await git(['ls-tree',commit,'--','.momoflow-fixture-version'])).startsWith('100644 blob '),'Regular fixture marker required');
 need(await git(['diff-tree','--no-commit-id','--name-status','-r',source,commit])==='A\t.momoflow-fixture-version','Fixture may only add its version marker');
 need(Buffer.from(await git(['show',`${commit}:.momoflow-fixture-version`])).toString()===version+'\n','Fixture marker mismatch');
 return {commit,tree:await git(['rev-parse',`${commit}^{tree}`]),runnerSource:digest(Buffer.from(await git(['show',`${commit}:engine/role_runner.ex`])))};
}
export async function fixtureEvidence(c,e,docker) {
 need(c.integration && /^momoflow-deploy-test-[a-z0-9-]+$/.test(c.project),'Fixture requires an isolated installation');
 need(e?.kind==='momoflow-isolated-fixture-v1' && digest(e)===c.evidence.hash && e.source===c.fixtureSource,'Fixture provenance scope/hash mismatch');
 need(typeof c.fixtureRepository==='string' && resolve(c.fixtureRepository)===c.fixtureRepository && await realpath(c.fixtureRepository)===c.fixtureRepository,'Canonical fixture repository required');
 need(Array.isArray(e.versions) && e.versions.length===2,'Two fixture versions required');
 for(const [i,version] of ['A','B'].entries()) {
  const row=e.versions[i];
  const actual=await fixtureSource(c.fixtureRepository,e.source,row.commit,version);
  need(actual.tree===row.tree && actual.runnerSource===row.runnerSource,'Fixture tree/source mismatch');
  need(/^sha256:[a-f0-9]{64}$/.test(row.image),'Immutable fixture image required');
  const image=JSON.parse(await docker(['inspect',row.image]))[0];
  const labels=fixtureLabels(e.source,row.commit,row.tree);
  need(image.Id===row.image && Object.entries(labels).every(([k,v])=>image.Config.Labels?.[k]===v),'Fixture image provenance mismatch');
  for(const name of ['build','smoke']) {
   const hash=row.logs?.[name];need(/^[a-f0-9]{64}$/.test(hash),'Fixture build/smoke log missing');
   const path=join(resolve(c.evidence.path,'..'),'logs',hash),st=await lstat(path);
   need(st.isFile() && !st.isSymbolicLink() && !(st.mode&0o022) && await realpath(path)===path && digest(await readFile(path))===hash,'Fixture log corrupt/untrusted');
  }
 }
 need(e.versions[0].commit!==e.versions[1].commit && e.versions[0].image!==e.versions[1].image,'Distinct fixture commits/images required');
 for(const b of [c.previous,c.target]) need(e.versions.some(x=>x.commit===b.commit && x.image===b.image && x.runnerSource===b.runnerSource),'Bundle not in fixture provenance');
 if(c.fixtureMode===fixtureMode) {
  const sourceHash=async path=>{
   const r=await command('git',['--no-optional-locks','-C',c.fixtureRepository,'show',`${e.source}:${path}`]);
   need(r.exit===0,'Reviewed fixture source file missing');return digest(r.output);
  };
  const workflow=await sourceHash('WORKFLOW.md'),seccomp=await sourceHash('security/codex-seccomp.json');
  for(const b of [c.previous,c.target]) {
   const path=b.inspect.symphony.mounts.find(m=>m.destination==='/config/WORKFLOW.md')?.source;
   need(b.files[path]===workflow,'Fixture must preserve reviewed WORKFLOW/model/permission/budget bytes');
   const doc=JSON.parse(await readFile(b.composeFile,'utf8'));
   const opts=doc.services.symphony.security_opt.filter(x=>x.startsWith('seccomp='));
   need(opts.length===1 && b.files[opts[0].slice(8)]===seccomp,'Fixture must preserve reviewed sandbox bytes');
  }
 }

 return {kind:e.kind,source:e.source,githubGate:'not-exercised',model:'not-exercised',auth:'not-exercised'};
}
// Validate ALL requests before the first external effect. Exact bundle equality includes
// files, source, expected runtime and commit; image/config equality alone is insufficient.
export function integrationPlan(requests) {
 need(Array.isArray(requests) && requests.length===3,'Three explicit requests required');
 const first=requests[0];
 need(new Set(requests.map(c=>c.deploymentId)).size===3,'Distinct deployment IDs required');
 const stable=['repo','base','project','dataVolume','engineURL','stateRoot','deploymentRoot','gateRoot','trustedRoot','inboxRoot','ledgerRoot','tokenFile','fixtureMode','codexVolume','launchRoot','manifest','integration','fixtureSource','fixtureRepository','controllerVersion','validationOrigin','requiredChecks','requiredReviewers','authority','hold','compatibility','exceptional','operatorContainer','dockerConfig','drainMs','verifyMs'];
 for(const [i,c] of requests.entries()) {
  need(c.integration && /^momoflow-deploy-test-[a-z0-9-]+$/.test(c.project),'Isolated project required');
  need(stable.every(k=>same(c[k],first[k])),'Integration installation/provenance changed');
  if(i) need(same(c.previous,requests[i-1].target),'Complete consecutive bundle chain required');
 }
 need(same(requests[1].target,first.previous) && same(requests[2].target,first.target),'A/B/A/B bundle chain required');
 return requests;
}
// Reject every shared mount source, including production auth key custody. Parent/child
// bind paths also overlap; read-only sources are not exempt in this experiment.
export function isolatedResources(c,production,test,{fixture=false}={}) {
 need(c.integration?.productionProject!==c.project && production.length===2 && test.length===(fixture?1:2),'Both production/test services required');
 const sources=production.flatMap(x=>x.Mounts.map(m=>({type:m.Type,source:m.Type==='volume'?m.Name:m.Source})));
 const overlap=(a,b)=>a===b || a.startsWith(b+'/') || b.startsWith(a+'/');
 for(const x of test) for(const m of x.Mounts) need(!sources.some(s=>s.type===m.Type && (m.Type==='volume'?s.source===m.Name:overlap(s.source,m.Source))),'Integration shares production mount/credential source');
 const ports=new Set(production.flatMap(x=>Object.values(x.HostConfig.PortBindings || {}).flat().map(p=>p.HostPort)));
 need(test.every(x=>!Object.values(x.HostConfig.PortBindings || {}).flat().some(p=>ports.has(p.HostPort))),'Integration shares production port');
}

// A deliberately narrow fixture contract: no configurable skip-auth switch.
export const fixtureMode='credential-free-v1';
export const fixtureEnvironmentValues={GITHUB_REPO:'smoke/fixture',GITHUB_TOKEN:'smoke-not-a-credential',MOMOFLOW_ROLE_FLOW:'1',MOMOFLOW_ADMISSION_ROOT:'/run/momoflow-admission',MOMOFLOW_LAUNCH_ROOT:'/run/momoflow-launch',MOMOFLOW_POST_PR_INBOX:'/run/momoflow-resume'};
export function fixtureEnvironment(c,env) {
 need(c.fixtureMode===fixtureMode && c.repo==='smoke/fixture','Credential-free fixture scope required');
 need(Object.entries(fixtureEnvironmentValues).every(([k,v])=>env[k]===v),'Fixed noncredential fixture environment required');
 // Image defaults are included: reject inherited credentials and execution overrides too.
 const base=['PATH','HOME','CODEX_HOME','GIT_ASKPASS','GIT_TERMINAL_PROMPT','MIX_ENV','LANG','LANGUAGE','LC_ALL','NODE_VERSION','YARN_VERSION','ELIXIR_VERSION','OTP_VERSION','ERLANG_VERSION','ELIXIR_SHA256','REBAR_VERSION'];
 need(Object.keys(env).every(k=>base.includes(k) || Object.hasOwn(fixtureEnvironmentValues,k)),'Unexpected fixture environment/credential');
}
export function fixtureRuntime(c,b) {
 const e=b.inspect.symphony;
 need(c.dataVolume!==c.codexVolume && c.project.startsWith('momoflow-deploy-test-'),'Distinct isolated data/Codex volumes required');
 need(c.fixtureMode===fixtureMode && b.authImage===undefined && same(Object.keys(b.inspect),['symphony']),'Single credential-free service required');
 need(e.image===b.image && e.user==='momo' && !e.privileged && !e.capAdd?.length && e.capDrop?.includes('ALL'),'Unsafe fixture image/user/capability');
 need(e.networkMode===`${c.project}_default` && e.securityOpt?.some(s=>/^no-new-privileges(?::true|=true)?$/.test(s)) && e.securityOpt.some(s=>s.startsWith('seccomp=') && s!=='seccomp=unconfined'),'Fixture sandbox/network required');
 const destinations=['/data','/home/momo/.codex','/config/WORKFLOW.md','/run/momoflow-launch','/run/momoflow-resume','/run/momoflow-admission'];
 need(e.mounts.length===destinations.length && destinations.every(d=>e.mounts.filter(m=>m.destination===d).length===1),'Exact credential-free fixture mounts required');
 for(const m of e.mounts) {
  need(!m.source.includes('docker.sock') && m.rw===['/data','/home/momo/.codex'].includes(m.destination),'Unexpected fixture write authority');
  if(m.rw) need(m.type==='volume' && m.source===(m.destination==='/data'?c.dataVolume:c.codexVolume),'Fresh fixture volume required');
  else need(m.type==='bind','Read-only fixture bind required');
 }
 for(const [dest,path] of [['/run/momoflow-admission',c.gateRoot],['/run/momoflow-launch',c.launchRoot],['/run/momoflow-resume',c.inboxRoot]]) need(e.mounts.find(m=>m.destination===dest).source===path,'Fixture control source mismatch');
 need(same(c.manifest,{status:'absent'}) && /^[a-f0-9]{64}$/.test(e.environmentHash),'Absent launch and pinned environment required');
 need(same(e.ports,{'4000/tcp':[{HostIp:'127.0.0.1',HostPort:new URL(c.engineURL).port}]}),'Fixture loopback port mismatch');
}
export const fixtureEmptyState=`const fs=require('fs');
for(const p of ['/home/momo/.codex','/run/momoflow-launch','/run/momoflow-resume']) {
 if(!fs.lstatSync(p).isDirectory() || fs.readdirSync(p).length) throw Error('Fixture authentication/dispatch state must be empty');
}
if(fs.existsSync('/data/log/roles') && fs.readdirSync('/data/log/roles').length) throw Error('Fixture role state must be empty');`;

// Inspect the backing paths, not just volume names: two local volume names can alias
// a bind or plugin source. Reject drivers/options rather than guessing their semantics.
export async function inspectIsolation(c,production,test,docker,{fixture=false}={}) {
 isolatedResources(c,production,test,{fixture});
 const expand=async xs=>Promise.all(xs.flatMap(x=>x.Mounts).map(async m=>{
  let path=m.Source;
  if(m.Type==='volume') {
   const v=JSON.parse(await docker(['volume','inspect',m.Name]))[0];
   need(v.Driver==='local' && !Object.keys(v.Options || {}).length && typeof v.Mountpoint==='string','Unverifiable volume alias/driver');path=v.Mountpoint;
  } else need(m.Type==='bind','Unsupported isolation mount');
  if(m.Type==='bind') need(resolve(path)===path && await realpath(path)===path,'Noncanonical isolation bind');
  return path;
 }));
 const prod=await expand(production),candidate=await expand(test);
 const overlap=(a,b)=>a===b || a.startsWith(b+'/') || b.startsWith(a+'/');
 for(const path of candidate) need(!prod.some(p=>overlap(p,path)),'Integration aliases production mount/credential source');
 if(fixture) for(const path of [c.stateRoot,c.deploymentRoot,c.gateRoot,c.launchRoot,c.inboxRoot,c.ledgerRoot]) {
  need(typeof path==='string' && resolve(path)===path && !prod.some(p=>overlap(p,path)),'Fixture control path overlaps production');
 }
}
