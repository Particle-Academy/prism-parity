import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWorkflow, verifyStepLines, VERIFY_BLANKED } from './pin-github-checks.mjs';
import { config, expected, workflow, cases } from './pin-github-checks-hijack-fixtures.mjs';
test('G148 verifier blanks exactly the joint Prism/Fancy list in order as NAME single-quoted empty values',()=>{
 const names=['NODE_OPTIONS','NODE_PATH','BASH_ENV','ENV','SHELLOPTS','BASHOPTS','LD_PRELOAD','LD_LIBRARY_PATH','LD_AUDIT','DYLD_INSERT_LIBRARIES','DYLD_LIBRARY_PATH'];
 assert.deepEqual(VERIFY_BLANKED,names);
 const lines=verifyStepLines(6,'.shared',expected);
 const start=lines.indexOf('        env:')+1;
 assert.deepEqual(lines.slice(start,start+names.length),names.map(name=>`          ${name}: ''`));
 assert.equal(lines[start+names.length],'          PIN_ROOT: .shared');
 assert(!names.includes('PATH'));
});
test('G148 control: the current canonical verifier with checkout/setup-node is accepted',()=>{
 assert.deepEqual(checkWorkflow(workflow(),config,expected).problems,[]);
});
for(const prefix of ['tools','prism-parity/tools']){
 test(`G148 control: preserve the existing ${prefix} allowlist metric wrapper`,()=>{
  const text=workflow({gateRun:`node ${prefix}/run-gate.mjs allowlist -- node .shared/third-party/check.mjs --repo .`});
  assert.deepEqual(checkWorkflow(text,config,expected).problems,[]);
 });
}
test('G148 control: cleanup after the final gate does not change its execution path',()=>{
 const text=workflow({gateRun:'|\n          node .shared/third-party/check.mjs --repo .\n          node -e "process.exit(0)"'});
 assert.deepEqual(checkWorkflow(text,config,expected).problems,[]);
});
test('G148 class 5: refuse an unknown metric wrapper before the gate',()=>{
 const text=workflow({gateRun:'node planted/tools/run-gate.mjs allowlist -- node .shared/third-party/check.mjs --repo .'});
 assert(checkWorkflow(text,config,expected).problems.some(problem=>problem.code==='gate-unverified'),'Only the two existing literal metric wrapper paths are trusted; an arbitrary wrapper can run a different gate.');
});
for(const fixture of cases){
 test(`G148 class ${fixture.class}: refuse ${fixture.id}`,()=>{
  const result=checkWorkflow(workflow(fixture.change),config,expected);
  assert(result.problems.some(problem=>problem.code===fixture.code),`${fixture.id} must refuse via ${fixture.code}; actual ${JSON.stringify(result.problems)}`);
 });
}
