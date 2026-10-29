import assert from 'node:assert/strict';
import {test} from 'node:test';
import {groups,requireEvidence} from './evidence-rules.mjs';

for(const name of groups){
 test(name+': silence, empty JSON and success text cannot replace evidence',()=>{
  for(const output of ['', '{}', 'PASS', '{"status":"PASS"}','{"reports":[]}'])
   assert.throws(()=>requireEvidence(name,output));
 });
}
const address={languages:3,skipped:0,casesPerLanguage:46,reports:Object.fromEntries(['php','ts','py'].map(name=>[name,{rows:Array(46).fill({})}]))};
test('complete address proof is accepted; missing language/row and skipped controls are refused',()=>{
 assert.equal(requireEvidence('addresses',JSON.stringify(address)),true);
 for(const mutate of [row=>delete row.reports.py,row=>row.reports.py.rows.pop(),row=>row.skipped=1]){
  const row=structuredClone(address);mutate(row);assert.throws(()=>requireEvidence('addresses',JSON.stringify(row)));
 }
});
test('mutant summary cannot replace independently named oracle refusals',()=>{
 const final={sabotage:{expected:17,rejected:17,originals_unchanged:true}};
 const rows=Array.from({length:17},(_,i)=>({name:'case-'+i,rejectedByOracle:true,otherLanguagesSafe:true}));
 const output=entries=>[...entries,final].map(row=>JSON.stringify(row)).join('\n');
 assert.equal(requireEvidence('production-mutants',output(rows)),true);
 assert.throws(()=>requireEvidence('production-mutants',output(rows.slice(1))));
 assert.throws(()=>requireEvidence('production-mutants',output(rows.map(row=>({...row,name:'duplicate'})))));
 assert.throws(()=>requireEvidence('production-mutants',output(rows.map(row=>({...row,otherLanguagesSafe:false})))));
});
test('published-worker proof also requires all four actual legacy-default comparisons',()=>{
 const comparisons=['ts','py'].flatMap(language=>['legacy-runner','legacy-defaults-runner'].map(fixture=>({language,fixture,identical:true,sha256:'a'.repeat(64)})));
 const proof={rolling_upgrade_claimed:false,rows:Array.from({length:12},()=>({production_writer:true,callbacks:0,mutation_attempts:0,directory_unchanged:true})),controls:[{callbacks:1},{callbacks:1},{callbacks:1},{callbacks:0}],legacy_defaults:{languages:2,fixturesPerLanguage:2,comparisons}};
 const encode=row=>JSON.stringify(row)+'\nProduction published-worker proof passed: 12 protected rows; 0 callbacks; 0 mutation attempts; 3 active controls; native torn-stamp difference retained.';
 assert.equal(requireEvidence('published-old-workers',encode(proof)),true);
 for(const mutate of [row=>delete row.legacy_defaults,row=>row.legacy_defaults.languages=1,row=>row.legacy_defaults.fixturesPerLanguage=1,row=>row.legacy_defaults.comparisons.pop(),row=>row.legacy_defaults.comparisons[1].fixture='legacy-runner',row=>row.legacy_defaults.comparisons[0].identical=false,row=>row.legacy_defaults.comparisons[0].sha256='unverified']){
  const copy=structuredClone(proof);mutate(copy);assert.throws(()=>requireEvidence('published-old-workers',encode(copy)));
 }
});
test('published artifacts require both complete unchanged runtimes, all groups, opt-ins and callback controls',()=>{
 const proof={status:'PASS',artifacts:Object.fromEntries([['ts','0.9.2',60],['py','0.4.2',31]].map(([language,version,count])=>[language,{version,runtimeFiles:count,runtime:Object.fromEntries(Array.from({length:count},(_,i)=>['file'+i,'a'.repeat(64)])),unchanged:true,sha256:'b'.repeat(64)}])),groups:groups.slice(0,8).filter(name=>name!=='production-mutants').map(name=>({name,passed:true,sha256:'c'.repeat(64)})),optIns:['ts','py'].map(language=>({language,checks:8,collisions:3,outsideRefusals:2,requests:[['inside'],[]],handlers:0})),callback:{checks:5,callbackRows:['EEXIST','EPERM','EACCES','EBUSY'].map(code=>({code,callbacks:1,writes:1,originalError:true,released:true})),waiter:{callbacks:0,code:'session_locked',exit:0,noHostKeepalive:true,holderAliveThroughout:true}}};
 proof.platform='win32';proof.windowsBarrier={status:'PASS',actualSharingDenial:true,workerDeniedBarrierRead:true,childAliveWhileDenied:true,nonceValidatedAfterClose:true,exit:0};
 assert.equal(requireEvidence('published-current-ports',JSON.stringify(proof)),true);
 const noBarrier=structuredClone(proof);delete noBarrier.windowsBarrier;assert.throws(()=>requireEvidence('published-current-ports',JSON.stringify(noBarrier)));
 const unmeasured=structuredClone(proof);unmeasured.windowsBarrier.status='not-applicable';assert.throws(()=>requireEvidence('published-current-ports',JSON.stringify(unmeasured)));
 for(const platform of ['linux','darwin']){const native=structuredClone(proof);native.platform=platform;native.windowsBarrier={status:'not-applicable',platform};assert.equal(requireEvidence('published-current-ports',JSON.stringify(native)),true);}
 for(const mutate of[row=>delete row.artifacts.py,row=>row.artifacts.ts.unchanged=false,row=>delete row.artifacts.py.runtime.file0,row=>row.groups.pop(),row=>row.groups[0].passed=false,row=>row.optIns.pop(),row=>row.optIns[0].requests.push(['outside']),row=>row.callback.callbackRows.pop(),row=>row.callback.callbackRows[0].callbacks=2,row=>row.callback.waiter.noHostKeepalive=false]){
  const copy=structuredClone(proof);mutate(copy);assert.throws(()=>requireEvidence('published-current-ports',JSON.stringify(copy)));
 }
});
