// External operator only, reviewed clean source checkouts; no service installation or credentials.
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { command } from './post-pr-docker.mjs';
import { digest } from './post-pr.mjs';
import { fixtureSource, fixtureLabels } from './deploy-fixture.mjs';
const need=(v,m)=>{if(!v) throw Error(m);};
export async function prepare(source,paths,out) {
 need(/^[a-f0-9]{40}$/.test(source) && paths.length===2,'Usage: source-SHA A-checkout B-checkout NEW-output-dir');
 // Exclusive new output prevents overwriting previous evidence. Partial failure remains for inspection.
 await mkdir(out,{mode:0o700});await mkdir(join(out,'logs'),{mode:0o700});
 const run=async(file,args,cwd)=>{
  const r=await command(file,args,{cwd});need(r.exit===0,'Fixture command failed; inspect private output directory');return r.output;
 };
 const checks=[];
 for(const [i,path] of paths.entries()) {
  need(await realpath(path)===path,'Canonical checkout required');
  need((await run('git',['--no-optional-locks','status','--porcelain','--untracked-files=all'],path)).length===0,'Clean fixture checkout required');
  const commit=(await run('git',['rev-parse','HEAD'],path)).toString().trim();
  const row=await fixtureSource(path,source,commit,['A','B'][i]);
  checks.push({path,...row});
 }
 need(checks[0].commit!==checks[1].commit,'Distinct fixture commits required');
 const versions=[];
 for(const row of checks) {
  const labels=fixtureLabels(source,row.commit,row.tree),iid=join(out,`image-${versions.length}.id`);
  const logs={};
  const collect=async(name,file,args)=>{
   const r=await command(file,args,{cwd:row.path});
   const hash=digest(r.output);await writeFile(join(out,'logs',hash),r.output,{mode:0o600});
   need(r.exit===0,`Fixture ${name} failed; private log ${hash}; no complete provenance written`);logs[name]=hash;
  };
  await collect('build','docker',['build','--iidfile',iid,...Object.entries(labels).flatMap(([k,v])=>['--label',`${k}=${v}`]),row.path]);
  const image=(await readFile(iid,'utf8')).trim();need(/^sha256:[a-f0-9]{64}$/.test(image),'Image ID missing');
  // command() deliberately strips credentials. Pass only the selected image through sh's
  // positional parameter; no model call, production auth or live volume is used by smoke.sh.
  await collect('smoke','sh',['-c','MOMOFLOW_IMAGE="$1" sh scripts/smoke.sh','fixture-smoke',image]);
  versions.push({commit:row.commit,tree:row.tree,runnerSource:row.runnerSource,image,logs});
 }
 need(versions[0].image!==versions[1].image,'Fixture images must differ');
 const e={kind:'momoflow-isolated-fixture-v1',source,versions};
 await writeFile(join(out,'provenance.json'),JSON.stringify(e,null,2)+'\n',{mode:0o600,flag:'wx'});
 return {path:join(out,'provenance.json'),hash:digest(e)};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 try {
  const [source,a,b,out,...extra]=process.argv.slice(2);need(source&&a&&b&&out&&!extra.length,'Four arguments required');
  console.log(JSON.stringify(await prepare(source,[resolve(a),resolve(b)],resolve(out))));
 } catch {console.error('Fixture preparation failed; inspect private logs. No deployment success claimed.');process.exitCode=1;}
}
