import fs from'node:fs';
import os from'node:os';
import assert from'node:assert/strict';
import{join,dirname,resolve}from'node:path';
import{fileURLToPath}from'node:url';
import{spawn,spawnSync}from'node:child_process';
import{createHash,randomUUID}from'node:crypto';
const scripts=dirname(fileURLToPath(import.meta.url)),parent=resolve(process.env.PRISM_PUBLISHED_LOCK_WORK??os.tmpdir());
fs.mkdirSync(parent,{recursive:true});
const root=fs.mkdtempSync(join(parent,'prism-production-published-'));
const python=process.env.PRISM_PYTHON_BINARY??'python',sourceTS=process.env.PRISM_HARNESS_TS;
assert(sourceTS&&process.env.PYTHONPATH,'Both actual production source ports must be selected');
const hash=data=>createHash('sha256').update(data).digest('hex');
const artifacts={
 ts:{url:'https://registry.npmjs.org/@particle-academy/prism-harness/-/prism-harness-0.8.0.tgz',file:'old.tgz',sha256:'0cbee9d7f2693fd715909640f135015195689939d96a7a30fa2d6364d87e2de5'},
 py:{url:'https://files.pythonhosted.org/packages/10/33/fce9b664a19d3785b6a68230a7582bcd52a588191c361a6d4640e0ca9d94/prism_ai_harness-0.3.0-py3-none-any.whl',file:'old.whl',sha256:'9c40c140d648877e5109fe6372ca74c3b0877661459ae4f8aa9c6e11f950496e'},
};
function run(exe,args,extra={}){
 const child=spawnSync(exe,args,{cwd:root,env:{...process.env,...extra},encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024});
 assert(!child.error);assert.equal(child.status,0,child.stdout+'\n'+child.stderr);return child.stdout;
}
const downloads=await Promise.allSettled(Object.values(artifacts).map(async artifact=>{
 const response=await fetch(artifact.url,{signal:AbortSignal.timeout(30000)});assert(response.ok);
 const bytes=Buffer.from(await response.arrayBuffer());assert.equal(hash(bytes),artifact.sha256);
 fs.writeFileSync(join(root,artifact.file),bytes,{flag:'wx'});
}));for(const result of downloads)if(result.status==='rejected')throw result.reason;
const oldTS=join(root,'old-ts'),oldPy=join(root,'old-py');fs.mkdirSync(oldTS);fs.mkdirSync(oldPy);
assert(run('tar',['-tzf',join(root,artifacts.ts.file)]).trim().split(/\r?\n/).every(name=>name.startsWith('package/')&&!name.split('/').includes('..')));
run('tar',['-xzf',join(root,artifacts.ts.file),'-C',oldTS]);
run(python,['-c','import pathlib,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert all(not pathlib.PurePosixPath(i.filename).is_absolute() and ".." not in pathlib.PurePosixPath(i.filename).parts and ((i.external_attr >> 16) & 0o170000) != 0o120000 for i in z.infolist()); z.extractall(sys.argv[2])',join(root,artifacts.py.file),oldPy]);
assert.equal(JSON.parse(fs.readFileSync(join(oldTS,'package/package.json'))).version,'0.8.0');
const baseEnv={};for(const[key,value]of Object.entries(process.env))if(/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|PRISM_HARNESS_TS|PYTHONPATH)$/i.test(key))baseEnv[key]=value;
function oldProbe(language,directory,key,tag){
 const spec=join(root,tag+'-'+language+'.json');fs.writeFileSync(spec,JSON.stringify({store:directory,key,package:language==='ts'?join(oldTS,'package'):oldPy}),{flag:'wx'});
 if(language==='ts'){
  const trace=join(root,tag+'-trace.json');
  const native=JSON.parse(run(process.execPath,['--trace-event-categories','node.fs.async,node.fs.sync','--trace-event-file-pattern',trace,join(scripts,'published-lock-worker.mjs'),spec]));
  const operations=JSON.parse(fs.readFileSync(trace)).traceEvents.filter(event=>/unlink|rename|rmdir/i.test(event.name));
  return{native,operations};
 }
 const native=JSON.parse(run(python,[join(scripts,'published_lock_worker.py'),spec],{PYTHONPATH:oldPy}));
 return{native,operations:native.audit};
}
function legacyDefaults(){
 const reports={};
 for(const mode of['baseline','candidate'])for(const language of['ts','py'])for(const fixture of['legacy-runner','legacy-defaults-runner']){
  const directory=join(root,'defaults-'+mode+'-'+language+'-'+fixture);fs.mkdirSync(directory);
  const selected={PYTHONIOENCODING:'utf-8',PRISM_HARNESS_TS:mode==='baseline'?join(oldTS,'package'):sourceTS,PYTHONPATH:mode==='baseline'?oldPy:process.env.PYTHONPATH};
  const output=run(language==='ts'?process.execPath:python,[join(scripts,fixture+(language==='ts'?'.mjs':'.py')),directory],selected);
  const value=JSON.parse(output.trim().split(/\r?\n/).at(-1));reports[mode+'-'+language+'-'+fixture]=value;
  fs.writeFileSync(directory+'.report.json',JSON.stringify(value),{flag:'wx'});
 }
 const comparisons=[];
 for(const language of['ts','py'])for(const fixture of['legacy-runner','legacy-defaults-runner']){
  const before=reports['baseline-'+language+'-'+fixture],after=reports['candidate-'+language+'-'+fixture];assert.deepEqual(after,before,language+'/'+fixture+': actual published defaults changed');
  if(fixture==='legacy-defaults-runner')assert.equal(Object.keys(after).length,14);else{assert.equal(after.requests.length,2);assert(Object.keys(after.files).length>=4);}
  comparisons.push({language,fixture,identical:true,sha256:hash(Buffer.from(JSON.stringify(after)))});
 }
 return{languages:2,fixturesPerLanguage:2,comparisons};
}
const rows=[],children=[];
function launch(language,spec){
 const file=join(spec.work,'spec.json');fs.writeFileSync(file,JSON.stringify(spec),{flag:'wx'});
 const child=spawn(language==='ts'?process.execPath:python,[join(scripts,'index-worker.'+(language==='ts'?'mjs':'py')),file],{cwd:root,env:baseEnv,windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:30000});
 let stdout='',stderr='';child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);
 const completion=new Promise(done=>{child.once('error',error=>done({code:null,error:error.code,stdout,stderr}));child.once('close',code=>done({code,stdout,stderr}));});
 const record={child,completion};children.push(record);return record;
}
async function ready(work,nonce){
 const deadline=Date.now()+20000;
 for(;;){try{const value=JSON.parse(fs.readFileSync(join(work,'held.json'),'utf8'));assert.equal(value.nonce,nonce);return value;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(Date.now()>deadline)throw Error('Owned production writer did not publish');
  await new Promise(done=>setTimeout(done,10));
 }
}
function release(work,nonce){const target=join(work,'release.json'),temp=target+'.tmp';fs.writeFileSync(temp,JSON.stringify({nonce}));fs.renameSync(temp,target);}
try{
 for(const writer of['ts','py'])for(const variant of['populated','old-expiry-and-old-mtime','partial-owner-record']){
  const work=join(root,writer+'-'+variant),store=join(work,'store'),nonce=randomUUID(),key='published-lock-review';
  assert.equal(dirname(resolve(work)),resolve(root));fs.mkdirSync(work);fs.mkdirSync(store);
  fs.writeFileSync(join(work,'owned.json'),JSON.stringify({root:work,nonce}));
  const holder=launch(writer,{work,store,nonce,lockKey:key,action:'hold',ttlSeconds:60});
  let ownerPath,original;
  try{
   const actual=await ready(work,nonce),canonical=join(store,hash(key).slice(0,32)+'.json.lock');
   assert(fs.lstatSync(canonical).isDirectory());const names=fs.readdirSync(canonical);assert.equal(names.length,1);
   ownerPath=join(canonical,names[0]);original=fs.readFileSync(ownerPath);const owner=JSON.parse(original);
   assert.equal(owner.version,2);assert.equal(owner.pid,actual.pid);assert.deepEqual(owner.identity,actual.identity);
   process.kill(actual.pid,0); // read-only existence control for the nonce-bound actual worker
   if(variant==='old-expiry-and-old-mtime')fs.writeFileSync(ownerPath,JSON.stringify({...owner,expires_at:0})+'\n');
   if(variant==='partial-owner-record')fs.writeFileSync(ownerPath,'{"version":2,"pid":');
   if(variant!=='populated')fs.utimesSync(canonical,new Date(0),new Date(0));
   const snapshot=()=>({inode:fs.lstatSync(canonical).ino,files:fs.readdirSync(canonical).sort().map(name=>[name,fs.readFileSync(join(canonical,name),'hex')])});
   const before=snapshot();
   for(const reader of['ts','py']){
    const observed=oldProbe(reader,store,key,writer+'-'+variant);
    assert.equal(observed.native.callbacks,0);assert.equal(observed.native.failure?.code,'session_locked');
    assert.equal(observed.operations.length,0);assert.deepEqual(snapshot(),before);
    assert.equal(holder.child.exitCode,null);process.kill(actual.pid,0);
    rows.push({writer,reader,variant,production_writer:true,actual_owner_pid:actual.pid,callbacks:0,mutation_attempts:0,directory_unchanged:true,native:observed.native});
   }
  }finally{
   if(ownerPath&&original)fs.writeFileSync(ownerPath,original);
   release(work,nonce);const finished=await holder.completion;assert.equal(finished.code,0,JSON.stringify(finished));
  }
 }
 const controls=[];
 for(const reader of['ts','py'])for(const variant of['legacy-expired-file','legacy-torn-stamp']){
  const store=join(root,'control-'+reader+'-'+variant);fs.mkdirSync(store);const key='published-lock-review',canonical=join(store,hash(key).slice(0,32)+'.json.lock');
  fs.writeFileSync(canonical,variant==='legacy-expired-file'?'0\n':'123');fs.utimesSync(canonical,new Date(0),new Date(0));
  const observed=oldProbe(reader,store,key,'control-'+reader+'-'+variant),expected=reader==='py'&&variant==='legacy-torn-stamp'?0:1;
  assert.equal(observed.native.callbacks,expected);if(expected)assert(observed.operations.length>0);
  controls.push({reader,variant,callbacks:observed.native.callbacks,mutation_attempts:observed.operations.length,native:observed.native});
 }
 assert.equal(rows.length,12);assert.equal(controls.filter(row=>row.callbacks===1).length,3);
 const legacy_defaults=legacyDefaults();
 console.log(JSON.stringify({at:new Date().toISOString(),platform:process.platform,artifacts,rows,controls,root,rolling_upgrade_claimed:false,legacy_defaults}));
 console.log('Production published-worker proof passed: 12 protected rows; 0 callbacks; 0 mutation attempts; 3 active controls; native torn-stamp difference retained.');
}finally{
 for(const record of children)if(record.child.exitCode===null&&record.child.signalCode===null)record.child.kill('SIGTERM');
 await Promise.all(children.map(record=>record.completion));
}
