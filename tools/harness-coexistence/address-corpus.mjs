import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
const cwd=dirname(fileURLToPath(import.meta.url)),baseline=process.argv.includes('--baseline');
if(process.argv.slice(2).some(flag=>flag!=='--baseline'))throw Error('Unknown corpus flag');
const input=JSON.parse(fs.readFileSync(join(cwd,'addresses.json')));
assert.equal(input.format,'harness-agent-addresses-v1');assert.equal(input.cases.length,46);
assert.equal(new Set(input.cases.map(row=>row.id)).size,46);
const env={};
for(const [key,value] of Object.entries(process.env))if(/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL|PYTHONPATH|PRISM_HARNESS_AUTOLOAD|PRISM_HARNESS_TS)$/i.test(key))env[key]=value;
for(const key of ['PRISM_HARNESS_AUTOLOAD','PRISM_HARNESS_TS'])if(!env[key])throw Error(`Missing explicit runtime location: ${key}`);
const commands={php:[process.env.PRISM_PHP_BINARY??'php',[join(cwd,'address-runner.php'),join(cwd,'addresses.json')]],ts:[process.execPath,[join(cwd,'address-runner.mjs'),join(cwd,'addresses.json')]],py:[process.env.PRISM_PYTHON_BINARY??'python',[join(cwd,'address-runner.py'),join(cwd,'addresses.json')]]};
const reports={};
for(const [language,[command,args]] of Object.entries(commands)){
  const child=spawnSync(command,args,{cwd,env,encoding:'utf8',timeout:60000,windowsHide:true,maxBuffer:8*1024*1024});
  if(child.status!==0||child.error)throw Error(`Address runner ${language} failed: ${child.stderr}`);
  const rows=JSON.parse(child.stdout);assert.equal(rows.length,input.cases.length,`${language}: no omitted controls`);
  for(let index=0;index<rows.length;index++){
    const expected=input.cases[index],actual=rows[index];assert.equal(actual.id,expected.id);
    if(!baseline)assert.deepEqual(actual.result,expected.expected,`${language}/${expected.id}`);
    else if(expected.input.agent!==null)assert.deepEqual(actual.result,{error:'unsupported_named_namespace'},`${language}/${expected.id}: old feature probe`);
    else{
      assert.equal(actual.result.session_key,expected.expected.session_key,`${language}/${expected.id}: published legacy session key`);
      if(language==='php')assert.equal(actual.result.thread_key,expected.expected.thread_key,`${language}/${expected.id}: published legacy thread key`);
    }
  }
  reports[language]={cases:rows.length,baselineOnly:baseline,rows};
}
console.log(JSON.stringify({mode:baseline?'published baseline: 9 existing controls plus 37 absent-feature probes':'development, not published conformance',languages:3,casesPerLanguage:46,skipped:0,reports}));
