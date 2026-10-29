import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const p=await import(pathToFileURL(process.env.PRISM_HARNESS_TS+'/dist/index.js'));
const store=new p.FileSessionStore(process.argv[2]),harness=new p.PrismHarness({drivers:{owned:()=>store},stores:{ephemeral:'owned',durable:'owned'}});
const participant={type:'legacy',id:7},session=harness.for(participant).session('initial'),rows={};
const tool=(name,label)=>({name,handle:()=>label});
async function resolved(registry,names=['probe']){return [...await registry.resolve(names,session)].map(([key,t])=>[key,t.name,t.handle({})]);}
rows.duplicate_static=await resolved(new p.ToolRegistry().register(tool('probe','first')).register(tool('probe','second')));
rows.duplicate_factory=await resolved(new p.ToolRegistry().registerFactory('probe',()=>tool('probe','first')).registerFactory('probe',()=>tool('probe','second')));
rows.duplicate_providers=await resolved(new p.ToolRegistry().registerProvider(()=>[tool('probe','first')]).registerProvider(()=>[tool('probe','second')]));
for(const order of ['sf','fs','sp','ps','fp','pf','sfp','pfs']){
 const registry=new p.ToolRegistry();
 for(const kind of order){if(kind==='s')registry.register(tool('probe','static'));else if(kind==='f')registry.registerFactory('probe',()=>tool('probe','factory'));else registry.registerProvider(()=>[tool('probe','provider')]);}
 rows['precedence_'+order]=await resolved(registry);
}
rows.factory_name_mismatch=await resolved(new p.ToolRegistry().registerFactory('probe',()=>tool('other','legacy-mismatch')));
const requests=[],tools=new p.ToolRegistry().register(tool('inside','inside')).register(tool('outside','outside'));
const runtime=new p.AgentRuntime({tools,modes:new p.ModeRegistry({default:'chat',modes:{chat:{tools:['inside']}}}),client:async request=>{requests.push(request.tools.map(t=>t.name));return{text:'done',finishReason:'stop',costUsd:0};}});
await runtime.send(session,'widen',['outside']);await runtime.send(session,'empty',[]);
rows.caller_lists=requests;assert.deepEqual(requests,[['outside'],[]]);
const initial=session.key();participant.id=8;const changedId=session.key();session.scope='changed';const changedScope=session.key();
rows.mutable_legacy={id_changes_key:initial!==changedId,scope_changes_key:changedId!==changedScope,scope:session.scope};
assert(rows.mutable_legacy.id_changes_key&&rows.mutable_legacy.scope_changes_key);
console.log(JSON.stringify(rows));
