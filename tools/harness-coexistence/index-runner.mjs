import fs from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const pkg=await import(pathToFileURL(process.env.PRISM_HARNESS_TS+'/dist/index.js'));
const specs=JSON.parse(fs.readFileSync(new URL('./index-cases.json',import.meta.url))).cases,rows=[];
for(const spec of specs){
  const directory=join(process.env.PRISM_INDEX_WORK,`ts-${spec.id}`);
  const store=new pkg.FileSessionStore(directory),participant={type:'index-person',id:'1'};
  const harness=new pkg.PrismHarness({drivers:{owned:()=>store},stores:{ephemeral:'owned',durable:'owned'},maxAddressesPerParticipant:spec.max_addresses_per_participant});
  let refusals=0,errorCode=null,refusedState=false;
  for(let i=0;i<spec.addresses;i++){
    const session=harness.forAgent('support').for(participant).session(`page:${i}`);
    try{await session.usingMode('reply');}catch(error){
      if(!(error instanceof pkg.AddressLimitExceeded))throw error;
      refusals++;errorCode=error.code;refusedState||=await store.get(`${session.key()}:ephemeral`)!==null;
    }
  }
  const index=new pkg.StoreAddressIndex(store),sizes=[],cursors=[],positions=[];
  let cursor=0;
  do{const page=await index.page(participant,cursor);sizes.push(page.entries.length);cursors.push(page.next_cursor);positions.push(...page.entries.map(row=>row.position));cursor=page.next_cursor;}while(cursor!==null);
  await harness.forAgent('support').for(participant).session('page:0').usingMode('updated');
  const result={indexed:positions.length,page_sizes:sizes,next_cursors:cursors,quota_refusals:refusals,error_code:errorCode,refused_state_present:refusedState,positions_dense:positions.every((position,i)=>position===i),existing_writable:await harness.forAgent('support').for(participant).session('page:0').mode()==='updated'};
  assert.deepEqual(result,spec.expected,spec.id);rows.push({id:spec.id,result});
}
console.log(JSON.stringify(rows));
