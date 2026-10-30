import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {requireEvidence} from './evidence-rules.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const allowDirty=process.argv.includes('--allow-dirty-source');
assert(process.argv.slice(2).every(flag=>flag==='--allow-dirty-source'),'Unknown evidence flag');
for(const key of ['PRISM_HARNESS_AUTOLOAD','PRISM_HARNESS_PHP_RUNNER','PRISM_HARNESS_TS','PYTHONPATH','PRISM_PYTHON_BINARY'])assert(process.env[key],'Missing explicit runtime location: '+key);
const work=fs.mkdtempSync(join(process.env.PRISM_EVIDENCE_ROOT??os.tmpdir(),'prism-harness-runtime-'));
const expectedRefs=JSON.parse(fs.readFileSync(join(here,'runtime-refs.json')));
const env={};
for(const[key,value]of Object.entries(process.env))if(/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL)$/i.test(key))env[key]=value;
for(const key of ['PRISM_HARNESS_AUTOLOAD','PRISM_HARNESS_PHP_RUNNER','PRISM_HARNESS_TS','PYTHONPATH','PRISM_PYTHON_BINARY','PRISM_PHP_BINARY'])if(process.env[key])env[key]=process.env[key];
const heads={};
for(const[name,cwd]of Object.entries({php:env.PRISM_HARNESS_PHP_RUNNER,ts:env.PRISM_HARNESS_TS,py:dirname(env.PYTHONPATH)})){
 const head=spawnSync('git',['-C',cwd,'rev-parse','HEAD'],{env,encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(head.status,0,'Cannot bind runtime head: '+name);heads[name]=head.stdout.trim();
 if(!allowDirty){
  assert.equal(heads[name],expectedRefs[name].head,'Wrong reviewed runtime commit: '+name);
  const clean=spawnSync('git',['-C',cwd,'status','--porcelain','--untracked-files=all'],{env,encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(clean.status,0,'Cannot inspect runtime tree: '+name);assert.equal(clean.stdout.trim(),'','Uncommitted runtime files: '+name);
 }
}
const rows=[];
for(const[name,script,args]of[
 ['addresses','address-corpus.mjs',[]],
 ['paged-index','index-corpus.mjs',[]],
 ['coexistence','coexistence-corpus.mjs',[]],
 ['production-mutants','coexistence-sabotage.mjs',[]],
 ['live-expiry','index-workers.mjs',['--live-expiry']],
 ['recovery-races','owner-lock-workers.mjs',[]],
 ['mixed-index-workers','index-workers.mjs',[]],
 ['published-old-workers','published-lock-production.mjs',[]],
 ['published-current-ports','published-ports.mjs',[]],
]){
 const directory=join(work,name);if(name!=='production-mutants')fs.mkdirSync(directory);
 const selected={...env,PRISM_COEXIST_WORK:directory,PRISM_COEXIST_OUTPUT:join(directory,'php.jsonl'),PRISM_COEXIST_REPORT:join(directory,'native.json'),PRISM_INDEX_WORK:directory,PRISM_INDEX_OUTPUT:join(directory,'index-php.jsonl'),PRISM_PUBLISHED_LOCK_WORK:directory};
 const log=join(work,name+'.log'),fd=fs.openSync(log,'wx');
 const result=spawnSync(process.execPath,[join(here,script),...args],{cwd:here,env:selected,stdio:['ignore',fd,fd],timeout:name==='production-mutants'?600000:300000,windowsHide:true,shell:false});fs.closeSync(fd);
 let verdictError=null;
 if(!result.error&&result.status===0)try{requireEvidence(name,fs.readFileSync(log,'utf8'));}catch(error){verdictError=error.message;}
 const row={name,exit:result.status,error:result.error?.code??null,verdictError,log,sha256:createHash('sha256').update(fs.readFileSync(log)).digest('hex')};rows.push(row);console.log(JSON.stringify(row));
 if(result.error||result.status!==0||verdictError)break;
}
const status=rows.length===9&&rows.every(row=>row.exit===0&&row.error===null&&row.verdictError===null)?'PASS':'FAIL';
const report={at:new Date().toISOString(),scope:'cross-port production source and integrity-pinned published TS0.9.2/Python0.4.2 evidence; PHP0.20.1 artifact acceptance recorded separately',inspectionGuarantee:'No handlers, model/provider requests, new entries or logical state changes; ordinary expired-value physical cleanup preserved',allowDirtySource:allowDirty,heads,platform:process.platform,status,work,rows};
fs.writeFileSync(join(work,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({report:join(work,'report.json'),status}));
if(status!=='PASS')process.exitCode=1;
