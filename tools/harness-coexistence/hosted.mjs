import assert from 'node:assert/strict';
import fs from 'node:fs';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../..');
const refs=JSON.parse(fs.readFileSync(join(here,'runtime-refs.json')));
const paths=Object.fromEntries(Object.entries(refs).map(([name,ref])=>[name,resolve(root,ref.path)]));
function executable(command,args) {
 const result=spawnSync(command,args,{encoding:'utf8',timeout:10000,windowsHide:true,shell:false});
 assert(!result.error&&result.status===0,'Cannot locate '+command);
 const path=result.stdout.trim();assert(path&&fs.statSync(path).isFile(),'Invalid executable '+command);return path;
}
const php=executable('php',['-r','echo PHP_BINARY;']);
const python=executable('python',['-c','import sys; print(sys.executable)']);
const result=spawnSync(process.execPath,[join(here,'ci.mjs')],{
 cwd:root,stdio:'inherit',windowsHide:true,shell:false,timeout:1200000,
 env:{...process.env,PRISM_HARNESS_AUTOLOAD:join(paths.php,'vendor/autoload.php'),
  PRISM_HARNESS_PHP_RUNNER:paths.php,PRISM_HARNESS_TS:paths.ts,
  PYTHONPATH:join(paths.py,'src'),PRISM_PHP_BINARY:php,PRISM_PYTHON_BINARY:python,
  PRISM_EVIDENCE_ROOT:process.env.RUNNER_TEMP},
});
assert(!result.error&&result.status===0,'Exact-ref source evidence failed');
