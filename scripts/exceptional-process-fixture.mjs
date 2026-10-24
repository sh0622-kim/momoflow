// Real installed module + subprocess/files/locks, mocked GitHub. Never a live deployment.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSync } from 'node:fs';
import { command } from './post-pr-docker.mjs';
import { fixture } from './post-pr-fixture.mjs';
import { atomic, digest, json, keyFor, withControllerLock } from './post-pr.mjs';
import { prepareExceptional, respondExceptional, requireApproval, executeExceptional, authorizeExceptional, recordResponse, exceptionalReport } from './exceptional.mjs';
if(!process.argv[2]) {
 const root=await mkdtemp('/tmp/exceptional-install-');
 try {
  const trusted=join(root,'controller');await mkdir(trusted);await cp(dirname(fileURLToPath(import.meta.url)),join(trusted,'scripts'),{recursive:true});
  for(const args of [['init','-q'],['add','scripts'],['-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','-qm','test-only install']])assert.equal((await command('git',['-C',trusted,...args])).exit,0);
  const r=await command(process.execPath,[join(trusted,'scripts/exceptional-process-fixture.mjs'),root],{timeout:50000});assert.equal(r.exit,0,r.output.toString());writeSync(1,r.output);
 }finally{await rm(root,{recursive:true,force:true});}
} else {
 const root=process.argv[2],trusted=join(root,'controller'),f=fixture();f.merged=true;
 const installed=(await command('git',['-C',trusted,'rev-parse','HEAD'])).output.toString().trim();
 const configFile=join(root,'launch-config.json'),planFile=join(root,'plan.json');
 const c={...f.c,trustedRoot:trusted,launchId:'a'.repeat(64),iterationLimit:3,authority:{...f.c.authority,finish:true,deploy:true,retire:true}};
 for(const k of ['stateRoot','inboxRoot','ledgerRoot','launchRoot']) {c[k]=join(root,k);await mkdir(c[k],{mode:0o700});}
 c.tokenFile=join(root,'token.json');await atomic(c.tokenFile,{token:'never-used-by-network',expires_at:new Date(Date.now()+3600000).toISOString()});
 const compose=join(root,'previous-compose.json');await atomic(compose,{services:{symphony:{image:'sha256:'+'0'.repeat(64)}}});
 const previous={commit:'0'.repeat(40),image:'sha256:'+'0'.repeat(64),authImage:'sha256:'+'2'.repeat(64),runnerSource:digest('old-runner'),composeFile:compose,composeHash:digest(await readFile(compose)),inspect:{symphony:{image:'sha256:'+'0'.repeat(64)},'github-auth':{}}};previous.files={[compose]:previous.composeHash};
 c.finish={deploymentRoot:join(root,'deploy'),gateRoot:join(root,'gate'),project:'test',dataVolume:'test-data',drainMs:1000,verifyMs:1000,previous};await mkdir(c.finish.gateRoot,{mode:0o700});
 await atomic(configFile,c);
 const launch={v:1,id:c.launchId,repo:c.repo,issue:c.issue,base:c.base,limit:3};
 f.ledger.launch=launch;
 f.result.checks.find(x=>x.name==='contracts').tests=87;f.result.checks.find(x=>x.name==='node').tests=126;f.result.tests=213;
 for(const row of f.result.checks)row.log=digest('fixed-log');
 const e={ledger:f.ledger,publication:f.p,validation:f.result,merge:'f'.repeat(40)};
 const dir=join(c.stateRoot,keyFor(c));await mkdir(join(dir,'logs'),{recursive:true,mode:0o700});await writeFile(join(dir,'logs',digest('fixed-log')),'fixed-log',{mode:0o600});
 await atomic(join(dir,'launch.json'),{done:true,contract:digest(launch),settings:digest(c),finishSettings:digest(c)});
 await atomic(join(dir,'journal.json'),{done:true,publication:f.p,request:digest(f.p),mergeAttempt:{state:'confirmed',sha:e.merge},merged:e.merge,validation:f.result});
 const evidencePath=join(dir,`evidence-${digest(e)}.json`);await atomic(evidencePath,e);
 const ledgerFile=join(c.ledgerRoot,keyFor(c)+'.json');await atomic(ledgerFile,f.ledger);await atomic(ledgerFile+'.enrolled',launch);await atomic(join(c.launchRoot,'active.json'),launch);
 await atomic(join(dir,'completion.json'),{phase:'excluded',request:digest(c),publication:f.p,evidence:{hash:digest(e)},reason:'ordinary engine/host exclusion'});
 const plan={v:1,kind:'exceptional-completion-v1',config:configFile,controllerVersion:installed,validationOrigin:c.controllerVersion,unchanged:{auth:true,permissions:true,rolePolicy:true,data:true,checks:true}};await atomic(planFile,plan);
 const originals=new Map();for(const path of [configFile,join(dir,'launch.json'),join(dir,'journal.json'),ledgerFile,ledgerFile+'.enrolled',evidencePath,join(dir,'completion.json'),join(c.launchRoot,'active.json')])originals.set(path,await readFile(path));
 f.responses.set(`GET /repos/fixture/repo/contents/engine/role_runner.ex?ref=${e.merge}`,{encoding:'base64',content:Buffer.from('new-runner').toString('base64')});
 f.responses.set(`GET /repos/fixture/repo/git/commits/${e.merge}`,{tree:{sha:f.p.tree},parents:[{sha:f.p.base_head},{sha:f.p.head}]});
 f.responses.set('GET /repos/fixture/repo/pulls/2/files?per_page=100',[{filename:'scripts/finish.mjs',status:'modified'}]);
 f.responses.set('GET /repos/fixture/repo/issues/2/comments?per_page=100',()=>f.comments.map(x=>({...x,id:20})));
 f.responses.set('PATCH /repos/fixture/repo/issues/comments/20',body=>{f.comments[0].body=body.body;return {id:20,...body};});
 let afterEvidence=async()=>{};
 globalThis.fetch=async(url,options)=>{assert.ok(url.startsWith('https://api.github.com/'));const body=options.body?JSON.parse(options.body):undefined;const x=await f.io.api(options.method,url.slice('https://api.github.com'.length),body);if(url.endsWith('/graphql'))await afterEvidence();return {ok:true,status:200,json:async()=>x};};
 let checks=0;
 const result=await prepareExceptional(planFile),p=result.prepared,file=result.preparedFile,exceptionRoot=dirname(file);
 assert.equal(p.controllerVersion,installed);assert.equal(p.validationOrigin,c.controllerVersion);assert.equal(p.request.target.runnerSource,digest('new-runner'));assert.equal(p.request.previous.runnerSource,digest('old-runner'));checks++;
 assert.notEqual(p.request.target.runnerSource,p.request.previous.runnerSource);
 for(const path of [c.finish.deploymentRoot,join(c.finish.gateRoot,'active.json')])await assert.rejects(readFile(path),/ENOENT/);checks++;
 assert.equal((await prepareExceptional(planFile)).digest,result.digest);checks++;
 await withControllerLock(c,async()=>assert.rejects(prepareExceptional(planFile),/EEXIST/));checks++;
 const response={prepared:digest(p),scope:p.scope,actor:'external-operator',authority:'existing-scope',source:'https://github.com/fixture/repo/issues/1#issuecomment-1',action:'approve',at:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
 const responseFile=join(root,'response.json');await atomic(responseFile,response);
 const a=await respondExceptional(file,responseFile);assert.equal(a.result,'approved');assert.deepEqual(await respondExceptional(file,responseFile),a);checks++;
 await requireApproval(p,exceptionRoot);checks++;
 await prepareExceptional(planFile);assert.equal((await json(join(exceptionRoot,'report.json'))).phase,'approved');checks++;
 // Expiry/withdrawal during the last slow fresh evidence response must win.
 const realNow=Date.now;
 afterEvidence=async()=>{Date.now=()=>realNow()+120000;};
 try {await assert.rejects(authorizeExceptional(p,exceptionRoot,file),/expired/);}finally{Date.now=realNow;afterEvidence=async()=>{};}checks++;
 afterEvidence=async()=>{afterEvidence=async()=>{};await recordResponse(p,exceptionRoot,{...response,action:'revoke'});};
 await assert.rejects(authorizeExceptional(p,exceptionRoot,file),/revoked/);checks++;

 // Revocation uses its own lock, so an executing deployment/controller lock does not prevent withdrawal.
 await atomic(responseFile,{...response,action:'revoke'});
 await withControllerLock(c,async()=>assert.equal((await respondExceptional(file,responseFile)).result,'revoked'));checks++;
 await assert.rejects(requireApproval(p,exceptionRoot),/revoked/);checks++;
 await prepareExceptional(planFile);assert.equal((await json(join(exceptionRoot,'report.json'))).phase,'revoked');checks++;

 await atomic(responseFile,response);await assert.rejects(respondExceptional(file,responseFile),/already processed/);checks++;
 // A synthetic saved completion exercises freshness observation only, never a live result.
 await atomic(join(exceptionRoot,'completion.json'),{phase:'complete',request:digest(p),approval:{hash:digest(a)}});
 f.issueState='closed'; // Explicitly synthetic prior closure; no live completion claim.
 await exceptionalReport(c,p,await json(join(exceptionRoot,'completion.json')),exceptionRoot);
 assert.equal((await json(join(exceptionRoot,'report.json'))).closed,true);
 await prepareExceptional(planFile);await atomic(responseFile,{...response,action:'revoke'});await respondExceptional(file,responseFile);
 assert.equal((await json(join(exceptionRoot,'report.json'))).phase,'complete');assert.equal((await json(join(exceptionRoot,'report.json'))).closed,true);checks++;
 // Stale config stops before Docker; original owner records are preserved, never reinitialized.
 await atomic(configFile,{...c,hold:true});await assert.rejects(executeExceptional(file));assert.equal((await json(join(exceptionRoot,'completion.json'))).recheck.status,'blocked');await writeFile(configFile,originals.get(configFile));checks++;
 // Fresh prepare rechecks paths, not a cached classification.
 f.responses.set('GET /repos/fixture/repo/pulls/2/files?per_page=100',[{filename:'scripts/github-app-auth.mjs',status:'modified'}]);await assert.rejects(prepareExceptional(planFile),/Unsupported exceptional paths/);checks++;
 for(const [path,bytes] of originals)assert.deepEqual(await readFile(path),bytes);checks++;
 assert.equal((await json(join(exceptionRoot,'approval.json'))).result,'revoked');
 assert.ok(f.pad.body.includes('예외 배포 판단'));assert.ok(f.comments.some(x=>x.body.includes('momoflow:exceptional:')));checks++;
 // Installed checkout drift must fail closed before prepare/effects.
 await writeFile(join(trusted,'untracked'),'dirty');await assert.rejects(prepareExceptional(planFile),/cleanliness/);await rm(join(trusted,'untracked'));checks++;
 writeSync(1,JSON.stringify({checks,evidenceKind:'mock-github-real-installed-subprocess-files-no-docker'})+'\n');
}
