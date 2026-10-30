import fs from 'node:fs';
import assert from 'node:assert/strict';
import {join,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const packageRoot=process.env.PRISM_HARNESS_TS,root=process.argv[2],here=dirname(fileURLToPath(import.meta.url));
const {FileSessionStore,Session}=await import(pathToFileURL(join(packageRoot,'dist/index.js')));
const rows=[];
function fixture(name){const directory=join(root,name);fs.mkdirSync(directory);const store=new FileSessionStore(directory),session=new Session({participant:{type:'test',id:'callback'},scope:'callback',ephemeral:store,durable:store}),lock=join(directory,createHash('sha256').update(session.key()).digest('hex').slice(0,32)+'.json.lock');return{directory,session,lock};}
for(const code of['EEXIST','EPERM','EACCES','EBUSY']){
 const{directory,session,lock}=fixture(code),counted=join(directory,'counted'),collision=join(directory,'exists');fs.writeFileSync(collision,'existing');let callbacks=0,original,failure;
 try{await session.lock(()=>{callbacks++;fs.appendFileSync(counted,'effect\n');try{if(code==='EEXIST')fs.writeFileSync(collision,'new',{flag:'wx'});else throw Object.assign(new Error('callback failure'),{code});}catch(error){original??=error;throw error;}},10,0.12);}catch(error){failure=error;}
 assert.equal(callbacks,1);assert.equal(fs.readFileSync(counted,'utf8'),'effect\n');assert.equal(failure,original);assert.equal(failure.code,code);assert(!fs.existsSync(lock));rows.push({code,callbacks,writes:1,originalError:true,released:true});
}
const{directory,session,lock}=fixture('waiter');let outcome;
await session.lock(async()=>{
 const child=spawn(process.execPath,[join(here,'published-waiter.mjs'),join(packageRoot,'dist/index.js'),directory],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],timeout:20000});let stdout='',stderr='';child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);
 outcome=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>done({code,signal,stdout,stderr}));});
 assert.equal(outcome.code,0,outcome.stderr);assert.equal(outcome.signal,null);assert.deepEqual(JSON.parse(outcome.stdout),{callbacks:0,code:'session_locked'});assert(fs.lstatSync(lock).isDirectory());
});assert(!fs.existsSync(lock));
console.log(JSON.stringify({checks:5,callbackRows:rows,waiter:{callbacks:0,code:'session_locked',exit:outcome.code,noHostKeepalive:true,holderAliveThroughout:true}}));
