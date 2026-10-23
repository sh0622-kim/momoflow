// External operator only. Real Docker effects, never part of the mock host suite.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { json, digest } from './post-pr.mjs';
import { connected, connectedFixture, deploymentConfig, bundleFiles, runtimeIdentity } from './deploy.mjs';
import { integrationPlan } from './deploy-fixture.mjs';
export async function integration(plan) {
 if(!Array.isArray(plan.requests) || plan.requests.length!==3 || !['github','fixture'].includes(plan.kind)) throw Error('Explicit kind and three requests required');
 for(const p of plan.requests) {
  const path=resolve(p),st=await lstat(path);
  if(!st.isFile() || st.isSymbolicLink() || (st.mode&0o022) || await realpath(path)!==path) throw Error('Private canonical requests required');
 }
 const requests=integrationPlan(await Promise.all(plan.requests.map(p=>json(resolve(p)))));
 const run=plan.kind==='fixture'?connectedFixture:connected;
 for(const c of requests) {
  deploymentConfig(c,{fixture:plan.kind==='fixture'});
  if((plan.kind==='fixture')!==Boolean(c.fixtureSource && c.fixtureRepository)) throw Error('Mixed fixture/ordinary plan');
 }
 // Validate every request, including both evidence directions, BEFORE the first pause.
 // The live previous bundle is necessarily A here; the normal connected preflight for
 // request 2 is performed after request 1. Its evidence is checked separately below.
 await run(requests[0],resolve(plan.requests[0]),true);
 // Per-request effect-free evidence checks ensure an invalid later receipt cannot leave
 // an otherwise valid first deployment executed. See validateIntegrationEvidence().
 await validateIntegrationEvidence(requests,plan.kind);
 const before=plan.kind==='fixture'?await productionSnapshot(requests[0]):null;
 if(before) await writeFile(join(requests[0].deploymentRoot,'integration-before.json'),JSON.stringify(before,null,2)+'\n',{mode:0o600,flag:'wx'});
 for(let i=0;i<3;i++) {
  const c=requests[i], result=await run(c,resolve(plan.requests[i]),false,{isolatedStop:i===2});
  if(result.phase!==(i===2?'rolled_back':'complete')) throw Error('Unexpected phase; inspect private journal, leave admission held');
  console.log(JSON.stringify({deployment:c.deploymentId,phase:result.phase,kind:'real-Docker',evidence:plan.kind,auth:plan.kind==='fixture'?'not-exercised':'passed',githubGate:plan.kind==='fixture'?'not-exercised':'passed',model:'not-exercised',fault:i===2?'stop-isolated-candidate':'none'}));
 }
 if(before) {
  const after=await productionSnapshot(requests[0]);
  await writeFile(join(requests[0].deploymentRoot,'integration-after.json'),JSON.stringify(after,null,2)+'\n',{mode:0o600,flag:'wx'});
  if(digest(before)!==digest(after)) throw Error('Production identity/role ledger changed; inspect snapshots, no automatic cleanup or success declaration');
 }
}
// The snapshot is hashes only: no ledger body or authentication data leaves production.
export function readProductionRoles(fs,crypto,root='/data/log/roles') {
 try {if(!fs.lstatSync(root).isDirectory()) throw Error('Invalid roles root');}
 catch(e) {if(e.code==='ENOENT') return [];throw e;}
 return fs.readdirSync(root).filter(n=>n.endsWith('.json')).sort().map(n=>{
  if(!/^[a-f0-9]{64}\.json$/.test(n) || !fs.lstatSync(root+'/'+n).isFile()) throw Error('Invalid ledger file');
  return {file:n,hash:crypto.createHash('sha256').update(fs.readFileSync(root+'/'+n)).digest('hex')};
 });
}
// Minimal read-only host observation. Never read keys, token or Codex auth files.
async function productionSnapshot(c) {
 const docker=async args=>{
  const r=await command('docker',args,{timeout:c.verifyMs,dockerConfig:c.dockerConfig});
  if(r.exit!==0) throw Error('Production read-only observation failed');return r.output.toString();
 };
 const services=[];
 for(const name of [c.integration.productionEngine,c.integration.productionAuth]) {
  const x=JSON.parse(await docker(['inspect',name]))[0];
  if(!x.State.Running || x.State.Health?.Status!=='healthy') throw Error('Production service not healthy');
  services.push({id:x.Id,runtime:runtimeIdentity(x)});
 }
 const roles=JSON.parse(await docker(['exec',services[0].id,'node','-e',`process.stdout.write(JSON.stringify((${readProductionRoles.toString()})(require('fs'),require('crypto'))));`]));
 return {services,roles};
}
import { deploymentEvidence } from './deploy.mjs';
import { fixtureEvidence } from './deploy-fixture.mjs';
import { github } from './post-pr.mjs';
import { command } from './post-pr-docker.mjs';
import { readFile, lstat, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
async function validateIntegrationEvidence(requests,kind) {
 for(const c of requests) {
  const st=await lstat(c.evidence.path);
  if(!st.isFile() || st.isSymbolicLink() || (st.mode&0o022) || await realpath(c.evidence.path)!==c.evidence.path) throw Error('Private canonical evidence required');
  const e=await json(c.evidence.path);
  const docker=async args=>{
   const r=await command('docker',args,{timeout:c.verifyMs,dockerConfig:c.dockerConfig});
   if(r.exit!==0) throw Error('Integration bundle inspection failed');return r.output.toString();
  };
  await bundleFiles(c,c.previous,docker,{fixture:kind==='fixture'});await bundleFiles(c,c.target,docker,{fixture:kind==='fixture'});
  if(kind==='fixture') await fixtureEvidence(c,e,docker);
  else await deploymentEvidence(c,e,github(c),h=>readFile(join(dirname(c.evidence.path),'logs',h)));
 }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 try {await integration(await json(resolve(process.argv[2])));}
 catch {console.error('Integration failed; inspect private operator records. No success evidence claimed.');process.exitCode=1;}
}
