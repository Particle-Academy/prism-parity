// Discriminate the independent predicates using output executed by the PHP reference.
// These transformations never produce goldens or replace a native provider implementation.
export function failureUsageControls(cases) {
  return cases.map(row => ({id:row.id, properties:row.properties, trace:JSON.parse(row.expect.result_json)}));
}

export function failureUsageMutants(controls) {
  const error = trace => trace.attempts[0].events.find(event => event.type === 'error');
  const payload = trace => error(trace).payload.failure_usage;
  const definitions = [
    ['capture removed','fau-0006',trace => {delete error(trace).payload.failure_usage;}],
    ['reported zero treated as absent','fau-0005',trace => {delete error(trace).payload.failure_usage;delete error(trace).serialized_error.failure_usage;}],
    ['absent report invented as zero','fau-0002',(trace,all) => {trace.attempts[0].terminal.failure_usage=structuredClone(payload(all.find(x=>x.id==='fau-0005').trace));}],
    ['cumulative output summed','fau-0036',trace => {payload(trace).usage.completion_tokens*=2;}],
    ['stale report survives retry','fau-0028',trace => {trace.attempts[1].events.push(structuredClone(error(trace)));}],
    ['parallel zero gets foreign snapshot','fau-0029',trace => {trace.attempts[1].events.find(x=>x.type==='error').payload.failure_usage=structuredClone(payload(trace));}],
    ['reported field mask removed','fau-0006',trace => {delete payload(trace).reported_fields;}],
    ['field mask fabricated','fau-0006',trace => {payload(trace).reported_fields.push('cost');}],
    ['diagnostic content leaks','fau-0006',trace => {payload(trace).diagnostic='private-provider-sentinel';}],
    ['duplicate terminal error','fau-0006',trace => {trace.attempts[0].events.push(structuredClone(error(trace)));}],
    ['failure becomes successful end','fau-0034',trace => {trace.attempts[0].events.find(x=>x.type==='stream_end').payload.finish_reason='Stop';}],
    ['continuation includes completed usage','fau-0045',trace => {payload(trace).usage.prompt_tokens+=11;payload(trace).includes_completed_steps=true;}],
    ['wrong continuation step','fau-0045',trace => {payload(trace).step_index=0;}],
    ['error serialization drops payload','fau-0006',trace => {delete error(trace).serialized_error.failure_usage;}],
    ['SDK exception JSON evidence omitted','fau-0007',trace => {trace.attempts[0].terminal.serialized_error=null;}],
    ['native exception replaced','fau-0006',trace => {trace.attempts[0].terminal.injected_exception_preserved=false;}],
    ['legacy absence serialized as null','fau-0038',trace => {trace.event_json.failure_usage=null;}],
    ['private exception internals serialized','fau-0039',trace => {trace.exception_json.message='private-exception-sentinel';}],
    ['success gets failure metadata','fau-0040',(trace,all) => {trace.attempts[0].events.find(x=>x.type==='stream_end').payload.failure_usage=structuredClone(payload(all.find(x=>x.id==='fau-0006').trace));}],
    ['success loses reported usage','fau-0040',trace => {trace.attempts[0].events.find(x=>x.type==='stream_end').payload.usage=null;}],
    ['success token count changes','fau-0041',trace => {trace.attempts[0].events.find(x=>x.type==='stream_end').payload.usage.prompt_tokens=0;}],
    ['failure telemetry also completes','fau-0048',trace => {trace.telemetry.push({class:'Prism\\Prism\\Events\\Telemetry\\GenerationCompleted'});}],
    ['default telemetry captures input','fau-0048',trace => {trace.telemetry.find(x=>x.class.endsWith('GenerationStarted')).request_is_null=false;}],
  ];
  return definitions.map(([name,id,mutate]) => {
    const original=controls.find(row=>row.id===id);
    if(!original) throw new Error('Missing executed control '+id);
    const row=structuredClone(original),before=JSON.stringify(row.trace);
    mutate(row.trace,controls);
    if(JSON.stringify(row.trace)===before) throw new Error('Inactive mutant '+name);
    return {...row,name};
  });
}
