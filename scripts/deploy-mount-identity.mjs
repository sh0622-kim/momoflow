// Read-only Linux filesystem identities. Never translate daemon Source into a host path.
import { readFile, realpath, stat, lstat } from 'node:fs/promises';
import { resolve, dirname, join, basename } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
const need=(v,m)=>{if(!v) throw Object.assign(Error(m),{safeReason:m});};
const within=(p,root)=>p===root || p.startsWith(root==='/'?'/':root+'/');
const unescape=s=>s.replace(/\\(040|011|012|134)/g,(_,n)=>String.fromCharCode(parseInt(n,8)));
export function mountRows(text) {
 need(typeof text==='string' && text.trim(),'Isolation mountinfo unavailable');
 return text.trim().split('\n').map(line=>{
  const f=line.split(' '),sep=f.indexOf('-');
  need(sep>=6 && f.length>sep+3 && /^\d+:\d+$/.test(f[2]),'Isolation mountinfo is malformed');
  const root=unescape(f[3]),target=unescape(f[4]);
  return {device:f[2],root,target,filesystem:f[sep+1],source:unescape(f[sep+2]),options:f[sep+3]};
 });
}
function device(n) {
 n=BigInt(n);return `${((n>>8n)&0xfffn)|((n>>32n)&0xfffff000n)}:${(n&0xffn)|((n>>12n)&0xffffff00n)}`;
}
export function filesystemIdentity(rows,path,s) {
 // Retain unusable rows (including WSL's stale //deleted bind roots). They
 // cannot supply identities, but an unrelated mount must not poison the table.
 // Normalization is only a conservative overlap check, never identity evidence.
 for(const r of rows) if(resolve(r.root)!==r.root || resolve(r.target)!==r.target) {
  const located=r.target.startsWith('/') && !r.target.split('/').some(p=>p==='.' || p==='..');
  need(located && [r.target,resolve(r.target)].every(target=>!within(path,target) && !within(target,path)),
   'Isolation mountinfo path is ambiguous');
 }
 const matches=rows.filter(r=>within(path,r.target)).sort((a,b)=>b.target.length-a.target.length);
 need(matches.length && (matches.length===1 || matches[0].target!==matches[1].target),'Isolation mountinfo has missing/stacked mount');
 need(/^\d+$/.test(String(s.dev)) && /^[1-9]\d*$/.test(String(s.ino)),'Isolation stat identity invalid');
 const m=matches[0];
 // Only filesystems with direct device/root coordinates are supported. In particular,
 // overlay, btrfs subvolumes, FUSE and network/shared backing cannot prove disjointness.
 need(['ext4','ext3','ext2','xfs','tmpfs'].includes(m.filesystem),'Isolation filesystem backing unsupported; direct correspondence required');
 need(m.device===device(s.dev),'Isolation mountinfo/stat device mismatch');
 return {device:m.device,path:join(m.root,path.slice(m.target.length)),inode:String(s.ino)};
}
export function identitiesOverlap(a,b) {
 return a.device===b.device && (within(a.path,b.path) || within(b.path,a.path) || (a.inode && a.inode===b.inode));
}
// Existing Node in both services; only kernel metadata and stat, no file contents or Env.
export const mountProbe=`const fs=require('fs');const paths=JSON.parse(process.argv[1]);
const read=p=>fs.readFileSync(p,'utf8');
const points=paths.map(p=>{const path=fs.realpathSync(p),s=fs.statSync(path,{bigint:true});return {path,dev:String(s.dev),ino:String(s.ino)};});
fs.writeSync(1,JSON.stringify({boot:read('/proc/sys/kernel/random/boot_id').trim(),mountinfo:read('/proc/self/mountinfo'),points}));`;
export async function mountContext(docker,containers,{recoveryProbes=new Map()}={}) {
 let boot,rows;
 try {
  boot=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
  rows=mountRows(await readFile('/proc/self/mountinfo','utf8'));
 } catch {need(false,'Isolation host kernel/mountinfo metadata unavailable');}
 const mounted=new Map(),volumes=new Map();
 for(const x of containers.filter(x=>x.Id)) {
  let probe,after;
  try {
   const image=recoveryProbes.get(x.Id),paths=JSON.stringify(x.Mounts.map(m=>m.Destination));
   // Recovery-only, credential-free fixture. Fresh metadata from the same daemon
   // sources without starting the failed candidate or relying on cached identities.
   if(image) {
    need(x.State?.Running===false && image===x.Image && /^sha256:[a-f0-9]{64}$/.test(image),'Isolation recovery probe identity invalid');
    probe=JSON.parse(await docker(['run','--rm','--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','1000:1000','--volumes-from',x.Id+':ro','--entrypoint','node',image,'-e',mountProbe,paths]));
   } else probe=JSON.parse(await docker(['exec',x.Id,'node','-e',mountProbe,paths]));
   after=JSON.parse(await docker(['inspect','--format','{{json .Mounts}}',x.Id]));
  } catch {need(false,'Isolation live mount metadata probe unavailable');}
  need(same(after,x.Mounts),'Isolation live mounts changed during probe');
  need(/^[a-f0-9-]{36}$/.test(boot) && probe?.boot===boot,'Isolation host/daemon kernel identity differs; mount correspondence unverified');
  need(Array.isArray(probe.points) && probe.points.length===x.Mounts.length,'Isolation live mount metadata incomplete');
  const liveRows=mountRows(probe.mountinfo);
  for(const [i,m] of x.Mounts.entries()) {
   const p=probe.points[i];
   need(p && typeof p.path==='string' && resolve(p.path)===p.path,'Isolation live mount path invalid');
   need(liveRows.filter(r=>r.target===p.path).length===1,'Isolation live mount destination missing/stacked');
   need(!liveRows.some(r=>r.target!==p.path && within(r.target,p.path)),'Isolation nested mounts require explicit correspondence');
   const identity=filesystemIdentity(liveRows,p.path,p);
   mounted.set(m,identity);
   if(m.Type==='volume') {
    need(!volumes.has(m.Name) || same(volumes.get(m.Name),identity),'Isolation volume correspondence conflicts');
    volumes.set(m.Name,identity);
   }
  }
 }
 const host=async path=>{
  need(typeof path==='string' && resolve(path)===path,'Noncanonical isolation bind/control path');
  let parent=path,suffix=[];
  while(true) {
   try {
    need(await realpath(parent)===parent,'Noncanonical isolation bind/control path');
    need(!rows.some(r=>r.target!==path && within(r.target,path)),'Isolation host nested mounts require explicit correspondence');
    const s=await stat(parent,{bigint:true});
    need(!suffix.length || s.isDirectory(),'Isolation prospective ancestor is not a directory');
    const identity=filesystemIdentity(rows,parent,s);
    return suffix.length?{...identity,path:join(identity.path,...suffix),inode:null}:identity;
   } catch(e) {
    if(e.code!=='ENOENT') throw e;
    try {await lstat(parent);need(false,'Isolation dangling symlink cannot be resolved');} catch(missing) {if(missing.code!=='ENOENT') throw missing;}
    need(parent!=='/','Isolation host ancestor unavailable');suffix.unshift(basename(parent));parent=dirname(parent);
   }
  }
 };
 return {mounted,volumes,host};
}
// Fixture-only normalization. Prove each expected bind is the mounted object first;
// preserve destination/type/RW and every non-path runtime field in the caller.
export async function fixtureMountSources(live,expected,docker,options) {
 const context=await mountContext(docker,[live],options);
 return Promise.all(live.Mounts.map(async m=>{
  if(m.Type!=='bind') return m;
  const e=expected.mounts.filter(e=>e.type==='bind' && e.destination===m.Destination && e.rw===m.RW);
  need(e.length===1,'Fixture bind destination/type/authority mismatch');
  const host=await context.host(e[0].source),actual=context.mounted.get(m);
  need(actual && host.inode && host.device===actual.device && host.path===actual.path && host.inode===actual.inode,'Fixture bind host/live correspondence mismatch');
  return {...m,Source:e[0].source};
 }));
}
