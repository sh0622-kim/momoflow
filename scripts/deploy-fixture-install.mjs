// External host only. Prepare ONE fresh, credential-free installation and three requests.
// Existing images/logs are revalidated; no build, login, App creation or production writes.
import { fixtureMountSources } from './deploy-mount-identity.mjs';
import { mkdir, writeFile, readFile, realpath, lstat, rename } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { randomBytes } from 'node:crypto';
import { command } from './post-pr-docker.mjs';
import { digest, json, verifyInstall } from './post-pr.mjs';
import { fixtureEvidence, fixtureEnvironmentValues, fixtureEmptyState, inspectIsolation, fixtureMode } from './deploy-fixture.mjs';
import { runtimeIdentity, bundleFiles, composeIdentity, profileIdentity, deploymentConfig, connectedFixture, activeContract, drained, fixtureHTTP } from './deploy.mjs';
const need=(v,m)=>{if(!v) throw Object.assign(Error(m),{safeReason:m});};
const id=()=>randomBytes(32).toString('hex');
const trustedRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const privatePath=async p=>{const s=await lstat(p);need(!s.isSymbolicLink() && !(s.mode&0o022) && await realpath(p)===p,'Private canonical operator path required');};
const put=(p,x)=>writeFile(p,typeof x==='string' || Buffer.isBuffer(x)?x:JSON.stringify(x,null,2)+'\n',{mode:0o600,flag:'wx'});
export function fixtureBundle(c,row,image,workflow,seccomp,composeFile,profileBytes) {
 const bind=(source,target)=>({type:'bind',source,target,read_only:true,bind:{}});
 const mounts=[{type:'volume',source:'data',target:'/data',volume:{nocopy:true}},{type:'volume',source:'codex',target:'/home/momo/.codex',volume:{nocopy:true}},bind(workflow,'/config/WORKFLOW.md'),bind(c.launchRoot,'/run/momoflow-launch'),bind(c.inboxRoot,'/run/momoflow-resume'),bind(c.gateRoot,'/run/momoflow-admission')];
 const service={image:row.image,init:true,restart:'unless-stopped',environment:fixtureEnvironmentValues,networks:{default:null},volumes:mounts,cap_drop:['ALL'],security_opt:['no-new-privileges','seccomp='+seccomp],ports:[{target:4000,published:new URL(c.engineURL).port,host_ip:'127.0.0.1',protocol:'tcp',mode:'ingress'}],healthcheck:{test:['CMD','node','-e',"fetch('http://127.0.0.1:4000/api/v1/state').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"],interval:'5s',timeout:'5s',retries:20}};
 const doc={name:c.project,services:{symphony:service},networks:{default:{name:c.project+'_default',internal:true}},volumes:{data:{name:c.dataVolume,external:true},codex:{name:c.codexVolume,external:true}}};
 // Use the same Docker identity normalization as post-start verification, including
 // immutable image defaults. The independent Compose validator checks the result.
 const env=Object.fromEntries((image.Config.Env || []).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];}));Object.assign(env,fixtureEnvironmentValues);
 const inspect=runtimeIdentity({Image:row.image,Config:{...image.Config,Env:Object.entries(env).map(([k,v])=>k+'='+v)},Mounts:mounts.map(m=>({Type:m.type,Name:m.source==='data'?c.dataVolume:c.codexVolume,Source:m.source,Destination:m.target,RW:!m.read_only})),HostConfig:{Privileged:false,CapAdd:null,CapDrop:['ALL'],SecurityOpt:['no-new-privileges','seccomp='+profileBytes.toString()],NetworkMode:c.project+'_default',ReadonlyRootfs:false,PortBindings:{'4000/tcp':[{HostIp:'127.0.0.1',HostPort:new URL(c.engineURL).port}]}}},{fixture:true});
 return {doc,bundle:{commit:row.commit,image:row.image,runnerSource:row.runnerSource,composeFile,inspect:{symphony:inspect}}};
}
// Persist command intent before effects. Never save argv or raw output: even a
// read-only production inspect can contain credentials. The root is never reused.
export async function installationAttempt(root,action) {
 let journalPath=null;
 const row={status:'preparing',stage:'host-preflight',commands:[]};
 // Concurrent read-only probes share one journal. Serialize its atomic writes;
 // a failed save keeps the chain rejected so no later command can pass intent logging.
 let saving=Promise.resolve();
 const save=()=>{saving=saving.then(async()=>{if(journalPath) {const temp=journalPath+'.next';await writeFile(temp,JSON.stringify(row,null,2)+'\n',{mode:0o600});await rename(temp,journalPath);}});return saving;};
 const d={
  stage:async name=>{row.stage=name;await save();},
  createRoot:async metadata=>{await mkdir(root,{mode:0o700});journalPath=join(root,'installation.json');Object.assign(row,metadata);await save();},
  command:async(file,args,options)=>{
   const entry={stage:row.stage,status:'attempted'};row.commands.push(entry);await save();
   let r;try {r=await command(file,args,options);} catch {entry.status='spawn-failed';await save();throw Object.assign(Error('Command could not start'),{safeReason:'Command could not start'});}
   Object.assign(entry,{status:r.exit===0?'completed':'failed',exit:r.exit,outputHash:digest(r.output),outputBytes:r.output.length});await save();
   need(r.exit===0,'External command failed');return r;
  }
 };
 try {const result=await action(d);row.status=result?.status==='preflight-passed'?'preflight-passed':'installed-paused';await save();return result;}
 catch(e) {
  row.status='failed';row.reason=e.safeReason || 'Validation or filesystem check failed';
  let journalSaved=false;try {await save();journalSaved=!!journalPath;} catch { /* Keep the last atomic journal. */ }
  const last=row.commands.at(-1);
  const diagnostic={stage:row.stage,reason:row.reason,journal:journalSaved?journalPath:null,exit:last?.status==='failed'?last.exit:null};
  throw Object.assign(Error(`Fixture installation failed: ${diagnostic.stage}: ${diagnostic.reason}; exit=${diagnostic.exit ?? 'n/a'}; journal=${diagnostic.journal ?? 'not created or unavailable'}. Preserve partial resources; do not rerun automatically.`),{diagnostic});
 }
}
export async function pinFixtureBundle(c,b,doc,image,profileBytes,docker) {try {
 const profiles=Object.fromEntries(doc.services.symphony.security_opt.filter(x=>x.startsWith('seccomp=')).map(x=>[x.slice(8),profileIdentity(profileBytes.toString())]));
 // Validate the fixed surface before rendering, then validate and pin the actual
 // Compose serialization, including omitted defaults.
 composeIdentity(c,b,doc,{symphony:image},profiles,{fixture:true});
 await put(b.composeFile,doc);
 const rendered=JSON.parse(await docker(['compose','--project-name',c.project,'-f',b.composeFile,'config','--format','json']));
 composeIdentity(c,b,rendered,{symphony:image},profiles,{fixture:true});
 await writeFile(b.composeFile,JSON.stringify(rendered,null,2)+'\n',{mode:0o600});
 const paths=[b.composeFile,...b.inspect.symphony.mounts.filter(m=>m.destination==='/config/WORKFLOW.md').map(m=>m.source),...Object.keys(profiles)];
 b.files=Object.fromEntries(await Promise.all(paths.map(async p=>[p,digest(await readFile(p))])));b.composeHash=b.files[b.composeFile];
 await bundleFiles(c,b,docker,{fixture:true});
} catch(e) {if(e.safeReason) throw e;throw Object.assign(Error('Fixture Compose rendering/pinning check failed'),{safeReason:'Fixture Compose rendering/pinning check failed'});}}
export async function install(o,{checkOnly=false}={}) {return installationAttempt(o.root,async diagnostic=>{
 // This tool intentionally requires a host process, never the engine's Docker session.
 try {await lstat('/.dockerenv');need(false,'Run installer on the trusted Docker host, outside containers');} catch(e) {if(e.code!=='ENOENT') throw e;}
 need(process.getuid?.()===1000,'Installer requires host UID1000; do not widen operational permissions');
 need(typeof o.root==='string' && resolve(o.root)===o.root && !/[,\n\0]/.test(o.root),'New absolute root required');
 await privatePath(dirname(o.root));await privatePath(o.evidence);await privatePath(o.repository);
 need(Number.isInteger(o.port) && o.port>1024 && o.port<65536,'Independent loopback port required');
 const run=async(file,args)=>{const r=await diagnostic.command(file,args,{dockerConfig:o.dockerConfig});return r.output.toString().trim();};
 const docker=args=>run('docker',args),inspect=async name=>JSON.parse(await docker(['inspect',name]))[0];
 const controllerVersion=await run('git',['-C',trustedRoot,'rev-parse','HEAD']);
 const e=await json(o.evidence),project='momoflow-deploy-test-'+id().slice(0,12);
 const c={repo:'smoke/fixture',issue:'18',base:'main',fixtureMode,fixtureSource:e.source,fixtureRepository:o.repository,controllerVersion,validationOrigin:controllerVersion,trustedRoot,project,dataVolume:project+'-data',codexVolume:project+'-codex',engineURL:'http://127.0.0.1:'+o.port,evidence:{path:o.evidence,hash:digest(e)},authority:{deploy:true},hold:false,compatibility:'unchanged-data',exceptional:false,manifest:{status:'absent'},integration:o.integration,drainMs:60000,verifyMs:120000,...Object.fromEntries(['stateRoot','deploymentRoot','gateRoot','launchRoot','inboxRoot','ledgerRoot'].map(k=>[k,join(o.root,k)])),...(o.dockerConfig?{dockerConfig:o.dockerConfig}:{})};
 await verifyInstall({...c,tokenFile:join(o.root,'unused-token-path')});
 need(!o.root.startsWith(trustedRoot+'/') && !o.root.startsWith('/data/workspaces/'),'External operational root required');
 await diagnostic.stage('production-and-provenance-preflight');
 const production=[await inspect(c.integration.productionEngine),await inspect(c.integration.productionAuth)];
 need(c.integration.productionProject!==project && production.every((x,i)=>x.State.Running && x.Config.Labels?.['com.docker.compose.project']===c.integration.productionProject && x.Config.Labels?.['com.docker.compose.service']===['symphony','github-auth'][i]),'Production service identity required');
 const proto={...c,fixtureMode:undefined,previous:e.versions?.[0],target:e.versions?.[1]};
 await fixtureEvidence(proto,e,docker);
 // Before creating ANY resource, compare all prospective host roots/port to production.
 await inspectIsolation(c,production,[{Mounts:[],HostConfig:{PortBindings:{'4000/tcp':[{HostPort:String(o.port)}]}}}],docker,{fixture:true,hostPaths:[o.root]});
 if(checkOnly) return {status:'preflight-passed',controllerVersion,source:e.source,images:e.versions.map(x=>x.image),provenanceHash:digest(e),rootCreated:false,auth:'not-exercised',model:'not-exercised'};
 const allVolumes=await docker(['volume','ls','--format','{{.Name}}']);
 need(![c.dataVolume,c.codexVolume].some(v=>allVolumes.split('\n').includes(v)),'Fixture volumes must be new');
 need(!(await docker(['ps','-a','--filter',`label=com.docker.compose.project=${project}`,'-q'])),'Fixture project must be new');
 // Read exact source files through Git, never copy operational credentials/config.
 const gitFile=p=>diagnostic.command('git',['-C',o.repository,'show',`${e.source}:${p}`]).then(r=>r.output);
 const workflow=await gitFile('WORKFLOW.md'),seccomp=await gitFile('security/codex-seccomp.json');
 const sandbox=await gitFile('scripts/smoke-sandbox.mjs');
 await diagnostic.stage('prepare-files');
 await diagnostic.createRoot({project,volumes:[c.dataVolume,c.codexVolume],production:production.map(runtimeIdentity),evidence:c.evidence,controllerVersion,auth:'not-exercised',model:'not-exercised',githubGate:'not-exercised',cleanup:'Preserve evidence; inspect gate/owners before exact allowlist removal. Never rerun install over this root.'});
 for(const k of ['stateRoot','deploymentRoot','gateRoot','launchRoot','inboxRoot','ledgerRoot']) await mkdir(c[k],{mode:0o755});
 const initial=id();await writeFile(join(c.gateRoot,'active.json'),JSON.stringify({v:1,generation:initial,paused:true}),{mode:0o644,flag:'wx'});
 const profile=join(o.root,'seccomp.json'),probe=join(o.root,'smoke-sandbox.mjs');
 await put(profile,seccomp);await put(probe,sandbox);
 // UID1000 in the fixture must read immutable files. The private root stays owner-only;
 // the host operator must itself be UID1000 (same as the documented deployment).
 const bundles=[];
 await diagnostic.stage('render-and-pin-bundles');
 for(const [i,row] of e.versions.entries()) {
  const wf=join(o.root,`WORKFLOW-${i}.md`),cf=join(o.root,`compose-${i}.json`);await put(wf,workflow);
  const image=await inspect(row.image),{doc,bundle}=fixtureBundle(c,row,image,wf,profile,cf,seccomp);
  await pinFixtureBundle(c,bundle,doc,image,seccomp,docker);bundles.push(bundle);
 }
 await diagnostic.stage('validate-and-write-requests');
 const requests=[0,1,0].map((n,i)=>({...c,deploymentId:id(),previous:bundles[n],target:bundles[1-n]}));
 for(const [i,r] of requests.entries()) {deploymentConfig(r,{fixture:true});await fixtureEvidence(r,e,docker);await put(join(o.root,`request-${i+1}.json`),r);}
 await put(join(o.root,'plan.json'),{kind:'fixture',requests:[1,2,3].map(i=>join(o.root,`request-${i}.json`))});
 // Refresh live production evidence at the volume-creation boundary.
 await inspectIsolation(c,await Promise.all([c.integration.productionEngine,c.integration.productionAuth].map(inspect)),[{Mounts:bundles.flatMap(b=>b.inspect.symphony.mounts.filter(m=>m.type==='bind').map(m=>({Type:m.type,Source:m.source}))),HostConfig:{PortBindings:{}}}],docker,{fixture:true,hostPaths:[o.root]});
 for(const [i,v] of [c.dataVolume,c.codexVolume].entries()) {await diagnostic.stage('create-volume-'+i);await docker(['volume','create','--driver','local','--label',`org.momoflow.fixture.project=${project}`,v]);}
 // All fresh roots are checked before writes; only CHOWN is granted to this socketless,
 // networkless helper. The tested engine retains cap_drop ALL.
 await diagnostic.stage('prepare-volume-layout');
 await docker(['run','--rm','--pull','never','--network','none','--read-only','--user','0:0','--cap-drop','ALL','--cap-add','CHOWN','--security-opt','no-new-privileges',...[[c.dataVolume,'/fixture-data'],[c.codexVolume,'/fixture-codex']].flatMap(([v,p])=>['--mount',`type=volume,src=${v},dst=${p},volume-nocopy`]),'--entrypoint','node',bundles[0].image,'-e',`const fs=require('fs');const roots=['/fixture-data','/fixture-codex'];for(const p of roots){const s=fs.lstatSync(p);if(!s.isDirectory()||s.uid!==0||s.gid!==0||fs.readdirSync(p).length)throw Error('Expected fresh empty root-owned volumes');}for(const p of ['/fixture-data/log','/fixture-data/workspaces'])fs.mkdirSync(p,{mode:0o700});for(const p of ['/fixture-data/log','/fixture-data/workspaces',...roots]){fs.chmodSync(p,0o700);fs.chownSync(p,1000,1000);}`]);
 await diagnostic.stage('start-initial-fixture');
 await docker(['compose','--project-name',project,'-f',bundles[0].composeFile,'up','-d','--no-build','--pull','never','symphony']);
 await diagnostic.stage('verify-initial-fixture');
 const end=Date.now()+c.verifyMs;let installed;
 while(true) {
  try {
   const result=await diagnostic.command('docker',['compose','--project-name',project,'-f',bundles[0].composeFile,'ps','-q','symphony'],{dockerConfig:o.dockerConfig});need(result.exit===0,'Fixture container lookup failed');
   const live=await inspect(result.output.toString().trim());need(live.State.Health?.Status==='healthy','Fixture not healthy');
   need(same(runtimeIdentity({...live,Mounts:await fixtureMountSources(live,bundles[0].inspect.symphony,docker)},{fixture:true}),bundles[0].inspect.symphony),'Installed fixture identity mismatch');
   await inspectIsolation(c,production,[live],docker,{fixture:true});
   need(JSON.parse(await docker(['network','inspect',project+'_default']))[0].Internal===true,'Fixture network must be internal');
   const scope={...c,previous:bundles[0],target:bundles[1]};
   const s=(await fixtureHTTP(scope,bundles[0],live,docker,'/api/v1/state')).state;
   await fixtureHTTP(scope,bundles[0],live,docker,'/');
   activeContract({...c,deploymentId:initial},bundles[0],s,true);need(drained(s,initial),'Initial fixture not drained');
   await docker(['exec',live.Id,'node','-e',fixtureEmptyState]);
   installed=live;
   break;
  } catch(e) {if(Date.now()>=end) throw e;await new Promise(r=>setTimeout(r,500));}
 }
 // Real sandbox on the installed exact image/security, no model/auth. Copy a reviewed
 // probe to /tmp with stdin-free docker cp; no additional persistent mount authority.
 await diagnostic.stage('installed-sandbox');
 await docker(['exec',installed.Id,'node','-e',"require('fs').mkdirSync('/tmp/momoflow-fixture-sandbox',{mode:0o700})"]);
 await docker(['cp','-a',probe,installed.Id+':/tmp/fixture-sandbox.mjs']);
 const check=await diagnostic.command('docker',['exec','-e','CODEX_HOME=/tmp/momoflow-fixture-sandbox',installed.Id,'node','/tmp/fixture-sandbox.mjs'],{dockerConfig:o.dockerConfig});
 await put(join(o.root,'sandbox.log'),check.output);need(check.exit===0,'Installed real sandbox check failed');
 await diagnostic.stage('connected-fixture-preflight');
 await connectedFixture(requests[0],join(o.root,'request-1.json'),true);
 await diagnostic.stage('production-unchanged');
 const after=await Promise.all([c.integration.productionEngine,c.integration.productionAuth].map(inspect));
 need(after.every((x,i)=>x.State.Running && x.State.Health?.Status==='healthy' && same(runtimeIdentity(x),runtimeIdentity(production[i]))),'Production identity changed during installation; inspect records');
 await diagnostic.stage('record-installed');
 await put(join(o.root,'installed.json'),{status:'installed-paused',normalDeployments:0,project,at:new Date().toISOString(),sandbox:digest(await readFile(join(o.root,'sandbox.log'))),httpTransport:'fixture-container-loopback',auth:'not-exercised',model:'not-exercised',githubGate:'not-exercised'});
 return {plan:join(o.root,'plan.json'),next:`node ${join(trustedRoot,'scripts/deploy-integration.mjs')} ${join(o.root,'plan.json')}`,auth:'not-exercised',model:'not-exercised'};
});}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 try {need(process.argv.length===3 || (process.argv.length===4 && process.argv[3]==='--check'),'Installer accepts config and optional --check only');const path=resolve(process.argv[2]);await privatePath(path);need((await lstat(path)).isFile(),'Regular installer config required');console.log(JSON.stringify(await install(await json(path),{checkOnly:process.argv[3]==='--check'})));}
 catch(e) {console.error(e.diagnostic?e.message:'Fixture installer config failed before root creation; check private config path/JSON/permissions. No success claimed.');process.exitCode=1;}
}
