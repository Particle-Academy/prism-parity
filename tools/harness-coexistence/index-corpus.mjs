import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const cwd=dirname(fileURLToPath(import.meta.url)),specs=JSON.parse(fs.readFileSync(join(cwd,'index-cases.json')));
assert.equal(specs.format,'harness-address-index-v1');assert.equal(specs.cases.length,3);
const env={};
for(const [key,value] of Object.entries(process.env))if(/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL|PYTHONPATH|PRISM_HARNESS_AUTOLOAD|PRISM_HARNESS_TS|PRISM_INDEX_WORK|PRISM_INDEX_OUTPUT)$/i.test(key))env[key]=value;
for(const key of ['PRISM_HARNESS_AUTOLOAD','PRISM_HARNESS_TS','PRISM_INDEX_WORK','PRISM_INDEX_OUTPUT'])assert(env[key],`Missing runtime location: ${key}`);
const commands={php:[process.env.PRISM_PHP_BINARY??'php',[join(process.env.PRISM_HARNESS_PHP_RUNNER,'vendor/bin/phpunit'),'-c',join(cwd,'index-phpunit.xml')]],ts:[process.execPath,[join(cwd,'index-runner.mjs')]],py:[process.env.PRISM_PYTHON_BINARY??'python',[join(cwd,'index-runner.py')]]};
const reports={};
for(const [language,[command,args]] of Object.entries(commands)){
  const child=spawnSync(command,args,{cwd,env,encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024,windowsHide:true});
  if(child.status!==0||child.error)throw Error(`Index ${language} runner failed: ${child.stdout}\n${child.stderr}`);
  const rows=language==='php'?fs.readFileSync(env.PRISM_INDEX_OUTPUT,'utf8').trim().split(/\r?\n/).map(JSON.parse):JSON.parse(child.stdout);
  assert.equal(rows.length,specs.cases.length,`${language}: no skipped or missing scenarios`);
  for(let i=0;i<rows.length;i++){assert.equal(rows[i].id,specs.cases[i].id);assert.deepEqual(rows[i].result,specs.cases[i].expected,`${language}/${rows[i].id}`);}
  reports[language]=rows;
}
assert.equal(JSON.stringify(reports.php),JSON.stringify(reports.ts),'Byte-identical PHP/TS index reports');
assert.equal(JSON.stringify(reports.php),JSON.stringify(reports.py),'Byte-identical PHP/Py index reports');
console.log(JSON.stringify({mode:'development, not published acceptance',languages:3,casesPerLanguage:3,skipped:0,reports}));
