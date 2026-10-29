import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const pkg=await import(pathToFileURL(process.env.PRISM_HARNESS_TS+'/dist/index.js'));
const inputs=JSON.parse(fs.readFileSync(process.argv[2])).cases,rows=[];
for(const row of inputs){const {participant,scope,agent}=row.input;let result;
  if(!pkg.SessionAddress&&agent!==null)result={error:'unsupported_named_namespace'};
  else try{
    if(pkg.SessionAddress){const address=new pkg.SessionAddress(participant,scope,agent);result={session_key:participant===null?null:address.sessionKey(),thread_key:address.threadKey(),index_key:address.indexKey()};}
    else{const dummy=new pkg.MemorySessionStore();result={session_key:new pkg.Session({participant,scope,ephemeral:dummy,durable:dummy}).key()};}
  }catch(error){if(!(error instanceof TypeError))throw error;result={error:'invalid_address'};}
  rows.push({id:row.id,result});
}
console.log(JSON.stringify(rows));
