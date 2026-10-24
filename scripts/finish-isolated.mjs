// External operator only. Credential-free local provenance, never a normal deployment receipt.
import { readFile, lstat, realpath, readdir, open } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { json, atomic, digest, keyFor } from './post-pr.mjs';
import { connectedFixtureCompletion, runtimeOwnersIdle } from './deploy.mjs';
import { finish, completionPorts } from './finish.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
export async function isolatedCompletion(planFile,{fixtureAuthorization=async()=>{},isolatedStop=false}={}) {
 const bytes=await readFile(planFile),plan=JSON.parse(bytes);
 const st=await lstat(planFile);need(st.isFile() && !st.isSymbolicLink() && !(st.mode&0o022) && await realpath(planFile)===planFile && !planFile.startsWith('/data/workspaces/'),'Private canonical host plan required');
 need(same(Object.keys(plan).sort(),['authority','kind','launch','request']) && plan.kind==='isolated-completion-v1' && same(plan.authority,{finish:true,retire:true}),'Explicit isolated-only finish/retire authority required');
 const requestFile=resolve(plan.request),request=await json(requestFile);
 need(request.repo==='smoke/fixture' && request.fixtureMode==='credential-free-v1' && request.integration && request.tokenFile===undefined && same(request.manifest,{status:'absent'}),'Existing isolated credential-free request required');
 need(plan.launch?.id===digest({deploymentId:request.deploymentId,kind:plan.kind}) && plan.launch.issue===request.issue,'Fixture launch must be bound to this exact deployment');
 const c={...request,launch:plan.launch,configContents:plan};
 const dir=join(c.stateRoot,keyFor(c)),journalFile=join(dir,'isolated-completion.json');
 return connectedFixtureCompletion(request,requestFile,{status:'present',value:plan.launch},async ports=>{
  const authorize=async()=>{await fixtureAuthorization();need(same(await readFile(planFile),bytes),'Isolated completion plan changed');await ports.authorize();await ports.isolation();};
  await authorize();
  const saved=await (async()=>{try{return await json(journalFile);}catch(e){if(e.code==='ENOENT')return null;throw e;}})();
  if(!saved) {
   // Synthetic single scope only, no execution/ledger/model. Verify absence/idle/isolation BEFORE creation.
   await ports.files(request.previous);await ports.match(request.previous);
   const o=await ports.observeOwners(),s=await ports.state();
   need(o.rows.length===0 && o.manifest===null && runtimeOwnersIdle(s) && same(s.momoflow_launch?.manifest,{status:'absent'}) && await ports.ownersIdle(),'Fixture must be empty, absent and idle');
   need((await readdir(c.launchRoot)).length===0,'Fixture launch root must be empty');
   const f=await open(join(c.launchRoot,'active.json'),'wx',0o644);
   try{await f.writeFile(JSON.stringify(plan.launch));await f.sync();}finally{await f.close();}
   const d=await open(c.launchRoot,'r');try{await d.sync();}finally{await d.close();}
   // Real engine acknowledgement is polled through the existing verify/preflight path.
  }
  const io=completionPorts(c,request,ports,{journalFile,authorize,report:async()=>{}});
  // Engine file observation can lag; do not model-dispatch or synthesize state.
  const end=Date.now()+request.verifyMs;
  while(true) {
   const m=(await ports.state()).momoflow_launch?.manifest;
   if(same(m,saved?.phase==='complete'?{status:'absent'}:{status:'present',value:plan.launch}))break;
   need(Date.now()<end,'Fixture manifest acknowledgement timeout');await ports.sleep();
  }
  const result=await finish(c,io);
  need(result.phase==='complete','Isolated completion did not finish');
  const report={kind:plan.kind,phase:result.phase,source:request.fixtureSource,deploymentId:request.deploymentId,previous:request.previous.commit,target:request.target.commit,image:request.target.image,journal:journalFile,archive:result.archive,auth:'not-exercised',model:'not-exercised',githubGate:'not-exercised',effects:'isolated Docker deployment and exact synthetic manifest retirement'};
  await atomic(join(dir,'isolated-completion-result.json'),report);return report;
 },{fixtureAuthorization,isolatedStop});
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 try {need(process.argv.length===3,'Usage: node scripts/finish-isolated.mjs /operator/isolated-plan.json');writeSync(1,JSON.stringify(await isolatedCompletion(resolve(process.argv[2])))+'\n');}
 catch {writeSync(2,'Isolated completion failed; preserve plan, journal, manifest and resources for operator inspection. No production success claimed.\n');process.exitCode=1;}
}
