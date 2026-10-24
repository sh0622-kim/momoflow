// Reusable read-only evidence preparation. Writes only a selected NEW private package.
import {readFile,mkdir,lstat,realpath,open} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual as same} from 'node:util';
import {digest,github,verifyInstall} from './post-pr.mjs';
import {command} from './post-pr-docker.mjs';
import {reconciliationConfig,reconciliationBinding} from './reconcile-external.mjs';
import {budgetEvidenceNames,budgetBytes,budgetProfile,budgetChecks,budgetSourceChecks,validateBudgetCompletion,budgetRemoteChecks} from './reconcile-budget.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
const generated=['recovery','validation','previousBundle'];
const originals=['ledger','enrollment','manifest','launchJournal','controllerJournal','gate'];
async function absent(ref) {
 need(ref.hash===null,'Absent host reference required');
 try{await lstat(ref.path);throw Error('Expected absent original host exists');}catch(e){if(e.code!=='ENOENT')throw e;}
 return null;
}
async function saveNew(path,value,mode) {
 const f=await open(path,'wx',mode);try{await f.writeFile(value);await f.sync();}finally{await f.close();}
}
export async function prepareReconciliation(inputFile,out,{api,installed}={}) {
 inputFile=resolve(inputFile);out=resolve(out);
 need(await realpath(inputFile)===inputFile,'Canonical typed input required');
 const inputBytes=await readFile(inputFile);await budgetBytes({path:inputFile,hash:digest(inputBytes)});
 need(await realpath(dirname(out))===dirname(out),'Canonical output parent required');
 const input=JSON.parse(inputBytes),c={...input.config};
 const logNames=['owner','recovery'].flatMap(p=>budgetChecks.map(n=>`${p}Log_${n}`));
 need(input.kind==='normal-exhaustion-preparation-v4'&&budgetProfile(c)&&same(Object.keys(input.sources).sort(),budgetEvidenceNames.filter(n=>!generated.includes(n)&&(!input.logs||!logNames.includes(n))).sort()),'Exact typed normal-exhaustion source set required');
 need(!inputFile.startsWith(out+'/')&&![c.stateRoot,c.ledgerRoot,c.launchRoot,c.gateRoot,c.inboxRoot,c.trustedRoot].some(p=>out===p||out.startsWith(p+'/')||p.startsWith(out+'/')),'New preparation output must be separate from operational/trusted roots');
 const data={},evidence={};
 for(const [name,source] of Object.entries(input.sources)) {
  let ref=source;
  if(typeof source==='string'){
   need(name!=='controllerJournal'&&resolve(source)===source,'Absolute source path or explicit absent-host reference required');
   ref={path:source,hash:digest(await readFile(source))};
  }
  evidence[name]=ref;data[name]=name==='controllerJournal'?await absent(ref):await budgetBytes(ref);
 }
 if(input.logs) {
  need(same(Object.keys(input.logs).sort(),['owner','recovery']),'Two explicit validation log directories required');
  for(const prefix of ['owner','recovery']) {
   const result=JSON.parse(data[prefix==='owner'?'tests':'recoveryTests']),dir=input.logs[prefix];
   need(typeof dir==='string'&&resolve(dir)===dir,'Absolute validation log directory required');
   for(const name of budgetChecks){const rows=result.checks?.filter(x=>x.name===name);need(rows?.length===1&&/^[a-f0-9]{64}$/.test(rows[0].log),'Complete fixed validation logs required');const ref={path:join(dir,rows[0].log),hash:rows[0].log};evidence[`${prefix}Log_${name}`]=ref;data[`${prefix}Log_${name}`]=await budgetBytes(ref);}
  }
 }
 const ownershipRequest=JSON.parse(data.ownershipRequest),bundle=ownershipRequest.current;
 c.runnerSource=bundle.runnerSource;
 const previous={kind:'pinned-previous-bundle-v4',commit:bundle.commit,files:{}};
 for(const [path,hash] of Object.entries(bundle.files))previous.files[path]=(await budgetBytes({path,hash})).toString('base64');
 const observe=installed||(async()=>{
  await verifyInstall(c);
  const r=await command('git',['-C',c.trustedRoot,'rev-parse','HEAD','HEAD^{tree}']);need(r.exit===0,'Installed controller observation failed');
  const [commit,tree]=r.output.toString().trim().split('\n');return {commit,tree,runnerSource:digest(await readFile(join(c.trustedRoot,'engine/role_runner.ex')))};
 });
 const seen=await observe();
 need(seen.commit===c.installation.merge&&seen.tree===c.installation.tree,'Installed recovery tuple must be independently observed');
 const prepared={kind:'controller-budget-exhausted-package-v4',repo:c.repo,owner:{issue:c.issue,pr:c.pr,head:c.head,tree:c.tree,merge:c.merge},installation:c.installation,
  originalHashes:Object.fromEntries(originals.map(n=>[n,evidence[n].hash])),turns:input.turns,validationOrigins:input.validationOrigins,remainingObservation:'natural-observation-pending',input:{path:inputFile,hash:digest(inputBytes)}};
 const observation={kind:'observed-controller-install-v4',...seen,ownershipHash:evidence.ownership.hash};
 for(const [name,value] of Object.entries({recovery:prepared,validation:observation,previousBundle:previous})){
  data[name]=Buffer.from(JSON.stringify(value,null,2)+'\n');evidence[name]={path:join(out,name+'.json'),hash:digest(data[name])};
 }
 c.evidence=evidence;reconciliationConfig(c);
 validateBudgetCompletion(reconciliationBinding(c),JSON.parse(data.ledger),data);
 // The original producer request is never embellished with a PR number. Remote
 // PR identity and build file hashes are independently checked here and by apply.
 const remote=api||github(c);
 await budgetRemoteChecks(c,data,remote);
 const old=await remote('GET',`/repos/${c.repo}/contents/engine/role_runner.ex?ref=${bundle.commit}`);
 need(old.encoding==='base64'&&digest(Buffer.from(old.content,'base64'))===c.runnerSource,'Previous commit/source bytes mismatch');
 for(const [t,name] of [[c,'correction'],[c.installation,'recoveryBuild']]) {
  const build=JSON.parse(data[name]);need(build.files&&Object.keys(build.files).length>0,'Actual build file hashes required');
  for(const [path,hash] of Object.entries(build.files)) {
   need(!path.startsWith('/')&&!path.split('/').some(s=>!s||s==='.'||s==='..'||s==='.git')&&/^[a-f0-9]{64}$/.test(hash),'Safe exact build file reference required');
   const blob=await remote('GET',`/repos/${c.repo}/contents/${path}?ref=${t.head}`);
   need(blob.encoding==='base64'&&digest(Buffer.from(blob.content,'base64'))===hash,'Completed build files differ from exact reviewed head');
  }
 }
 const bytes=Buffer.from(JSON.stringify(c,null,2)+'\n'),request=join(out,'request.json');
 let exists=false;try{await lstat(out);exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
 if(exists) {
  need(await realpath(out)===out&&(await lstat(out)).isDirectory(),'Canonical prepared package required');
  need(same(await readFile(request),bytes),'Existing package is a different request; never reset identity');
  for(const name of generated)need(same(await readFile(evidence[name].path),data[name]),'Existing generated evidence changed');
 } else {
  // All source and scope validation precedes the first write. Exclusive new files
  // preserve partial preparation on I/O failure; an incomplete package is never reused.
  await mkdir(out,{mode:0o700});
  for(const name of generated)await saveNew(evidence[name].path,data[name],0o400);
  await saveNew(request,bytes,0o600);
  const directory=await open(out,'r');try{await directory.sync();}finally{await directory.close();}
 }
 await budgetSourceChecks(c);
 return {prepared:true,request,id:digest(reconciliationBinding({...c,configurationHash:digest(bytes)})),effects:'new-private-package-only'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
 try {
  const [input,out,...extra]=process.argv.slice(2);need(input&&out&&!extra.length,'Usage: typed-input.json NEW-private-output-directory');
  console.log(JSON.stringify(await prepareReconciliation(input,out)));
 }catch(e){console.error(e.message);process.exitCode=1;}
}
