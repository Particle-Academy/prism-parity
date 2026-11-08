// Independent declarations are checked against native output, never reconstructed as output.
const outerKeys=['usage','status','scope','step_index','reported_fields','includes_completed_steps'];
const usageKeys=['prompt_tokens','completion_tokens','cache_write_input_tokens','cache_read_input_tokens','thought_tokens','cost','cache_write_5m_input_tokens','cache_write_1h_input_tokens'];
const own=(value,key)=>value!==null&&typeof value==='object'&&Object.hasOwn(value,key);
const normalize=value=>Array.isArray(value)?value.map(normalize):value!==null&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalize(value[key])])):value;
const equal=(a,b)=>JSON.stringify(normalize(a))===JSON.stringify(normalize(b));

// Native failure channels are explicit. These declarations never override usage accounting.
export function declaredNativeOutcomes(id) {
  const decode = ['fau-0007','fau-0016','fau-0025','fau-0051','fau-0052','fau-0053'];
  if (decode.includes(id)) {
    const reported = ['fau-0007','fau-0016','fau-0025'].includes(id);
    const outcome = {terminal:'returned',transport_identity:null,error_events:1,
      stream_ends:['fau-0007','fau-0051'].includes(id)?1:0,channels:reported?['event']:[]};
    return {ts:outcome,py:structuredClone(outcome)};
  }
  if (['fau-0043','fau-0044'].includes(id)) return {ts:{stream_ends:0},py:{stream_ends:0}};
  return null;
}

/** Closed fixture contract; a known difference or skip cannot silently spread to other rows. */
export function failureUsageCaseFailures(document,{allowGenerate=false}={}){
  const failed=[];
  if(document?.suite!=='stream-failure-usage'||!Array.isArray(document.cases)||document.cases.length===0)return ['failure suite is missing or empty'];
  const known=['fau-0004','fau-0009'];
  for(const row of document.cases){
    const fail=message=>failed.push(row.id+': '+message),input=row.failure_stream,properties=row.properties;
    if(properties?.contract!=='failure-usage'||!input||!['anthropic','openai','mistral'].includes(input.provider)){fail('missing native failure contract');continue;}
    const selected=row.builder?.filter(x=>x.call==='using')??[],steps=row.builder?.filter(x=>x.call==='withMaxSteps')??[];
    if(!equal(row.builder?.map(x=>x.call),['using','withPrompt','withMaxTokens','withMaxSteps'])||!equal(selected[0]?.args,[input.provider,'owned'])||!equal(row.builder?.[1]?.args,['private-prompt-sentinel'])||!equal(row.builder?.[2]?.args,[32]))fail('only the fixed owned builder is executable');
    if(selected.length!==1||selected[0].args?.[0]!==input.provider)fail('builder/provider mismatch');
    if(steps.length!==1||!equal(steps[0].args,[input.mode==='continuation'?2:1]))fail('max steps must be explicit');
    if(!allowGenerate&&row.expect?.result_json==='@generate')fail('unexecuted golden placeholder');
    if(known.includes(row.id)){
      if(input.provider!=='anthropic'||!equal(properties.native_differences,{php:{gap:'G-214',exception:'TypeError',transport_identity:false}})||properties.attempts?.length!==1||properties.attempts[0].failure_usage!==null)fail('G-214 must stay explicit and scoped');
    }else if(own(properties,'native_differences'))fail('undeclared native-difference waiver');
    const nativeOutcomes=declaredNativeOutcomes(row.id);
    if(nativeOutcomes?!equal(properties.native_outcomes,nativeOutcomes):own(properties,'native_outcomes'))fail('native channel declaration changed or spread');
    if(input.mode==='telemetry'){
      if(!properties.telemetry||!equal(Object.keys(row.skip??{}).sort(),['py','ts'])||Object.values(row.skip).some(x=>typeof x!=='string'||!x.startsWith('PHP public generation telemetry dispatch is outside')))fail('native PHP telemetry must declare its exact port surface limits');
    }else if(['fau-0045','fau-0046','fau-0047','fau-0054'].includes(row.id)){
      if(input.mode!=='continuation'||!equal(properties.native_gaps,{ts:'G-215',py:'G-215'})||!equal(Object.keys(row.skip??{}).sort(),['py','ts'])||Object.values(row.skip).some(x=>typeof x!=='string'||!x.startsWith('G-215: no native multi-step stream tool continuation')))fail('native continuation gap must stay explicit and scoped');
    }else if(own(row,'skip')||own(properties,'telemetry')||own(properties,'native_gaps'))fail('shared failure controls cannot be skipped');
    if(input.mode!=='continuation'&&own(properties,'native_gaps'))fail('native continuation gap spread');
    if(input.mode==='serialization'){
      const reported=input.serialization==='reported-zero-cost';
      if(properties.requests!==0||properties.attempts?.length!==0||properties.serialization?.reported!==reported||(properties.serialization?.failure_usage!==null)!==reported)fail('serialization control mismatch');
      continue;
    }
    const attempts=input.attempts;
    if(!Array.isArray(attempts)||attempts.length<1||attempts.length>3||attempts.length!==properties.attempts?.length){fail('attempt declarations mismatch');continue;}
    if(['single','continuation','telemetry'].includes(input.mode)&&attempts.length!==1)fail('single request scenario needs one attempt');
    if(['reuse','interleave'].includes(input.mode)&&attempts.length<2)fail('isolation control needs multiple attempts');
    if(input.mode==='continuation'&&!equal(input.owned_tool,{name:'owned_echo',result:'owned-constant-result'}))fail('continuation must use the declared constant-only tool');
    if(!equal(properties.requests,properties.attempts.reduce((n,x)=>n+x.requests,0)))fail('total request count mismatch');
    if(['fau-0040','fau-0041','fau-0042'].includes(row.id)&&!equal(properties.attempts?.[0]?.final_usage,{prompt_tokens:11,completion_tokens:3,cost:null}))fail('successful baseline must retain numeric accounting');
    for(const [index,attempt]of attempts.entries()){
      if(!Array.isArray(attempt.responses)||attempt.responses.length!==properties.attempts[index].requests)fail('response/request count mismatch');
      let bytes=0;
      for(const response of attempt.responses??[])for(const encoded of response.chunks??[])bytes+=Math.floor(encoded.length*3/4)-(encoded.endsWith('==')?2:encoded.endsWith('=')?1:0);
      if(bytes>1048576)fail('owned attempt exceeds byte bound');
    }
  }
  if(known.some(id=>!document.cases.some(row=>row.id===id)))failed.push('G-214 observation rows disappeared');
  return failed;
}

export function failureUsageViolations(trace,properties,{language='php'}={}){
  const failed=[];
  const fail=(label,condition)=>{if(!condition)failed.push(label);};
  fail('contract',properties?.contract==='failure-usage');
  fail('language',['php','ts','py'].includes(language));
  fail('requests',trace?.requests===properties?.requests);
  const checkPayload=(actual,expected,label)=>{
    fail(label+'.presence',actual!==null&&typeof actual==='object'&&!Array.isArray(actual));
    if(actual===null||typeof actual!=='object'||Array.isArray(actual))return;
    fail(label+'.shape',equal(Object.keys(actual).sort(),[...outerKeys].sort()));
    fail(label+'.scope',actual.status==='provisional'&&actual.scope==='attempt'&&actual.includes_completed_steps===false&&Number.isInteger(actual.step_index)&&actual.step_index>=0);
    fail(label+'.usage-shape',actual.usage!==null&&typeof actual.usage==='object'&&equal(Object.keys(actual.usage).sort(),[...usageKeys].sort()));
    const fields=actual.reported_fields;
    fail(label+'.mask',Array.isArray(fields)&&fields.length>0&&fields.length===new Set(fields).size&&fields.every(x=>usageKeys.includes(x)));
    for(const field of usageKeys){const number=actual.usage?.[field];fail(label+'.numeric.'+field,(number===null&&!['prompt_tokens','completion_tokens'].includes(field))||(typeof number==='number'&&Number.isFinite(number)&&number>=0&&number<=Number.MAX_SAFE_INTEGER&&(field==='cost'||Number.isSafeInteger(number))));}
    fail(label+'.reported-values',Array.isArray(fields)&&fields.every(field=>typeof actual.usage?.[field]==='number'));
    fail(label+'.expected',equal(actual,expected));
    const serialized=JSON.stringify(actual);
    fail(label+'.privacy',(properties.privacy_sentinels??[]).every(sentinel=>!serialized.includes(sentinel)));
  };
  const checkSerialized=(serialized,expected,label)=>{
    fail(label+'.shape',serialized!==null&&typeof serialized==='object'&&!Array.isArray(serialized));
    if(serialized===null||typeof serialized!=='object')return;
    fail(label+'.no-implementation-field',!own(serialized,'failureUsage'));
    fail(label+'.presence',own(serialized,'failure_usage')===(expected!==null));
    if(expected!==null&&own(serialized,'failure_usage'))checkPayload(serialized.failure_usage,expected,label+'.failure_usage');
  };
  if(properties.serialization){
    const expected=properties.serialization.failure_usage;
    checkSerialized(trace?.event,expected,'event');checkSerialized(trace?.event_json,expected,'event_json');checkSerialized(trace?.exception_json,expected,'exception_json');
    fail('exception-privacy',!JSON.stringify(trace?.exception_json).includes('private-exception-sentinel'));
    return failed;
  }
  fail('attempt-count',Array.isArray(trace?.attempts)&&trace.attempts.length===properties.attempts?.length);
  if(!Array.isArray(trace?.attempts)||!Array.isArray(properties.attempts))return failed;
  properties.attempts.forEach((common,index)=>{
    const expected={...common,...properties.native_outcomes?.[language]};
    const actual=trace.attempts[index],label='attempt.'+index;
    fail(label+'.exists',actual!==null&&typeof actual==='object');if(!actual||typeof actual!=='object')return;
    fail(label+'.requests',actual.requests===expected.requests);
    fail(label+'.terminal',actual.terminal?.status===expected.terminal);
    const difference=properties.native_differences?.[language];
    if(difference){
      fail(label+'.registered-difference',language==='php'&&difference.gap==='G-214'&&difference.exception==='TypeError'&&difference.transport_identity===false);
      fail(label+'.known-native-exception',actual.terminal?.exception===difference.exception);
    }
    fail(label+'.exception-identity',actual.terminal?.injected_exception_preserved===(difference?difference.transport_identity:expected.transport_identity));
    if(expected.terminal==='raised')fail(label+'.exception-class',typeof actual.terminal?.exception==='string'&&actual.terminal.exception.length>0);
    fail(label+'.owned-tools',actual.owned_tool_calls===expected.owned_tool_calls);
    fail(label+'.events',Array.isArray(actual.events));if(!Array.isArray(actual.events))return;
    const errors=actual.events.filter(event=>event.type==='error');
    fail(label+'.failure-only-metadata',actual.events.every(event=>event.type==='error'||!own(event.payload,'failure_usage')));
    fail(label+'.error-count',errors.length===expected.error_events);
    if(own(expected,'stream_ends'))fail(label+'.stream-ends',actual.events.filter(event=>event.type==='stream_end').length===expected.stream_ends);
    if(expected.normal_completion===true)fail(label+'.successful-baseline',actual.events.filter(event=>event.type==='stream_end').length===1&&actual.events.some(event=>event.type==='stream_end'&&['Stop','stop'].includes(event.payload?.finish_reason)));
    for(const [field,value]of Object.entries(expected.final_usage??{}))fail(label+'.final-usage.'+field,actual.events.find(event=>event.type==='stream_end')?.payload?.usage?.[field]===value);
    const channels=[];
    for(const [errorIndex,event]of errors.entries()){
      const present=own(event.payload,'failure_usage');
      fail(label+'.error.'+errorIndex+'.presence',present===(expected.failure_usage!==null));
      if(present){channels.push('event');checkPayload(event.payload.failure_usage,expected.failure_usage,label+'.error.'+errorIndex);}
      checkSerialized(event.serialized_error,expected.failure_usage,label+'.serialized-error.'+errorIndex);
    }
    const exceptionPayload=actual.terminal?.failure_usage;
    if(exceptionPayload!==null&&exceptionPayload!==undefined){channels.push('exception');checkPayload(exceptionPayload,expected.failure_usage,label+'.exception');}
    if(expected.channels.includes('exception'))fail(label+'.exception-json-present',actual.terminal?.serialized_error!==null&&typeof actual.terminal?.serialized_error==='object');
    fail(label+'.channels',equal([...new Set(channels)].sort(),[...expected.channels].sort()));
    if(actual.terminal?.serialized_error!==null&&actual.terminal?.serialized_error!==undefined)checkSerialized(actual.terminal.serialized_error,expected.channels.includes('exception')?expected.failure_usage:null,label+'.exception-json');
    if(expected.terminal==='raised'||expected.error_events>0){fail(label+'.no-success-end',!actual.events.some(event=>event.type==='stream_end'&&['Stop','stop'].includes(event.payload?.finish_reason)));}
    if(expected.owned_tool_calls===0)fail(label+'.no-completed-tool',!actual.events.some(event=>['tool_call','tool_result'].includes(event.type)));
  });
  if(properties.telemetry){
    const events=trace.telemetry??[];
    fail('telemetry.started',events.filter(x=>x.class==='Prism\\Prism\\Events\\Telemetry\\GenerationStarted').length===1);
    fail('telemetry.capture-default',events.filter(x=>x.class==='Prism\\Prism\\Events\\Telemetry\\GenerationStarted').every(x=>x.request_is_null===true));
    fail('telemetry.no-completed',!events.some(x=>x.class==='Prism\\Prism\\Events\\Telemetry\\GenerationCompleted'));
    const terminal=events.filter(x=>['Prism\\Prism\\Events\\Telemetry\\GenerationErrored','Prism\\Prism\\Events\\Telemetry\\GenerationFailed'].includes(x.class));
    fail('telemetry.one-terminal',terminal.length===1&&terminal[0].class===properties.telemetry.terminal);
    if(terminal.length===1)checkPayload(terminal[0].failure_usage,properties.attempts[0].failure_usage,'telemetry.failure_usage');
  }
  return failed;
}
