import fs from 'node:fs';
import assert from 'node:assert/strict';
import {join,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {requireEvidence} from './evidence-rules.mjs';
const here=dirname(fileURLToPath(import.meta.url)),root=process.env.PRISM_COEXIST_WORK;
assert(root&&fs.statSync(root).isDirectory());
const pins=JSON.parse(fs.readFileSync(join(here,'published-ports.json'))),refs=JSON.parse(fs.readFileSync(join(here,'runtime-refs.json'))),python=process.env.PRISM_PYTHON_BINARY;
assert(python&&process.env.PRISM_HARNESS_TS&&process.env.PYTHONPATH);
const hash=(b,algorithm='sha256',encoding='hex')=>createHash(algorithm).update(b).digest(encoding),lf=b=>Buffer.from(b.toString('utf8').replaceAll('\r\n','\n'));
const env={};for(const[k,v]of Object.entries(process.env))if(/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL|PRISM_HARNESS_AUTOLOAD|PRISM_HARNESS_PHP_RUNNER|PRISM_PHP_BINARY|PRISM_PYTHON_BINARY)$/i.test(k))env[k]=v;
env.PYTHONIOENCODING='utf-8';
const report={scope:'published TS/Python artifacts and pinned PHP0.20.1 source; PHP artifact acceptance recorded separately',platform:process.platform,artifacts:{},groups:[],optIns:[],callback:null,windowsBarrier:null};
const save=()=>fs.writeFileSync(join(root,'published-report.json'),JSON.stringify(report,null,2));
function inventory(directory){const out={};function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.name==='__pycache__')continue;const file=join(dir,e.name);if(e.isDirectory())visit(file);else out[relative(directory,file).replaceAll('\\','/')]=hash(lf(fs.readFileSync(file)));}}visit(directory);return out;}
function run(name,exe,args,selected=env,timeout=300000){const log=join(root,name+'.log'),fd=fs.openSync(log,'wx'),p=spawnSync(exe,args,{cwd:here,env:selected,shell:false,windowsHide:true,stdio:['ignore',fd,fd],timeout});fs.closeSync(fd);assert(!p.error,name+': '+p.error?.message);assert.equal(p.status,0,name+'\n'+fs.readFileSync(log,'utf8').slice(-4000));return{log,sha256:hash(fs.readFileSync(log)),output:fs.readFileSync(log,'utf8')};}
for(const language of['ts','py']){
 const pin=pins[language];assert.equal(pin.head,refs[language].head);
 const response=await fetch(pin.url,{signal:AbortSignal.timeout(30000)});assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert(bytes.length<20_000_000);assert.equal(hash(bytes),pin.sha256);
 if(language==='ts'){const[algorithm,digest]=pin.integrity.split('-');assert.equal(algorithm,'sha512');assert.equal(hash(bytes,algorithm,'base64'),digest);}
 const archive=join(root,language+'.archive');fs.writeFileSync(archive,bytes,{flag:'wx'});
 const extraction=run('extract-'+language,python,[join(here,'extract-published.py'),archive,join(root,language),language]);
 const files=JSON.parse(extraction.output).files,published=join(root,language,language==='ts'?'package/dist':'prism_harness'),source=language==='ts'?join(process.env.PRISM_HARNESS_TS,'dist'):join(process.env.PYTHONPATH,'prism_harness');
 const runtime=inventory(published);assert.deepEqual(runtime,inventory(source),language+': complete published runtime must equal the reviewed release');
 assert.equal(Object.keys(runtime).length,language==='ts'?60:31);
 if(language==='ts')assert.equal(JSON.parse(fs.readFileSync(join(root,'ts/package/package.json'))).version,pin.version);
 else assert(fs.readFileSync(join(root,'py/prism_ai_harness-0.4.2.dist-info/METADATA'),'utf8').includes('\nVersion: 0.4.2\n'));
 report.artifacts[language]={...pin,files:Object.keys(files).length,runtimeFiles:Object.keys(runtime).length,runtime,unchanged:false};save();
}
Object.assign(env,{PRISM_HARNESS_TS:join(root,'ts/package'),PYTHONPATH:join(root,'py')});
if(process.platform==='win32'){const barrier=run('barrier-sharing',python,[join(here,'barrier-sharing.py'),root]);report.windowsBarrier=JSON.parse(barrier.output);assert.equal(report.windowsBarrier.workerDeniedBarrierRead,true);assert.equal(report.windowsBarrier.status,'PASS');}
else report.windowsBarrier={status:'not-applicable',platform:process.platform};save();
for(const[name,script,args]of[['addresses','address-corpus.mjs',[]],['paged-index','index-corpus.mjs',[]],['coexistence','coexistence-corpus.mjs',[]],['live-expiry','index-workers.mjs',['--live-expiry']],['recovery-races','owner-lock-workers.mjs',[]],['mixed-index-workers','index-workers.mjs',[]],['published-old-workers','published-lock-production.mjs',[]]]){
 const directory=join(root,name);fs.mkdirSync(directory);const selected={...env,PRISM_COEXIST_WORK:directory,PRISM_COEXIST_OUTPUT:join(directory,'php.jsonl'),PRISM_COEXIST_REPORT:join(directory,'native.json'),PRISM_INDEX_WORK:directory,PRISM_INDEX_OUTPUT:join(directory,'php-index.jsonl'),PRISM_PUBLISHED_LOCK_WORK:directory};
 const result=run(name,process.execPath,[join(here,script),...args],selected);requireEvidence(name,result.output);report.groups.push({name,log:result.log,sha256:result.sha256,passed:true});save();
}
for(const language of['ts','py']){
 const directory=join(root,'opt-in-'+language);fs.mkdirSync(directory);const result=run('opt-in-'+language,language==='ts'?process.execPath:python,[join(here,'opt-in-runner.'+(language==='ts'?'mjs':'py')),directory]);const value=JSON.parse(result.output);assert.deepEqual(value,{language,checks:8,collisions:3,outsideRefusals:2,requests:[['inside'],[]],handlers:0});report.optIns.push(value);save();
}
const directory=join(root,'callback');fs.mkdirSync(directory);const callback=run('callback',process.execPath,[join(here,'published-callback.mjs'),directory]);report.callback=JSON.parse(callback.output);assert.equal(report.callback.checks,5);save();
for(const language of['ts','py']){const runtime=inventory(join(root,language,language==='ts'?'package/dist':'prism_harness'));assert.deepEqual(runtime,report.artifacts[language].runtime);report.artifacts[language].unchanged=true;}
report.status='PASS';save();console.log(JSON.stringify(report));
