import {pathToFileURL} from 'node:url';
const {FileSessionStore,Session}=await import(pathToFileURL(process.argv[2]));
const store=new FileSessionStore(process.argv[3]),session=new Session({participant:{type:'test',id:'callback'},scope:'callback',ephemeral:store,durable:store});
let callbacks=0,code=null;
// No host keepalive, IPC channel, fixture timer, or signal handler.
try{await session.lock(()=>{callbacks++;},10,0.12);}catch(error){code=error.code;}
console.log(JSON.stringify({callbacks,code}));
