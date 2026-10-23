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
 return {kind:e.kind,source:e.source,githubGate:'not-exercised',model:'not-exercised',auth:'real-required'};
}
// Validate ALL requests before the first external effect. Exact bundle equality includes
// files, source, expected runtime and commit; image/config equality alone is insufficient.
export function integrationPlan(requests) {
 need(Array.isArray(requests) && requests.length===3,'Three explicit requests required');
 const first=requests[0];
 need(new Set(requests.map(c=>c.deploymentId)).size===3,'Distinct deployment IDs required');
 const stable=['repo','base','project','dataVolume','engineURL','stateRoot','deploymentRoot','gateRoot','trustedRoot','inboxRoot','ledgerRoot','tokenFile','manifest','integration','fixtureSource','fixtureRepository','controllerVersion','validationOrigin','requiredChecks','requiredReviewers','authority','hold','compatibility','exceptional','operatorContainer','dockerConfig','drainMs','verifyMs'];
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
export function isolatedResources(c,production,test) {
 need(c.integration?.productionProject!==c.project && production.length===2 && test.length===2,'Both production/test services required');
 const sources=production.flatMap(x=>x.Mounts.map(m=>({type:m.Type,source:m.Type==='volume'?m.Name:m.Source})));
 const overlap=(a,b)=>a===b || a.startsWith(b+'/') || b.startsWith(a+'/');
 for(const x of test) for(const m of x.Mounts) need(!sources.some(s=>s.type===m.Type && (m.Type==='volume'?s.source===m.Name:overlap(s.source,m.Source))),'Integration shares production mount/credential source');
 const ports=new Set(production.flatMap(x=>Object.values(x.HostConfig.PortBindings || {}).flat().map(p=>p.HostPort)));
 need(test.every(x=>!Object.values(x.HostConfig.PortBindings || {}).flat().some(p=>ports.has(p.HostPort))),'Integration shares production port');
}
