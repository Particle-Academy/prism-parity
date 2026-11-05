import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compile} from '@particle-academy/fancy-schema';

const validate=compile(JSON.parse(readFileSync(new URL('../schema/cases.schema.json',import.meta.url),'utf8')));
const fixture=()=>JSON.parse(readFileSync(new URL('../suites/perplexity-agent-response/cases.json',import.meta.url),'utf8'));

test('all forty-five lifecycle rows and the unchanged legacy projection validate',()=>{
 const doc=fixture();assert.equal(doc.cases.length,45);assert.equal(validate(doc).valid,true);
 assert(doc.cases.slice(0,17).every(c=>!Object.hasOwn(c,'operation')&&!Object.hasOwn(c.parsed.php,'incomplete_reason')));
 assert.deepEqual(doc.cases.find(c=>c.id==='agent-0026').body.response_id,{});
 assert.deepEqual(doc.cases.find(c=>c.id==='agent-0025').body.response_id,[]);
});
for(const[name,mutate]of[
 ['unknown operation',c=>{c.operation='destroy';}],
 ['non-boolean projection flag',c=>{c.project_incomplete_reason='true';}],
 ['object reason',c=>{c.parsed.php.incomplete_reason={reason:'hidden'};}],
 ['array reason',c=>{c.parsed.php.incomplete_reason=[];}],
 ['number reason',c=>{c.parsed.php.incomplete_reason=42;}],
 ['undeclared parsed data',c=>{c.parsed.php.private='provider diagnostic';}],
])test('lifecycle schema rejects '+name,()=>{const doc=fixture();mutate(doc.cases.find(c=>c.id==='agent-0031'));assert.equal(validate(doc).valid,false);});
