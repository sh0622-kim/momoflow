// Called by ExUnit: real RoleRunner ledger -> production reconcile -> real resume envelope.
import {json, atomic, reconcile, keyFor} from './post-pr.mjs';
import {fixture} from './post-pr-fixture.mjs';
import {join} from 'node:path';
const [ledgerPath, inbox, kind] = process.argv.slice(2);
const ledger=await json(ledgerPath), f=fixture(ledger);
if(ledger.launch) f.c.launch=ledger.launch;
f.result.kind=kind;
if(kind==='code_failure') Object.assign(f.result.checks.find(x=>x.name==='contracts'),{exit:2,failures:1});
f.io.resume=e=>atomic(join(inbox,`${keyFor(f.c)}.json`),e);
const result=await reconcile(f.c,f.io);
if(kind==='passed'&&!result.done) throw Error('Finalization did not complete');
console.log(JSON.stringify(result));
