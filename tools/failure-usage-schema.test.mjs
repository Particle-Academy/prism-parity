import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {compile} from '@particle-academy/fancy-schema';
import {failureUsageCaseFailures,failureUsageViolations} from './streaming/failure-usage.mjs';
const schema=compile(JSON.parse(readFileSync(new URL('../schema/cases.schema.json',import.meta.url),'utf8')));
const fixture=()=>JSON.parse(readFileSync(new URL('../suites/stream-failure-usage/cases.json',import.meta.url),'utf8'));
test('dedicated failure-usage document validates without widening legacy stream shapes',()=>{assert.equal(schema(fixture()).valid,true);assert.deepEqual(failureUsageCaseFailures(fixture(),{allowGenerate:true}),[]);});
for(const[name,mutate]of[
 ['unknown provider',r=>{r.failure_stream.provider='unknown';}],['unknown fault',r=>{r.failure_stream.attempts[0].responses[0].fault='ignored';}],
 ['invalid byte encoding',r=>{r.failure_stream.attempts[0].responses[0].encoding='text';}],['malformed base64',r=>{r.failure_stream.attempts[0].responses[0].chunks=['!bad'];}],
 ['negative count',r=>{r.properties.requests=-1;}],['invented scope',r=>{r.properties.attempts[0].failure_usage.scope='generation';}],
 ['missing usage field',r=>{delete r.properties.attempts[0].failure_usage.usage.cost;}],['empty reported mask',r=>{r.properties.attempts[0].failure_usage.reported_fields=[];}],
 ['duplicate mask',r=>{r.properties.attempts[0].failure_usage.reported_fields=['prompt_tokens','prompt_tokens'];}],['hidden usage content',r=>{r.properties.attempts[0].failure_usage.private='provider diagnostic';}],
 ['wrong failure status',r=>{r.properties.attempts[0].failure_usage.status='final';}],['completed-step accounting',r=>{r.properties.attempts[0].failure_usage.includes_completed_steps=true;}],
 ['nullable required token count',r=>{r.properties.attempts[0].failure_usage.usage.prompt_tokens=null;}],
])test('schema rejects '+name,()=>{const d=fixture(),row=d.cases.find(x=>x.id==='fau-0006');mutate(row);assert.equal(schema(d).valid,false);});
for(const[name,mutate]of[
 ['spread of G214 waiver',d=>{d.cases[0].properties.native_differences=d.cases[3].properties.native_differences;}],
 ['missing G214 declaration',d=>{delete d.cases[3].properties.native_differences;}],
 ['skipped shared native lane',d=>{d.cases[0].skip={ts:'not implemented'};}],
 ['unbounded constant tool',d=>{d.cases.find(x=>x.failure_stream.mode==='continuation').failure_stream.owned_tool.result='arbitrary';}],
 ['implicit max steps',d=>{d.cases[0].builder=d.cases[0].builder.filter(x=>x.call!=='withMaxSteps');}],
 ['faked request count',d=>{d.cases[0].properties.requests=2;}],
 ['native channel waiver spread',d=>{d.cases[0].properties.native_outcomes=d.cases[6].properties.native_outcomes;}],
 ['native accounting override',d=>{d.cases[6].properties.native_outcomes.ts.failure_usage=null;}],
 ['continuation gap spread',d=>{d.cases[0].properties.native_gaps={ts:'G-215',py:'G-215'};}],
 ['missing continuation gap',d=>{delete d.cases.find(x=>x.id==='fau-0045').properties.native_gaps;}],
 ['executable builder method',d=>{d.cases[0].builder.splice(3,0,{call:'asText',args:[]});}],
 ['successful accounting assertion removed',d=>{delete d.cases.find(x=>x.id==='fau-0040').properties.attempts[0].final_usage;}],
])test('semantic gate rejects '+name,()=>{const d=fixture();mutate(d);assert.notDeepEqual(failureUsageCaseFailures(d,{allowGenerate:true}),[]);});
test('an unexecuted placeholder cannot pass the shipping gate',()=>{const d=fixture();d.cases[0].expect.result_json='@generate';assert(failureUsageCaseFailures(d).some(x=>x.includes('placeholder')));});
test('a native pass claim without actual output fails its independent properties',()=>{const d=fixture();assert(failureUsageViolations({requests:0,attempts:[]},d.cases[5].properties).length>0);});
