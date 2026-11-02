#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {failureUsageViolations} from './streaming/failure-usage.mjs';
import {failureUsageControls,failureUsageMutants} from './streaming/failure-usage-controls.mjs';

assert.equal(process.argv.length,4,'Usage: node tools/failure-usage-discrimination.mjs --php <binary>');
assert.equal(process.argv[2],'--php');
const cases=JSON.parse(readFileSync(new URL('../suites/stream-failure-usage/cases.json',import.meta.url),'utf8')).cases;
const controls=failureUsageControls(cases),mutants=failureUsageMutants(controls),rows=[...controls,...mutants];
const result=spawnSync(process.argv[3],[fileURLToPath(new URL('./streaming/check-failure-properties.php',import.meta.url))],{
  input:JSON.stringify(rows),encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024,windowsHide:true,
});
assert.equal(result.status,0,result.stderr||result.error?.message);
assert.equal(result.stderr,'','PHP property checks must run without warnings');
const php=JSON.parse(result.stdout);assert.equal(php.length,rows.length);
for(const [index,row]of rows.entries()){
  const js=failureUsageViolations(row.trace,row.properties),actual=php[index];
  assert.equal(actual.id,row.id);assert.equal(actual.name,row.name??null);
  if(index<controls.length){assert.deepEqual(js,[],row.id);assert.deepEqual(actual.violations,[],row.id);}
  else {assert(js.length>0,'JS missed '+row.name);assert(actual.violations.length>0,'PHP missed '+row.name);}
}
console.log(`Failure-usage discrimination passed: ${controls.length} executed controls; ${mutants.length} actual-output mutants detected by both PHP and JavaScript predicates.`);
