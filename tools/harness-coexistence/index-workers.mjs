import fs from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const scripts=dirname(fileURLToPath(import.meta.url)),pkg=await import(pathToFileURL(process.env.PRISM_HARNESS_TS+'/dist/index.js'));
const env={};for(const [key,value] of Object.entries(process.env))if(/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL|PYTHONPATH|PRISM_HARNESS_TS)$/i.test(key))env[key]=value;
const children=[];
function launch(language,spec){
  const file=join(spec.work,`${spec.action}-${spec.worker??language}-${randomUUID()}.json`);fs.writeFileSync(file,JSON.stringify(spec));
  const child=spawn(language==='ts'?process.execPath:process.env.PRISM_PYTHON_BINARY,[join(scripts,`index-worker.${language==='ts'?'mjs':'py'}`),file],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
  const completion=new Promise(done=>{child.once('error',error=>done({code:null,error:error.code,stdout,stderr}));child.once('close',(code,signal)=>done({code,signal,stdout,stderr}));});
  const record={child,completion};children.push(record);return record;
}
async function finish(record){const result=await record.completion;assert.equal(result.code,0,JSON.stringify(result));return JSON.parse(result.stdout);}
async function wait(work,name,nonce){const deadline=Date.now()+20000;while(true){try{assert.equal(JSON.parse(fs.readFileSync(join(work,name))).nonce,nonce);return;}catch(error){if(error.code!=='ENOENT')throw error;}if(Date.now()>deadline)throw Error('Owned worker handshake timed out');await new Promise(r=>setTimeout(r,10));}}
const reports=[];
try{
  if(process.argv.includes('--live-expiry')){
    for(const [language,contenderLanguage,mixedSlots] of [['ts','ts',false],['py','py',false],['ts','ts',true],['py','py',true],['ts','py',true],['py','ts',true]]){
      const work=join(process.env.PRISM_INDEX_WORK,`expiry-${language}-${contenderLanguage}-${mixedSlots}`),storePath=join(work,'store'),nonce=randomUUID();
      fs.mkdirSync(work);fs.mkdirSync(storePath);fs.writeFileSync(join(work,'owned.json'),JSON.stringify({root:work,nonce}));
      const common={work,store:storePath,nonce,lockKey:'held-past-expiry',mixedSlots};
      const holder=launch(language,{...common,action:'hold',ttlSeconds:1});await wait(work,'held.json',nonce);
      await new Promise(done=>setTimeout(done,1200));
      const contender=await finish(launch(contenderLanguage,{...common,action:'contend'}));
      const alive=holder.child.exitCode===null;
      fs.writeFileSync(join(work,'release.json.tmp'),JSON.stringify({nonce}));fs.renameSync(join(work,'release.json.tmp'),join(work,'release.json'));
      const held=await finish(holder);assert.deepEqual(contender.identity,held.identity);
      reports.push({language,contender_language:contenderLanguage,mixed_slots:mixedSlots,holder_alive:alive,contender_callbacks:contender.callbacks,contender_error:contender.error_code,identity:held.identity,holder_pid:held.pid,contender_pid:contender.pid});
    }
    console.log(JSON.stringify({case:'live holder past expiry',reports}));
    assert(reports.every(row=>row.holder_alive&&row.contender_callbacks===0&&row.contender_error==='session_locked'),'A live holder must not lose exclusion when time passes');
  }else{
  for(const [name,languages] of [['ts',['ts','ts']],['py',['py','py']],['mixed',['ts','py']]]){
    const work=join(process.env.PRISM_INDEX_WORK,`workers-${name}`),storePath=join(work,'store'),nonce=randomUUID();
    assert.equal(dirname(resolve(work)),resolve(process.env.PRISM_INDEX_WORK));fs.mkdirSync(work);fs.mkdirSync(storePath);
    fs.writeFileSync(join(work,'owned.json'),JSON.stringify({root:work,nonce}));
    const mark=name=>{const target=join(work,name),temporary=`${target}.${process.pid}.tmp`;fs.writeFileSync(temporary,JSON.stringify({nonce}));fs.renameSync(temporary,target);};
    const lockKey=`harness-address-index:v1:${createHash('sha256').update(JSON.stringify(['workers','1'])).digest('hex')}`;
    const common={work,store:storePath,nonce,lockKey};
    const holder=launch(languages[0],{...common,action:'hold'});await wait(work,'held.json',nonce);
    const refused=await finish(launch(languages[1],{...common,action:'contend'}));
    assert.equal(refused.callbacks,0);assert.equal(refused.error_code,'session_locked');
    mark('release.json');await finish(holder);
    const admitted=await finish(launch(languages[1],{...common,action:'free'}));assert.equal(admitted.callbacks,1);assert.equal(admitted.error_code,null);
    const workers=languages.map((language,index)=>launch(language,{...common,action:'index',worker:String(index)}));
    await Promise.all([wait(work,'ready-0.json',nonce),wait(work,'ready-1.json',nonce)]);mark('go.json');await Promise.all(workers.map(finish));
    const store=new pkg.FileSessionStore(storePath),index=new pkg.StoreAddressIndex(store),participant={type:'workers',id:'1'},entries=[];
    let cursor=0;do{const page=await index.page(participant,cursor);entries.push(...page.entries);cursor=page.next_cursor;}while(cursor!==null);
    const harness=new pkg.PrismHarness({drivers:{owned:()=>store},stores:{ephemeral:'owned',durable:'owned'}});
    let isolated=true;for(let worker=0;worker<2;worker++)for(let i=0;i<50;i++)isolated&&=await harness.forAgent('support').for(participant).session(`worker:${worker}:${i}`).mode()===String(worker);
    const result={case:name,contender_callbacks:refused.callbacks,contender_error:refused.error_code,after_release_callbacks:admitted.callbacks,indexed_addresses:entries.length,positions_dense:entries.every((row,i)=>row.position===i),unique_addresses:new Set(entries.map(row=>row.address_key)).size===101,state_isolated:isolated};
    assert.deepEqual(result,{case:name,contender_callbacks:0,contender_error:'session_locked',after_release_callbacks:1,indexed_addresses:101,positions_dense:true,unique_addresses:true,state_isolated:true});reports.push(result);
  }
  for(const languages of [['ts','ts'],['py','py'],['ts','py'],['py','ts']]){
    const name=`memory-files-${languages.join('-')}`,work=join(process.env.PRISM_INDEX_WORK,name),storePath=join(work,'store'),nonce=randomUUID();
    assert.equal(dirname(resolve(work)),resolve(process.env.PRISM_INDEX_WORK));fs.mkdirSync(work);fs.mkdirSync(storePath);
    fs.writeFileSync(join(work,'owned.json'),JSON.stringify({root:work,nonce}));
    const common={work,store:storePath,nonce,mixedSlots:true};
    const holder=launch(languages[0],{...common,action:'hold'});await wait(work,'held.json',nonce);
    const refused=await finish(launch(languages[1],{...common,action:'contend'}));
    const target=join(work,'release.json');fs.writeFileSync(`${target}.tmp`,JSON.stringify({nonce}));fs.renameSync(`${target}.tmp`,target);await finish(holder);
    const admitted=await finish(launch(languages[1],{...common,action:'free'}));
    const result={case:name,contender_callbacks:refused.callbacks,contender_error:refused.error_code,after_release_callbacks:admitted.callbacks};
    assert.deepEqual(result,{case:name,contender_callbacks:0,contender_error:'session_locked',after_release_callbacks:1});reports.push(result);
  }
  console.log(JSON.stringify({mode:'development',separate_processes:true,reports}));
  }
}finally{
  for(const record of children)if(record.child.exitCode===null)record.child.kill();
  await Promise.all(children.map(record=>record.completion));
}
