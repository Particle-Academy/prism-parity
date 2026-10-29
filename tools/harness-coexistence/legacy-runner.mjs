import fs from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
// Serial compatibility fixture only. No worker/liveness test uses this clock or entropy.
const NativeDate=Date;
globalThis.Date=class extends NativeDate { constructor(value){super(value===undefined?'2026-01-01T00:00:00.000Z':value);}static now(){return 1767225600000;} };
crypto.randomUUID=()=> '00000000-0000-4000-8000-000000000001';syncBuiltinESMExports();
const pkg=await import(pathToFileURL(process.env.PRISM_HARNESS_TS+'/dist/index.js'));
const directory=process.argv[2],store=new pkg.FileSessionStore(directory);
const harness=new pkg.PrismHarness({drivers:{owned:()=>store},stores:{ephemeral:'owned',durable:'owned'}});
const participant={type:'legacy-person',id:7},session=harness.for(participant).session('same:/雪');
await session.usingMode('chat');await session.usingProvider('anthropic');await session.usingModel('fixture-model');
await session.usingCapability('fixture',{enabled:true});await session.tasks().add('fixed task','fixed-task');
const requests=[];
const runtime=new pkg.AgentRuntime({modes:new pkg.ModeRegistry({default:'chat',modes:{chat:{system_prompt:'Frozen instructions',tools:['tock','tick'],max_steps:2,provider_options:{temperature:0.25}}}}),tools:new pkg.ToolRegistry().registerMany([{name:'tick',description:'Fixed tool',handle:()=> 'unused'},{name:'tock',description:'Second tool',handle:()=> 'unused'}]),client:async request=>{
  assert.equal(Object.hasOwn(request,'maxOutputTokens'),false);
  requests.push(JSON.stringify({...request,tools:request.tools.map(({handle,...value})=>value)}));
  return{text:`answer:${requests.length}`,finishReason:'stop',costUsd:0};
}});
await runtime.send(session,'first');await runtime.send(session,'second');assert.equal(requests.length,2);
assert(requests.every(raw=>JSON.stringify(JSON.parse(raw).tools.map(tool=>tool.name))===JSON.stringify(['tock','tick'])));
const files={};for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){assert(entry.isFile(),'No unfinished lock directories');assert(/\.(json|jsonl)$/.test(entry.name),'No abandoned temporary/lock files');files[entry.name]=fs.readFileSync(join(directory,entry.name)).toString('base64');}
assert(Object.keys(files).length>=4);
console.log(JSON.stringify({session_key:session.key(),requests,files}));
