import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {compile} from '@particle-academy/fancy-schema';
import {gates} from './gate-contracts.mjs';
const root=new URL('../',import.meta.url);
const check=compile(JSON.parse(fs.readFileSync(new URL('schema/cases.schema.json',root),'utf8')));
const original=JSON.parse(fs.readFileSync(new URL('suites/harness-tool-list-default/cases.json',root),'utf8'));
test('the recorded native tool-list document is valid',()=>assert.equal(check(original).valid,true));
for(const [name,mutate] of[
 ['missing PHP stream',d=>{delete d.cases[0].result.php.stream;}],
 ['missing port language',d=>{delete d.cases[0].result.py;}],
 ['invented stream alias',d=>{d.cases[0].result.ts.stream=d.cases[0].result.ts.structured;}],
 ['unknown authority flag',d=>{d.cases[0].allowEverything=true;}],
 ['scalar requested names',d=>{d.cases[0].names='outside';}],
 ['missing independent expectation',d=>{delete d.cases[0].expected;}],
 ['missing native request record',d=>{delete d.cases[0].result.php.send.requests;}],
 ['malformed native error',d=>{d.cases[0].result.ts.send.error={success:true};}],
]) test('tool-list schema refuses '+name,()=>{const d=structuredClone(original);mutate(d);assert.equal(check(d).valid,false);});
test('the native gate refuses empty, reduced and skipped evidence',()=>{
 assert.match('OK (22 tests, 110 assertions)',gates.harnessToolList.verdict);
 for(const text of['','OK (0 tests, 0 assertions)','OK (21 tests, 110 assertions)','OK, but some tests were skipped!\nTests: 22, Assertions: 110, Skipped: 1.'])assert.doesNotMatch(text,gates.harnessToolList.verdict);
});
