// External operator only. Real Docker effects, never part of the mock host suite.
import { resolve } from 'node:path';
import { json } from './post-pr.mjs';
import { connected } from './deploy.mjs';
// Plan is operator-owned: three distinct explicit requests for one isolated installation.
// Request 2 previous must be request 1 target; request 3 previous must be request 2 target.
try {
const plan=await json(resolve(process.argv[2]));
if(!Array.isArray(plan.requests) || plan.requests.length!==3) throw Error('Three explicit request files required');
const requests=await Promise.all(plan.requests.map(p=>json(resolve(p))));
for(let i=0;i<3;i++) {
 const c=requests[i];
 if(!c.integration || !/^momoflow-deploy-test-/.test(c.project) || (i && (c.project!==requests[0].project || c.previous.image!==requests[i-1].target.image || c.previous.composeHash!==requests[i-1].target.composeHash))) throw Error('Isolated consecutive bundle chain required');
 const result=await connected(c,resolve(plan.requests[i]),false,{isolatedStop:i===2});
 if(result.phase!==(i===2?'rolled_back':'complete')) throw Error('Integration did not reach expected phase; inspect durable journal, leave admission held');
 console.log(JSON.stringify({deployment:c.deploymentId,phase:result.phase,kind:'real-Docker',fault:i===2?'stop-isolated-candidate':'none'}));
}

} catch { console.error("Integration failed; inspect private operator records. No success evidence claimed."); process.exitCode=1; }
