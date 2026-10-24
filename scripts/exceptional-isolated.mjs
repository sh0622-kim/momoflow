// External operator's credential-free Docker fixture ONLY; no production evidence/approval.
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeSync } from 'node:fs';
import { isDeepStrictEqual as same } from 'node:util';
import { json, atomic, digest } from './post-pr.mjs';
import { privatePath, immutable } from './finish.mjs';
import { isolatedCompletion } from './finish-isolated.mjs';
import { exceptionalScope, pinOriginals, verifyOriginals, recordResponse, requireApproval } from './exceptional.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
export async function isolatedExceptional(action,file,responseFile) {
 await privatePath(file);
 if(action==='prepare') {
  const plan=await json(file);
  need(same(Object.keys(plan).sort(),['completionPlan','fault','kind']) && plan.kind==='isolated-exceptional-v1' && ['none','stop-isolated-candidate'].includes(plan.fault) && resolve(plan.completionPlan)===plan.completionPlan,'Fixed isolated exceptional plan required');
  await privatePath(plan.completionPlan);const completion=await json(plan.completionPlan);await privatePath(completion.request);const request=await json(completion.request);
  need(completion.kind==='isolated-completion-v1' && request.repo==='smoke/fixture' && request.fixtureMode==='credential-free-v1' && request.tokenFile===undefined && request.integration && same(request.manifest,{status:'absent'}),'Fresh credential-free isolated completion required');
  const originals=await pinOriginals([file,plan.completionPlan,completion.request]);
  const id=digest({kind:plan.kind,originals}),root=join(dirname(file),'exceptional-fixture-'+id);await mkdir(root,{mode:0o700,recursive:true});await privatePath(root,true);
  const excluded=join(root,'synthetic-excluded.json');await immutable(excluded,Buffer.from(JSON.stringify({kind:'isolated-synthetic-exclusion',deploymentId:request.deploymentId,evidence:'not GitHub/role evidence'})));
  const p={v:1,kind:plan.kind,id,scope:exceptionalScope,request:{repo:request.repo,issue:request.issue},completionPlan:plan.completionPlan,fault:plan.fault,originals:[...originals,...await pinOriginals([excluded])],auth:'not-exercised',githubGate:'not-exercised',humanApproval:'not-exercised'};
  const preparedFile=join(root,'prepared.json');await immutable(preparedFile,Buffer.from(JSON.stringify(p,null,2)));return {preparedFile,digest:digest(p),prepared:p};
 }
 const p=await json(file),root=dirname(file);
 need(p.kind==='isolated-exceptional-v1' && p.request.repo==='smoke/fixture' && same(p.scope,exceptionalScope) && file===join(root,'prepared.json'),'Isolated exceptional preparation required');
 await verifyOriginals(p.originals);
 const originalPlan=await json(p.originals[0].path);
 need(p.id===digest({kind:p.kind,originals:p.originals.slice(0,-1)}) && p.completionPlan===originalPlan.completionPlan && p.fault===originalPlan.fault && ['none','stop-isolated-candidate'].includes(p.fault),'Isolated preparation identity/fixed fault changed');
 if(action==='respond') {await privatePath(responseFile);return recordResponse(p,root,await json(responseFile));}
 need(action==='execute','Unknown isolated exceptional action');
 const prior=await (async()=>{try{return await json(join(root,'result.json'));}catch(e){if(e.code==='ENOENT')return null;throw e;}})();
 // Fixture success duplicate uses the original immutable synthetic approval receipt;
 // normal active forward effects always require a current approval.
 const authorize=async()=>{
  await verifyOriginals(p.originals);need(digest(await json(file))===digest(p),'Fixture preparation changed');
  if(prior?.phase==='complete') {
   const a=await json(join(root,`response-${prior.approval}.json`));need(digest(a)===prior.approval && a.result==='approved','Original fixture approval receipt changed');
  } else await requireApproval(p,root);
 };
 await authorize();
 const approval=prior?.approval || digest(await requireApproval(p,root));
 const result=await isolatedCompletion(p.completionPlan,{fixtureAuthorization:authorize,isolatedStop:p.fault==='stop-isolated-candidate'});
 await verifyOriginals(p.originals);
 const report={...result,exceptionalPrepared:digest(p),approval,humanApproval:'not-exercised',originalPreservation:'passed'};
 await atomic(join(root,'result.json'),report);return report;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 try {
  const [action,file,response,...extra]=process.argv.slice(2);
  need(!extra.length && ['prepare','respond','execute'].includes(action) && file && (action==='respond'?!!response:!response),'Usage: exceptional-isolated.mjs prepare PLAN | respond PREPARED RESPONSE | execute PREPARED');
  writeSync(1,JSON.stringify(await isolatedExceptional(action,resolve(file),response?resolve(response):undefined))+'\n');
 }catch{writeSync(2,'Isolated exceptional operation failed; preserve original/approval/deployment/completion records. No production or human-approval observation claimed.\n');process.exitCode=1;}
}
