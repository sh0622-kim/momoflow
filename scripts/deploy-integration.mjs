// External operator only. Real Docker effects, never part of the mock host suite.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { json } from './post-pr.mjs';
import { connected, connectedFixture, deploymentConfig, bundleFiles } from './deploy.mjs';
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
  deploymentConfig(c);
  if((plan.kind==='fixture')!==Boolean(c.fixtureSource && c.fixtureRepository)) throw Error('Mixed fixture/ordinary plan');
 }
 // Validate every request, including both evidence directions, BEFORE the first pause.
 // The live previous bundle is necessarily A here; the normal connected preflight for
 // request 2 is performed after request 1. Its evidence is checked separately below.
 await run(requests[0],resolve(plan.requests[0]),true);
 // Per-request effect-free evidence checks ensure an invalid later receipt cannot leave
 // an otherwise valid first deployment executed. See validateIntegrationEvidence().
 await validateIntegrationEvidence(requests,plan.kind);
 for(let i=0;i<3;i++) {
  const c=requests[i], result=await run(c,resolve(plan.requests[i]),false,{isolatedStop:i===2});
  if(result.phase!==(i===2?'rolled_back':'complete')) throw Error('Unexpected phase; inspect private journal, leave admission held');
  console.log(JSON.stringify({deployment:c.deploymentId,phase:result.phase,kind:'real-Docker',evidence:plan.kind,githubGate:plan.kind==='fixture'?'not-exercised':'passed',model:'not-exercised',fault:i===2?'stop-isolated-candidate':'none'}));
 }
}
import { deploymentEvidence } from './deploy.mjs';
import { fixtureEvidence } from './deploy-fixture.mjs';
import { github } from './post-pr.mjs';
import { command } from './post-pr-docker.mjs';
import { readFile, lstat, realpath } from 'node:fs/promises';
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
  await bundleFiles(c,c.previous,docker);await bundleFiles(c,c.target,docker);
  if(kind==='fixture') await fixtureEvidence(c,e,docker);
  else await deploymentEvidence(c,e,github(c),h=>readFile(join(dirname(c.evidence.path),'logs',h)));
 }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 try {await integration(await json(resolve(process.argv[2])));}
 catch {console.error('Integration failed; inspect private operator records. No success evidence claimed.');process.exitCode=1;}
}
