import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const spec=JSON.parse(fs.readFileSync(process.argv[2])),owner=JSON.parse(fs.readFileSync(join(spec.work,'owned.json')));
assert.equal(owner.nonce,spec.nonce);assert.equal(resolve(owner.root),resolve(spec.work));
assert.equal(fs.realpathSync(spec.store),join(fs.realpathSync(spec.work),'store'));
const pkg=await import(pathToFileURL(process.env.PRISM_HARNESS_TS+'/dist/index.js')),store=new pkg.FileSessionStore(spec.store);
const {nativeLockIdentity}=await import(pathToFileURL(process.env.PRISM_HARNESS_TS+'/dist/stores/file-lock-identity.js'));
const identity=nativeLockIdentity();
assert(identity?.pid_namespace,'Native production identity must be established');
const memory=new pkg.MemorySessionStore();
const session=spec.mixedSlots?new pkg.PrismHarness({drivers:{memory:()=>memory,files:()=>store},stores:{ephemeral:'memory',durable:'files'}}).forAgent('support').for({type:'workers',id:'1'}).session('shared-lock'):null;
const lock=(callback,ttl=60)=>session?session.lock(callback,ttl,spec.waitSeconds??0):store.withLock(spec.lockKey,callback,ttl,spec.waitSeconds??0);
async function wait(name){const deadline=Date.now()+20000;while(true){if(spec.action==='hold'&&fs.existsSync(join(spec.work,'crash.json'))){assert.equal(JSON.parse(fs.readFileSync(join(spec.work,'crash.json'))).nonce,spec.nonce);process.exit(0);}try{assert.equal(JSON.parse(fs.readFileSync(join(spec.work,name))).nonce,spec.nonce);return;}catch(error){if(error.code!=='ENOENT')throw error;}if(Date.now()>deadline)throw Error('Owned test handshake timed out');await new Promise(r=>setTimeout(r,10));}}
function mark(name){const target=join(spec.work,name),temporary=`${target}.${process.pid}.tmp`;fs.writeFileSync(temporary,JSON.stringify({nonce:spec.nonce,pid:process.pid,identity}));fs.renameSync(temporary,target);}
let callbacks=0,errorCode=null;
if(spec.action==='index'){
  mark(`ready-${spec.worker}.json`);await wait('go.json');
  const harness=new pkg.PrismHarness({drivers:{owned:()=>store},stores:{ephemeral:'owned',durable:'owned'}});
  for(const scope of [...Array.from({length:50},(_,i)=>`worker:${spec.worker}:${i}`),'shared'])await harness.forAgent('support').for({type:'workers',id:'1'}).session(scope).usingMode(spec.worker);
}else if(spec.action==='hold'){
  await lock(async()=>{mark('held.json');await wait('release.json');},spec.ttlSeconds??60);
}else if(spec.action==='race'){
  mark(`started-${spec.worker}.json`);
  try{await lock(async()=>{callbacks++;fs.appendFileSync(join(spec.work,'callbacks.log'),spec.worker+'\n');mark(`entered-${spec.worker}.json`);await wait('race-release.json');});}
  catch(error){if(!(error instanceof pkg.HarnessError)||error.code!=='session_locked')throw error;errorCode=error.code;}
}else{
  try{await lock(()=>{callbacks++;});}catch(error){if(!(error instanceof pkg.HarnessError)||error.code!=='session_locked')throw error;errorCode=error.code;}
}
console.log(JSON.stringify({action:spec.action,callbacks,error_code:errorCode,identity,pid:process.pid}));
