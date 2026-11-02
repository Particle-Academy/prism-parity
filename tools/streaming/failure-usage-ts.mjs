// Execute native providers. This adapter owns bytes and faults, never missing SDK events.
export async function parseFailureStream(lib, testCase) {
  const input=testCase.failure_stream;
  const expected=[{call:'using',args:[input?.provider,'owned']},{call:'withPrompt',args:['private-prompt-sentinel']},
    {call:'withMaxTokens',args:[32]},{call:'withMaxSteps',args:[input?.mode==='continuation'?2:1]}];
  if(!Array.isArray(testCase.builder)||testCase.builder.length!==expected.length||testCase.builder.some((step,index)=>step.call!==expected[index].call||JSON.stringify(step.args)!==JSON.stringify(expected[index].args)))throw new Error('Only the fixed owned failure builder is executable.');
  if(!['anthropic','openai','mistral'].includes(input?.provider)) throw new Error('Unsupported failure fixture provider.');
  if(input.mode==='serialization') return serialization(lib,input);
  if(!['single','reuse','interleave'].includes(input.mode)) throw new Error('Native continuation/telemetry has no declared port implementation.');
  const states=input.attempts.map(()=>({events:[],requests:0,owned_tool_calls:0,injected:null,
    terminal:{status:'returned',exception:null,injected_exception_preserved:null,failure_usage:null,serialized_error:null}}));
  if(states.length<1||states.length>3) throw new Error('Invalid native attempt count.');
  let active=0;
  const transport=async request=>{
    if(!request.url.startsWith('https://conformance.invalid/v1/')||JSON.parse(request.body).stream!==true) throw new Error('Unexpected owned native request.');
    const state=states[active],response=input.attempts[active].responses[state.requests];
    if(!response||state.requests>=3) throw new Error('Unexpected extra native request.');
    state.requests++;
    const chunks=decode(response);
    if(response.fault==='transport') state.injected=new Error('private-transport-sentinel');
    return {status:200,headers:{'content-type':'text/event-stream'},chunks:(async function*(){
      const decoder=new TextDecoder();
      for(const chunk of chunks){const text=decoder.decode(chunk,{stream:true});if(text)yield text;}
      const rest=decoder.decode();if(rest)yield rest;
      if(response.fault==='transport') throw state.injected;
    })()};
  };
  const Type={anthropic:lib.Anthropic,openai:lib.OpenAI,mistral:lib.Mistral}[input.provider];
  const config={apiKey:'owned-fixture-only',url:'https://conformance.invalid/v1',streamTransport:transport};
  const reused=input.mode==='reuse'?new Type(config):null,eventIds=new Map(),opaqueIds=new Map();
  function normalize(payload){
    payload=structuredClone(payload);
    if(Object.hasOwn(payload,'id')) payload.id=alias(eventIds,payload.id,'event');
    if(Object.hasOwn(payload,'timestamp')) payload.timestamp=0;
    return opaque(payload,opaqueIds);
  }
  async function* walk(native,state){
    try{
      for await(const event of native){
        const row={type:event.type(),payload:normalize(event.toObject())};
        if(event instanceof lib.ErrorEvent) row.serialized_error=normalize(JSON.parse(JSON.stringify(event)));
        state.events.push(row);yield;
      }
    }catch(error){
      const sdk=error instanceof lib.PrismError;
      state.terminal={status:'raised',exception:error?.constructor?.name??'Unknown',
        injected_exception_preserved:state.injected===null?null:error===state.injected,
        failure_usage:sdk?(error.streamFailureUsage?.()?.toObject()??null):null,
        serialized_error:sdk?JSON.parse(JSON.stringify(error)):null};
    }
  }
  const iterators=input.attempts.map((_,index)=>{
    let pending=lib.Prism.text();
    for(const step of testCase.builder) pending=pending[step.call](...(step.call==='using'?[...step.args,config]:step.args??[]));
    return walk((reused??new Type(config)).stream(pending.toRequest()),states[index]);
  });
  if(input.mode==='interleave'){
    const finished=new Set();
    while(finished.size<iterators.length)for(const [index,iterator]of iterators.entries()){
      if(finished.has(index))continue;active=index;if((await iterator.next()).done)finished.add(index);
    }
  }else for(const [index,iterator]of iterators.entries()){active=index;for await(const _ of iterator){/* native iteration */}}
  return {attempts:states.map(({injected,...state})=>state),requests:states.reduce((sum,state)=>sum+state.requests,0)};
}

function decode(response){
  if(response?.encoding!=='base64'||!['none','transport'].includes(response.fault)||!Array.isArray(response.chunks)||response.chunks.length>100||(response.chunks.length===0&&response.fault!=='transport'))throw new Error('Invalid native byte fixture.');
  let size=0;
  return response.chunks.map(encoded=>{
    if(typeof encoded!=='string'||encoded.length>1398104)throw new Error('Oversized encoded native byte fixture.');
    const bytes=Buffer.from(encoded,'base64');
    if(bytes.length===0||bytes.toString('base64')!==encoded||(size+=bytes.length)>1048576)throw new Error('Invalid or oversized native byte fixture.');
    return bytes;
  });
}
function alias(map,value,prefix){if(!map.has(value))map.set(value,`${prefix}-${map.size+1}`);return map.get(value);}
function opaque(value,map){
  if(Array.isArray(value))return value.map(child=>opaque(child,map));
  if(value===null||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,
    ['message_id','reasoning_id'].includes(key)&&typeof child==='string'&&child!==''?alias(map,child,'opaque'):opaque(child,map)]));
}
function serialization(lib,input){
  if(!['legacy-error','reported-zero-cost'].includes(input.serialization))throw new Error('Unknown native serialization control.');
  const reported=input.serialization==='reported-zero-cost';
  const failure=reported?new lib.StreamFailureUsage(new lib.Usage(0,0,null,null,null,0),0,['prompt_tokens','completion_tokens','cost']):null;
  const event=new lib.ErrorEvent('owned_failure','owned-fixture','owned-error',0,false,failure);
  const exception=new lib.PrismError('provider_response_error','private-exception-sentinel');
  if(typeof exception.withStreamFailureUsage!=='function')throw new Error('Missing native SDK failure metadata accessor.');
  exception.withStreamFailureUsage(failure);
  return {event:event.toObject(),event_json:JSON.parse(JSON.stringify(event)),exception_json:JSON.parse(JSON.stringify(exception)),requests:0};
}
