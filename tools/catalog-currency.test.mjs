import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateCatalog, checkCatalogWorkflow, familyDrift } from './catalog-contracts.mjs';
import { discoverNpm, discoverRepositories, discoverPython, parseRelease, collectCatalog, requestJson } from './catalog-registry.mjs';

const repo = (name) => `https://github.com/Particle-Academy/${name}`;
function fixture() {
  const make = (name,language,registry,repository,family,role) => ({name,language,registry,repository:repo(repository),family,role,kind:'runtime',status:'published',published:true,catalog:'public',version:'1.0.0'});
  const packages = {
    prism:make('particle-academy/prism','php','packagist','prism','core','reference'),
    acp:make('@particle-academy/prism-acp','ts','npm','prism-acp-ts','acp','reference'),
    python:make('prism-ai-core','py','pypi','prism-py','core','port'),
    loader:{...make('prism-conformance','py','pypi','prism-parity','conformance','tooling'),kind:'tooling',status:'planned',published:false,version:null,catalog:'hidden',catalog_reason:'Unpublished fixture loader.'},
  };
  const manifest={packages,family_references:{core:'prism',acp:'acp'},projects:{},satellites:{}};
  const inventory={repositories:['prism','prism-acp-ts','prism-py','prism-parity'].map(name=>({name})),names:{npm:['@particle-academy/prism-acp'],packagist:['particle-academy/prism'],pypi:['prism-ai-core']},releases:Object.values(packages).map(p=>({registry:p.registry,name:p.name,http:p.status==='planned'?404:200,version:p.version,deprecated:false,ownership:p.registry==='pypi'?{author:'Particle Academy',repositories:[]}:{repositories:[p.repository]}}))};
  return {manifest,inventory};
}
const verdict=(f)=>validateCatalog(f.manifest,f.inventory);
function refused(title, mutate, message) {
  test(title,()=>{const f=fixture();mutate(f);assert.match(verdict(f).failures.join('\n'),message);});
}

test('published packages and explicitly absent planned loader form a complete catalog',()=>assert.deepEqual(verdict(fixture()),{failures:[],repositories:4,published:3,planned:1,excluded:0,privateEnvelopes:0}));
refused('an uncataloged repository fails even when all packages are current',f=>f.inventory.repositories.push({name:'prism-new'}),/UNCLASSIFIED repository prism-new/);
refused('a package pointing at a missing repository fails',f=>f.inventory.repositories.pop(),/Repository lookup missing prism-parity/);
refused('a new first-party distribution fails',f=>{f.inventory.names.pypi.push('prism-ai-new');f.inventory.releases.push({registry:'pypi',name:'prism-ai-new',http:200,ownership:{author:'Particle Academy'}});},/UNCLASSIFIED first-party distribution/);
refused('unknown prefix ownership cannot be silently ignored',f=>{f.inventory.names.pypi.push('prism-ai-stranger');f.inventory.releases.push({registry:'pypi',name:'prism-ai-stranger',http:200,ownership:{}});},/UNCLASSIFIED ownership/);
refused('stale published version fails',f=>f.inventory.releases[0].version='1.0.1',/version 1.0.0 != published 1.0.1/);
refused('published metadata 404 is a failure',f=>f.inventory.releases[0].http=404,/published package lookup failed/);
refused('missing release lookup is a failure',f=>f.inventory.releases.shift(),/Lookup failed/);
refused('planned record cannot hide a new release',f=>f.inventory.releases.at(-1).http=200,/planned package is now published/);
refused('planned record does not forgive HTTP500',f=>f.inventory.releases.at(-1).http=500,/Lookup failed/);
test('planned distributions cannot be public',()=>{
  for(const kind of ['runtime','tooling']) {
    const f=fixture();
    if(kind==='runtime') Object.assign(f.manifest.packages.loader,{kind,role:'port',family:'acp'});
    assert.deepEqual(verdict(f).failures,[],`${kind}: hidden planned control must be valid`);
    f.manifest.packages.loader.catalog='public';
    assert.match(verdict(f).failures.join('\n'),/planned distribution must be hidden/,kind);
  }
});
refused('a hidden package must explain why',f=>delete f.manifest.packages.loader.catalog_reason,/hidden reason/);
refused('duplicate distribution identities fail',f=>f.manifest.packages.alias=structuredClone(f.manifest.packages.prism),/Duplicate distribution/);
refused('duplicate family-language runtime slots fail',f=>{f.manifest.packages.alias={...f.manifest.packages.prism,name:'particle-academy/prism-other'};},/Duplicate runtime core:php/);
refused('a public package cannot claim planned with a version',f=>{f.manifest.packages.prism.status='planned';f.manifest.packages.prism.published=false;},/version contradicts/);
refused('the compatibility view cannot retain a stale version',f=>f.manifest.satellites.prism={...f.manifest.packages.prism,version:'0.0.1'},/stale satellites.version/);
refused('registry-owned repository must match the recorded package',f=>f.inventory.releases[0].ownership.repositories=[repo('prism-acp-ts')],/repository identity mismatch/);
refused('a known Python name without ownership evidence fails',f=>f.inventory.releases[2].ownership={},/UNCLASSIFIED ownership/);
refused('the registry census cannot omit a known published package',f=>{f.inventory.names.pypi=['prism-ai-unknown'];f.inventory.releases.push({registry:'pypi',name:'prism-ai-unknown',http:200,ownership:{}});},/published distribution missing from registry census/);
refused('ACP cannot accidentally inherit the PHP core reference',f=>f.manifest.family_references.acp='prism',/ACP reference must be TypeScript/);
refused('runtime and tooling references cannot overwrite one another',f=>f.manifest.packages.loader.role='reference',/tooling cannot be a runtime reference/);
refused('an empty registry census is not successful work',f=>f.inventory.names.npm=[],/npm:.*empty|npm: registry was not enumerated/);
refused('deprecation must be explicit',f=>f.inventory.releases[0].deprecated=true,/deprecation status mismatch/);

function exclude(f) {
  const ownership={author:null,author_email:'Other <other@example.test>',maintainer:null,maintainer_email:null,repositories:['https://other.example.test']};
  f.inventory.names.pypi.push('prism-ai-stranger');
  f.inventory.releases.push({registry:'pypi',name:'prism-ai-stranger',http:200,version:'1.0.0',ownership});
  f.manifest.registry_exclusions=[{registry:'pypi',name:'prism-ai-stranger',reviewed_on:'2026-10-27',reason:'Maintainer reviewed third party.',ownership:structuredClone(ownership)}];
}
test('a reviewed foreign identity is excluded with positive accounting',()=>{const f=fixture();exclude(f);assert.equal(verdict(f).failures.length,0);assert.equal(verdict(f).excluded,1);});
function privateEnvelope(f) {
  f.manifest.projects['prism.agi']={repository:repo('prism.agi'),kind:'envelope',catalog:'hidden',catalog_reason:'Private workspace.',repository_inventory:'private-envelope',inventory_reason:'Declared private envelope; ordinary public CI cannot verify it.'};
}
test('only the declared private envelope may be invisible to public CI, and it is reported separately',()=>{
  const f=fixture();privateEnvelope(f);assert.equal(verdict(f).failures.length,0);assert.equal(verdict(f).privateEnvelopes,1);
  f.inventory.repositories.push({name:'prism.agi'});assert.equal(verdict(f).failures.length,0);assert.equal(verdict(f).repositories,5);
});
refused('private-envelope classification cannot hide another project',f=>{privateEnvelope(f);f.manifest.projects['prism-hidden']={...f.manifest.projects['prism.agi'],repository:repo('prism-hidden')};},/only the documented private workspace envelope|Repository lookup missing prism-hidden/);
refused('a hidden public app still requires inventory presence',f=>{f.manifest.projects['prism-app']={repository:repo('prism-app'),kind:'application',catalog:'hidden',catalog_reason:'App.'};},/Repository lookup missing prism-app/);
refused('the private envelope requires an explicit visibility reason',f=>{privateEnvelope(f);delete f.manifest.projects['prism.agi'].inventory_reason;},/only the documented private workspace envelope/);
refused('the private envelope cannot become a package repository',f=>{privateEnvelope(f);f.manifest.packages.prism.repository=repo('prism.agi');},/workspace envelope cannot be a distribution repository/);
refused('an exclusion cannot hide a change of ownership',f=>{exclude(f);f.inventory.releases.at(-1).ownership.author='Particle Academy';},/reviewed exclusion identity changed/);
refused('an exclusion needs dated review and reason',f=>{exclude(f);delete f.manifest.registry_exclusions[0].reviewed_on;},/Invalid reviewed registry exclusion/);
test('drift is measured against the same family and unknown surfaces are unverified',()=>{
  const f=fixture(), surface={capabilities:[],providers:[],features:['acp-only']};
  f.manifest.packages.acp.surface=surface;
  const port={family:'acp',surface:{...surface,features:[]}};
  assert.deepEqual(familyDrift(port,f.manifest).missing,['feature:acp-only']);
  delete f.manifest.packages.acp.surface;
  assert.equal(familyDrift(port,f.manifest).verified,false);
});

test('standing workflow cannot condition, tolerate or remove the live catalog gate',()=>{
  const text=readFileSync(new URL('../.github/workflows/alignment.yml',import.meta.url),'utf8');
  assert.deepEqual(checkCatalogWorkflow(text),[]);
  const line='run: node tools/run-gate.mjs catalog -- node tools/catalog-currency.mjs --check';
  for(const changed of [text.replace(line,`if: false\n        ${line}`),text.replace(line,`continue-on-error: true\n        ${line}`),text.replace(line,'run: echo skipped'),text.replaceAll('${{ github.token }}','wrong')]) assert.ok(checkCatalogWorkflow(changed).length);
});

const response=body=>({http:200,body});
test('npm pagination uses the current replication endpoint and advances past inclusive cursor',async()=>{
  const first=Array.from({length:251},(_,i)=>({id:`@particle-academy/prism-${String(i).padStart(3,'0')}`}));
  const seen=[];
  const result=await discoverNpm(async value=>{const url=new URL(value);seen.push(url);return response({rows:seen.length===1?first:[first.at(-1),{id:'@particle-academy/prism-zzz'}]});});
  assert.equal(result.names.length,252);assert.equal(new Set(result.names).size,252);
  assert.equal(seen[0].pathname,'/registry/_all_docs');assert.equal(seen[1].searchParams.get('startkey'),JSON.stringify(first.at(-1).id));
  assert.equal(seen[0].searchParams.has('skip'),false);assert.equal(seen[0].searchParams.has('include_docs'),false);
});
test('duplicate or nonadvancing npm pages fail',async()=>{
  const rows=Array.from({length:251},(_,i)=>({id:`@particle-academy/prism-${String(i).padStart(3,'0')}`}));
  await assert.rejects(discoverNpm(async()=>response({rows})),/Duplicate or unordered/);
});
test('a truncated organization enumeration or HTTP failure cannot become an empty success',async()=>{
  await assert.rejects(discoverRepositories(async()=>({http:404})),/lookup failed/);
  await assert.rejects(discoverRepositories(async()=>response({items:[]})),/Malformed organization page/);
});
test('GitHub enumeration walks a full page instead of trusting its first page',async()=>{
  let calls=0;
  const result=await discoverRepositories(async()=>response(++calls===1?Array.from({length:100},(_,i)=>({name:`other-${i}`})):[{name:'prism',full_name:'Particle-Academy/prism',default_branch:'main'}]));
  assert.equal(calls,2);assert.equal(result[0].name,'prism');
});
test('PyPI normalization is namespace discovery, not proof of ownership',async()=>{
  const r=await discoverPython(async()=>({...response({meta:{'_last-serial':7},projects:[{name:'prism_ai_core'},{name:'prism-ai-outsider'}]}),serial:'7'}));
  assert.deepEqual(r.names,['prism-ai-core','prism-ai-outsider']);
  await assert.rejects(discoverPython(async()=>({...response({meta:{'_last-serial':6},projects:[{name:'prism-ai-core'}]}),serial:'7'})),/incomplete PyPI/);
});
test('Packagist prefers highest stable, or highest prerelease when no stable exists',()=>{
  const releases=[{version:'v1.2.0',version_normalized:'1.2.0.0'},{version:'1.3.0-alpha.5',version_normalized:'1.3.0.0-alpha5'},{version:'1.1.0',version_normalized:'1.1.0.0'}];
  const data=versions=>response({packages:{'particle-academy/prism':versions.map(row=>({name:'particle-academy/prism',source:{url:repo('prism')},...row}))}});
  assert.equal(parseRelease('packagist','particle-academy/prism',data(releases)).version,'1.2.0');
  assert.equal(parseRelease('packagist','particle-academy/prism',data(releases.slice(1,2))).version,'1.3.0-alpha.5');
  assert.throws(()=>parseRelease('packagist','particle-academy/prism',data([{version:'dev-main',version_normalized:'dev-main'}])),/No released/);
  assert.throws(()=>parseRelease('packagist','particle-academy/prism',data([{version:'1.4.0-patch1',version_normalized:'1.4.0.0-patch1'}])),/Unrecognized released/);
});
test('malformed and failed release metadata cannot be treated as planned absence',()=>{
  for(const result of [{http:500},response({}),response({name:'wrong','dist-tags':{latest:'1'}})])assert.throws(()=>parseRelease('npm','@particle-academy/prism',result));
  assert.deepEqual(parseRelease('pypi','prism-conformance',{http:404}),{registry:'pypi',name:'prism-conformance',http:404});
});
test('collector rejects a registry outage rather than returning a partial census',async()=>{
  await assert.rejects(collectCatalog(fixture().manifest,async()=>{throw Error('Network failure');}),/Network failure/);
});

test('HTTP client confines credentials to GitHub and refuses redirects and other origins',async()=>{
  const calls=[];
  const fetchImpl=async(url,options)=>{calls.push({url,options});return new Response('{}');};
  await requestJson('https://api.github.com/orgs/Particle-Academy/repos',{githubToken:'synthetic-token',fetchImpl});
  await requestJson('https://pypi.org/simple/',{githubToken:'synthetic-token',pythonIndex:true,fetchImpl});
  assert.equal(calls[0].options.headers.Authorization,'Bearer synthetic-token');
  assert.equal(Object.hasOwn(calls[1].options.headers,'Authorization'),false);
  assert.equal(calls[1].options.headers.Accept,'application/vnd.pypi.simple.v1+json');
  assert.ok(calls.every(row=>row.options.redirect==='error'&&row.options.signal instanceof AbortSignal));
  for(const url of ['https://evil.example.test/','http://api.github.com/','https://api.github.com:444/','https://user:pass@api.github.com/'])await assert.rejects(requestJson(url,{fetchImpl}),/Unapproved/);
  assert.equal(calls.length,2);
});
test('HTTP failure details cannot disclose native or supplied credentials',async()=>{
  await assert.rejects(requestJson('https://api.github.com/',{githubToken:'synthetic-token',fetchImpl:async()=>{throw Error('synthetic-token');}}),error=>!error.message.includes('synthetic-token'));
  await assert.rejects(requestJson('https://pypi.org/simple/',{fetchImpl:async()=>new Response('{}',{status:503})}),/HTTP503/);
  await assert.rejects(requestJson('https://pypi.org/simple/',{fetchImpl:async()=>new Response('truncated{')}),/Invalid or oversized/);
});
test('HTTP response size bound stops an oversized registry body',async()=>{
  await assert.rejects(requestJson('https://registry.npmjs.org/example',{fetchImpl:async()=>new Response(new Uint8Array(17*1024*1024))}),/Invalid or oversized/);
});

test('Packagist p2 expands Composer deltas before selection, including inherited ownership and unset deprecation',()=>{
  const name='particle-academy/prism';
  const data=response({minified:'composer/2.0',packages:{[name]:[
    {name,version:'2.0.0-alpha.1',version_normalized:'2.0.0.0-alpha1',source:{url:repo('prism')},abandoned:true},
    {version:'1.5.0',version_normalized:'1.5.0.0',abandoned:'__unset'},
    {version:'1.4.0',version_normalized:'1.4.0.0'},
  ]}});
  const result=parseRelease('packagist',name,data);
  assert.equal(result.version,'1.5.0');assert.equal(result.deprecated,false);
  assert.deepEqual(result.ownership.repositories,[repo('prism')]);
  assert.throws(()=>parseRelease('packagist',name,response({minified:'unknown',packages:{[name]:[]}})),/Malformed/);
  assert.throws(()=>parseRelease('packagist',name,response({packages:{wrong:[]}})),/Malformed/);
  assert.throws(()=>parseRelease('packagist',name,response({packages:{[name]:[{name:'wrong',version:'1.0.0',version_normalized:'1.0.0.0'}]}})),/identity/);
});

function registryFixture({actual='1.0.0',cached='0.0.1',exactHttp=200,exactVersion=actual}={}) {
  const seen=[];
  const request=async(value)=>{
    seen.push(value);const url=new URL(value);
    if(url.hostname==='api.github.com')return response(['prism','prism-acp-ts','prism-py','prism-parity'].map(name=>({name,full_name:`Particle-Academy/${name}`,default_branch:'main'})));
    if(url.hostname==='replicate.npmjs.com')return response({rows:[{id:'@particle-academy/prism-acp',version:cached}]});
    if(url.href==='https://packagist.org/packages/list.json?vendor=particle-academy')return response({packageNames:['particle-academy/prism'],version:cached});
    // A plausible but stale old API must never be consulted for a version.
    if(url.href==='https://packagist.org/packages/particle-academy/prism.json')return response({package:{name:'particle-academy/prism',version:cached}});
    if(url.href==='https://repo.packagist.org/p2/particle-academy/prism.json')return response({packages:{'particle-academy/prism':[{name:'particle-academy/prism',version:actual,version_normalized:actual+'.0',source:{url:repo('prism')}}]}});
    if(url.hostname==='registry.npmjs.org')return response({name:'@particle-academy/prism-acp','dist-tags':{latest:actual},versions:{[actual]:{name:'@particle-academy/prism-acp',version:actual,repository:repo('prism-acp-ts')}}});
    if(url.href==='https://pypi.org/simple/')return {...response({meta:{'_last-serial':7},projects:[{name:'prism-ai-core',version:cached}]}),serial:'7'};
    if(url.pathname==='/pypi/prism-conformance/json')return {http:404};
    const python=(version)=>response({info:{name:'prism-ai-core',version,author:'Particle Academy',project_urls:{}},urls:[{yanked:false}]});
    if(url.pathname==='/pypi/prism-ai-core/json')return python(actual);
    if(url.pathname===`/pypi/prism-ai-core/${actual}/json`)return exactHttp===200?python(exactVersion):{http:exactHttp};
    throw Error('Unexpected fixture endpoint '+value);
  };
  return {request,seen};
}

test('stale discovery listings can neither mask a current primary version nor invent one',async()=>{
  for(const cached of ['0.0.1','9.0.0']) {
    const {manifest}=fixture(),fake=registryFixture({cached});
    const inventory=await collectCatalog(manifest,fake.request);
    assert.deepEqual(validateCatalog(manifest,inventory).failures,[]);
    assert(!fake.seen.some(url=>url.startsWith('https://packagist.org/packages/particle-academy/')));
    assert(fake.seen.includes('https://repo.packagist.org/p2/particle-academy/prism.json'));
    assert(fake.seen.includes('https://registry.npmjs.org/%40particle-academy%2Fprism-acp'));
    assert(fake.seen.includes('https://pypi.org/pypi/prism-ai-core/1.0.0/json'));
    assert(!fake.seen.some(url=>url.includes('~dev')));
  }
});

test('genuine primary version lag remains a failure naming each authoritative endpoint',async()=>{
  const {manifest}=fixture(),fake=registryFixture({actual:'0.9.0',cached:'1.0.0'});
  const inventory=await collectCatalog(manifest,fake.request),failures=validateCatalog(manifest,inventory).failures;
  for(const endpoint of ['https://repo.packagist.org/p2/particle-academy/prism.json','https://registry.npmjs.org/%40particle-academy%2Fprism-acp','https://pypi.org/pypi/prism-ai-core/0.9.0/json'])assert(failures.some(message=>message.includes('version 1.0.0 != published 0.9.0')&&message.includes(endpoint)),endpoint);
});

test('a PyPI latest hint cannot invent an absent or mismatched exact release',async()=>{
  for(const options of [{exactHttp:404},{exactVersion:'0.9.0'}]) {
    const fake=registryFixture(options);
    await assert.rejects(collectCatalog(fixture().manifest,fake.request),/https:\/\/pypi.org\/pypi\/prism-ai-core\/1.0.0\/json: PyPI exact release identity/);
  }
});

test('the new Packagist origin remains read-only and never receives GitHub credentials',async()=>{
  let options;
  await requestJson('https://repo.packagist.org/p2/particle-academy/prism.json',{githubToken:'synthetic-token',fetchImpl:async(url,opts)=>{options=opts;return new Response('{}');}});
  assert.equal(Object.hasOwn(options.headers,'Authorization'),false);
  assert.equal(options.redirect,'error');
  for(const url of ['https://repo.packagist.org.evil.test/','https://user:pass@repo.packagist.org/p2/x.json','https://repo.packagist.org:444/p2/x.json'])await assert.rejects(requestJson(url),/Unapproved/);
});
