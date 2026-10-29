import assert from 'node:assert/strict';

export const groups=['addresses','paged-index','coexistence','production-mutants','live-expiry','recovery-races','mixed-index-workers','published-old-workers','published-current-ports'];

export function requireEvidence(name,output) {
 assert(groups.includes(name),'Unknown evidence group');
 const documents=output.split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
 const last=documents.at(-1);assert(last,'Missing native evidence: '+name);
 if(name==='addresses'||name==='paged-index'){
  assert.equal(last.languages,3);assert.equal(last.skipped,0);
  const count=name==='addresses'?46:3;assert.equal(last.casesPerLanguage,count);
  assert.deepEqual(Object.keys(last.reports).sort(),['php','py','ts']);
  for(const report of Object.values(last.reports))assert.equal((report.rows??report).length,count);
 }else if(name==='coexistence'){
  assert.deepEqual(last.proof,{languages:3,bootOrdersPerLanguage:6,agentsPerOrder:3,positiveHandlers:54,hostileRequestsRefused:162,foreignRegistriesRefused:54,collisionsRefused:90,boundActorHandoffs:54,approvalBoundaries:18,childAuthorityRefusals:18,childPolicyCases:54,legacyExtraActorDivergences:18,legacyChildPositiveControls:18,skipped:0});
  assert.deepEqual(Object.keys(last.reports).sort(),['php','py','ts']);
  for(const rows of Object.values(last.reports))assert.equal(rows.length,6);
 }else if(name==='production-mutants'){
  assert.deepEqual(last.sabotage,{expected:17,rejected:17,originals_unchanged:true});
  const mutants=documents.filter(row=>row.rejectedByOracle===true);
  assert.equal(mutants.length,17);assert.equal(new Set(mutants.map(row=>row.name)).size,17);
  assert(mutants.every(row=>row.otherLanguagesSafe===true));
 }else if(name==='live-expiry'){
  assert.equal(last.case,'live holder past expiry');assert.equal(last.reports.length,6);
  assert(last.reports.every(row=>row.holder_alive===true&&row.contender_callbacks===0&&row.contender_error==='session_locked'));
 }else if(name==='recovery-races'){
  assert.equal(last.separate_processes,true);assert.equal(last.reports.length,4);
  assert.match(output,/^Production owner recovery passed: 4 native\/mixed cases; 4 owned dead holders; 8 real reclaimers; 4 callback entries; 0 overlaps\.$/m);
 }else if(name==='mixed-index-workers'){
  assert.equal(last.separate_processes,true);assert.equal(last.reports.length,7);
  assert.equal(new Set(last.reports.map(row=>row.case)).size,7);
  assert(last.reports.every(row=>row.contender_callbacks===0&&row.contender_error==='session_locked'&&row.after_release_callbacks===1));
  assert(last.reports.slice(0,3).every(row=>row.indexed_addresses===101&&row.positions_dense===true&&row.unique_addresses===true&&row.state_isolated===true));
 }else if(name==='published-old-workers'){
  assert.equal(last.rolling_upgrade_claimed,false);assert.equal(last.rows.length,12);
  assert(last.rows.every(row=>row.production_writer===true&&row.callbacks===0&&row.mutation_attempts===0&&row.directory_unchanged===true));
  assert.equal(last.controls.length,4);assert.equal(last.controls.filter(row=>row.callbacks===1).length,3);
  assert.equal(last.legacy_defaults.languages,2);assert.equal(last.legacy_defaults.fixturesPerLanguage,2);
  assert.equal(last.legacy_defaults.comparisons.length,4);
  assert.deepEqual(last.legacy_defaults.comparisons.map(row=>row.language+'/'+row.fixture).sort(),['py/legacy-defaults-runner','py/legacy-runner','ts/legacy-defaults-runner','ts/legacy-runner']);
  assert(last.legacy_defaults.comparisons.every(row=>row.identical===true&&/^[0-9a-f]{64}$/.test(row.sha256)));
  assert.match(output,/^Production published-worker proof passed: 12 protected rows; 0 callbacks; 0 mutation attempts; 3 active controls; native torn-stamp difference retained\.$/m);
 }else{
  assert.equal(last.status,'PASS');assert.deepEqual(Object.keys(last.artifacts).sort(),['py','ts']);
  if(last.platform==='win32')assert.deepEqual(last.windowsBarrier,{status:'PASS',actualSharingDenial:true,workerDeniedBarrierRead:true,childAliveWhileDenied:true,nonceValidatedAfterClose:true,exit:0});
  else{assert(['linux','darwin'].includes(last.platform));assert.deepEqual(last.windowsBarrier,{status:'not-applicable',platform:last.platform});}
  for(const[language,version,count]of[['ts','0.9.2',60],['py','0.4.2',31]]){
   const artifact=last.artifacts[language];assert.equal(artifact.version,version);assert.equal(artifact.runtimeFiles,count);assert.equal(Object.keys(artifact.runtime).length,count);assert.equal(artifact.unchanged,true);assert.match(artifact.sha256,/^[a-f0-9]{64}$/);
  }
  assert.deepEqual(last.groups.map(row=>row.name),groups.slice(0,8).filter(name=>name!=='production-mutants'));
  assert(last.groups.every(row=>row.passed===true&&/^[a-f0-9]{64}$/.test(row.sha256)));
  assert.deepEqual(last.optIns,['ts','py'].map(language=>({language,checks:8,collisions:3,outsideRefusals:2,requests:[['inside'],[]],handlers:0})));
  assert.equal(last.callback.checks,5);assert.deepEqual(last.callback.callbackRows,['EEXIST','EPERM','EACCES','EBUSY'].map(code=>({code,callbacks:1,writes:1,originalError:true,released:true})));
  assert.deepEqual(last.callback.waiter,{callbacks:0,code:'session_locked',exit:0,noHostKeepalive:true,holderAliveThroughout:true});
 }
 return true;
}
