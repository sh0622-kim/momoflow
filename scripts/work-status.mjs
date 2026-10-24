// Optional display projection only. Never consumed as a resume envelope or authority.
import { createHash } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
const phases = new Set(['validating','checks_wait','review_wait','correction','merged','finishing','complete','blocked','await_decision']);
export async function writeWorkStatus(c, ledger, phase, publication = ledger?.publication) {
  let temp;
  try {
    if (!phases.has(phase) || !/^[\w.-]+\/[\w.-]+$/.test(c.repo) || c.repo.includes('..') ||
        !/^[1-9][0-9]{0,9}$/.test(c.issue) || !/^[a-f0-9]{64}$/.test(ledger?.launch?.id) ||
        ledger.launch.repo !== c.repo || ledger.launch.issue !== c.issue || !Array.isArray(ledger.events) ||
        !/^[a-f0-9]{40}$/.test(publication?.head) || !Number.isSafeInteger(publication.pr) || publication.pr < 1) return false;
    const key = createHash('sha256').update(`${c.repo}:${c.issue}`).digest('hex');
    const value = {v:1,repo:c.repo,issue:c.issue,launch:ledger.launch.id,generation:ledger.events.length,
      pr:publication.pr,head:publication.head,phase,observed_at:new Date().toISOString()};
    temp = join(c.inboxRoot, `${key}.status.${process.pid}.tmp`);
    const f = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o644);
    try { await f.writeFile(JSON.stringify(value)); await f.sync(); } finally { await f.close(); }
    await rename(temp,join(c.inboxRoot,`${key}.status.json`));
    return true;
  } catch { return false; } finally { if(temp) await rm(temp,{force:true}).catch(()=>{}); }
}
