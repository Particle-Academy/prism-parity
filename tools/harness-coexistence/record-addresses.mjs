import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here=dirname(fileURLToPath(import.meta.url)),file=join(here,'addresses.json');
assert(process.argv.slice(2).every(flag=>flag==='--write'),'Only the explicit --write option is supported');
const write=process.argv.includes('--write'),source=process.env.PRISM_HARNESS_PHP_RUNNER;
assert(source&&process.env.PRISM_HARNESS_AUTOLOAD,'Select the reviewed PHP reference explicitly');
const refs=JSON.parse(fs.readFileSync(join(here,'runtime-refs.json')));
function git(args){const p=spawnSync('git',['-C',source,...args],{encoding:'utf8',windowsHide:true,shell:false,timeout:10000});assert.equal(p.status,0,p.stderr);return p.stdout.trim();}
const head=git(['rev-parse','HEAD']);assert.equal(head,refs.php.head);assert.equal(git(['status','--porcelain','--untracked-files=all']),'');
const input=JSON.parse(fs.readFileSync(file));assert.equal(input.cases.length,46);
const env={};for(const[key,value]of Object.entries(process.env))if(/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL|PRISM_HARNESS_AUTOLOAD)$/i.test(key))env[key]=value;
const child=spawnSync(process.env.PRISM_PHP_BINARY??'php',[join(here,'address-runner.php'),file],{env,encoding:'utf8',windowsHide:true,shell:false,timeout:60000});assert.equal(child.status,0,child.stderr);
const native=JSON.parse(child.stdout);assert.equal(native.length,46);
for(const[index,row]of native.entries()){
 assert.equal(row.id,input.cases[index].id);
 // The approved contract expectations are an independent refusal/change guard.
 // Never turn a reference disagreement into an automatically blessed golden.
 assert.deepEqual(row.result,input.cases[index].expected,row.id+': reference disagrees with the approved contract');
 input.cases[index].expected=row.result;
}
if(write)fs.writeFileSync(file,JSON.stringify(input,null,2)+'\n');
const sha=value=>createHash('sha256').update(value).digest('hex');
console.log(JSON.stringify({recordedBy:'actual PHP reference execution; independent approved contract retained',reference:{repository:refs.php.repository,head,tree:git(['rev-parse','HEAD^{tree}']),runnerSha256:sha(fs.readFileSync(join(here,'address-runner.php')))},wrote:write,cases:46,skipped:0,nativeRows:native,fixtureSha256:sha(fs.readFileSync(file))}));
