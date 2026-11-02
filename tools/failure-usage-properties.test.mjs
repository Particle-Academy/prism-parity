import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {failureUsageViolations} from './streaming/failure-usage.mjs';
import {failureUsageControls,failureUsageMutants} from './streaming/failure-usage-controls.mjs';

const cases=JSON.parse(readFileSync(new URL('../suites/stream-failure-usage/cases.json',import.meta.url),'utf8')).cases;
const controls=failureUsageControls(cases);
for(const row of controls) test('executed PHP output satisfies independent properties: '+row.id,()=>{
  assert.deepEqual(failureUsageViolations(row.trace,row.properties),[]);
});
for(const row of failureUsageMutants(controls)) test('actual-output mutant detected: '+row.name,()=>{
  assert.notDeepEqual(failureUsageViolations(row.trace,row.properties),[],row.name);
});
