import fs from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const scripts=dirname(fileURLToPath(import.meta.url));
const pkg=await import(pathToFileURL(process.env.PRISM_HARNESS_TS+'/dist/index.js'));
const env={};for(const[key,value]of Object.entries(process.env))if(/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL|PYTHONPATH|PRISM_HARNESS_TS)$/i.test(key))env[key]=value;
const children=[],reports=[];
function launch(language,spec){
 const file=join(spec.work,'spec-'+randomUUID()+'.json');fs.writeFileSync(file,JSON.stringify(spec),{flag:'wx'});
 const child=spawn(language==='ts'?process.execPath:process.env.PRISM_PYTHON_BINARY,[join(scripts,'index-worker.'+(language==='ts'?'mjs':'py')),file],{env,stdio:['ignore','pipe','pipe'],windowsHide:true,timeout:30000});
 let stdout='',stderr='';child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);
 const completion=new Promise(done=>{child.once('error',error=>done({code:null,error:error.code,stdout,stderr}));child.once('close',(code,signal)=>done({code,signal,stdout,stderr}));});
 const record={child,completion};children.push(record);return record;
}
async function finish(record){const result=await record.completion;assert.equal(result.code,0,JSON.stringify(result));assert(!result.error);return JSON.parse(result.stdout);}
async function wait(work,names,nonce){
 const deadline=Date.now()+25000;
 for(;;){
  for(const name of names){try{assert.equal(JSON.parse(fs.readFileSync(join(work,name),'utf8')).nonce,nonce);return name;}catch(error){if(error.code!=='ENOENT')throw error;}}
  if(Date.now()>deadline)throw Error('Owned recovery handshake timed out');
  await new Promise(done=>setTimeout(done,10));
 }
}
function mark(work,name,nonce){const path=join(work,name),tmp=path+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify({nonce}),{flag:'wx'});fs.renameSync(tmp,path);}
try{
 for(const languages of [['ts','ts'],['py','py'],['ts','py'],['py','ts']]){
  const name=languages.join('-'),work=join(process.env.PRISM_INDEX_WORK,'recovery-'+name),storePath=join(work,'store'),nonce=randomUUID();
  assert.equal(dirname(resolve(work)),resolve(process.env.PRISM_INDEX_WORK));fs.mkdirSync(work);fs.mkdirSync(storePath);
  fs.writeFileSync(join(work,'owned.json'),JSON.stringify({root:work,nonce}),{flag:'wx'});
  const common={work,store:storePath,nonce,mixedSlots:true};
  const store=new pkg.FileSessionStore(storePath),memory=new pkg.MemorySessionStore();
  const session=new pkg.PrismHarness({drivers:{memory:()=>memory,files:()=>store},stores:{ephemeral:'memory',durable:'files'}}).forAgent('support').for({type:'workers',id:'1'}).session('shared-lock');
  const canonical=join(storePath,createHash('sha256').update(session.key()).digest('hex').slice(0,32)+'.json.lock');
  const holder=launch(languages[0],{...common,action:'hold',ttlSeconds:1});await wait(work,['held.json'],nonce);
  const originalFiles=fs.readdirSync(canonical);assert.equal(originalFiles.length,1);
  const original=JSON.parse(fs.readFileSync(join(canonical,originalFiles[0]),'utf8'));
  const ready=JSON.parse(fs.readFileSync(join(work,'held.json'),'utf8'));
  assert.equal(original.pid,ready.pid);assert.deepEqual(original.identity,ready.identity);assert.equal(original.released,false);assert(original.identity.pid_namespace);
  mark(work,'crash.json',nonce);const terminated=await holder.completion;
  assert.equal(terminated.code,0,'The owned actual worker must exit without release, through its authenticated barrier');
  assert.deepEqual(JSON.parse(fs.readFileSync(join(canonical,originalFiles[0]),'utf8')),original);
  const racers=languages.map((language,i)=>launch(language,{...common,action:'race',worker:String(i),waitSeconds:0.25}));
  await Promise.all([wait(work,['started-0.json'],nonce),wait(work,['started-1.json'],nonce)]);
  const entered=await wait(work,['entered-0.json','entered-1.json'],nonce),winner=entered==='entered-0.json'?0:1,loser=1-winner;
  const refused=await finish(racers[loser]);
  assert.equal(refused.callbacks,0);assert.equal(refused.error_code,'session_locked');assert.deepEqual(refused.identity,original.identity);
  assert.equal(racers[winner].child.exitCode,null,'Winning callback must still hold its barrier');
  assert.deepEqual(fs.readFileSync(join(work,'callbacks.log'),'utf8').trim().split('\n'),[String(winner)]);
  const replacementFiles=fs.readdirSync(canonical);assert.equal(replacementFiles.length,1);
  const replacement=JSON.parse(fs.readFileSync(join(canonical,replacementFiles[0]),'utf8'));
  const winningReady=JSON.parse(fs.readFileSync(join(work,entered),'utf8'));
  assert.notEqual(replacement.nonce,original.nonce);assert.equal(replacement.pid,winningReady.pid);
  assert.deepEqual(replacement.identity,original.identity);assert.equal(replacement.released,false);
  mark(work,'race-release.json',nonce);const admitted=await finish(racers[winner]);
  assert.equal(admitted.callbacks,1);assert.equal(admitted.error_code,null);assert.deepEqual(admitted.identity,original.identity);
  assert(!fs.existsSync(canonical),'Normal cleanup leaves no canonical lock behind');
  reports.push({case:name,memory_state_file_durable:true,original,owned_holder_exited_without_release:true,launcher_pid:holder.child.pid,worker_pid:ready.pid,replacement,
    winner,callback_entries:1,loser_callbacks:0,loser_error:refused.error_code,independent_identities_match:true,
    two_reclaimers_exclusion:true,canonical_removed:true});
 }
 console.log(JSON.stringify({measured_at:new Date().toISOString(),platform:process.platform,separate_processes:true,reports}));
 console.log('Production owner recovery passed: 4 native/mixed cases; 4 owned dead holders; 8 real reclaimers; 4 callback entries; 0 overlaps.');
}finally{
 for(const record of children)if(record.child.exitCode===null&&record.child.signalCode===null)record.child.kill('SIGTERM');
 await Promise.all(children.map(record=>record.completion));
}
