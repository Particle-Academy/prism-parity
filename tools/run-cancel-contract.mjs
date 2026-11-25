import assert from 'node:assert/strict';

// G-285 harness-run-cancel. The SAFETY expectations below were written down
// before any language ran, from the contract in the PHP reference's README and
// the port brief. They are applied to each language's execution output on its
// own, so three languages agreeing on an unsafe result still fail. The corpus
// comparison (identical canonical strings) is a separate, weaker question.

export const LANGUAGES = ['php', 'ts', 'py'];

// The published harness versions carrying G-285. NONE IS PUBLISHED. Until each
// is filled in from a real registry release, the corpus tool refuses every mode
// except --development, so no golden can be recorded from candidate source
// (decision 0006). Filling one in is a release step, not a fix for a red run.
export const PUBLISHED = { php: null, ts: null, py: null };

export const REFUSAL = 'Not run: the run was cancelled.';

const CANCEL_EVENTS = ['cancel_requested', 'cancelled'];
const COMPLETED = {
  run_status: 'completed', stored_status: 'completed', ended_as: null, error_code: null, model_calls: 2,
  tools_run: ['search', 'weather'], refused_tools: [], final_answer_in_thread: true, events: ['finished'],
  request_states: [], events_tagged: null, approval_status_before: null, approval_status_after: null,
  decide_refused: null, resume_refused: null,
};
const STOPPED = {
  run_status: 'cancelled', stored_status: 'cancelled', error_code: 'run_cancelled', events: CANCEL_EVENTS,
  request_states: ['running'], events_tagged: true, approval_status_before: null, approval_status_after: null,
  decide_refused: null, resume_refused: null,
};
const HOSTILE_FORMS = ['empty', 'truncated', 'extended', 'traversal', 'upper', 'trailing_newline', 'trailing_space',
  'leading_space', 'zero_width', 'nbsp', 'nul', 'homoglyph'];

// A field left out of an expectation is not asserted, and each omission says why.
export const EXPECTED = {
  // ended_as is not asserted: what an interrupted run "would have ended as" is native.
  'hrc-0001': { ...STOPPED, outcomes: ['ok'], model_calls: 1, tools_run: ['search'], refused_tools: ['weather'], final_answer_in_thread: false },
  // refused_tools is not asserted: refusing both calls or stopping before either is equally safe; nothing may RUN.
  'hrc-0002': { ...STOPPED, outcomes: ['ok'], model_calls: 1, tools_run: [], final_answer_in_thread: false },
  'hrc-0003': { ...STOPPED, outcomes: ['ok'], ended_as: 'completed', model_calls: 2, tools_run: ['search'], refused_tools: [], final_answer_in_thread: true },
  // Decided 2026-11-25 (coordinator ruling, G-285): a parked run's STORED record
  // is out of scope. cancel() on a parked run takes no session lock and never
  // rewrites the run record in any language; the durable flag is the authority
  // and the run READ is what consumers see. So the read status is compared, the
  // stored one is not projected (stored_status null) and is recorded natively as
  // park_stored_status. The race row keeps its stored check: there the running
  // run writes its own terminal record under the cancel lock.
  'hrc-0004': { outcomes: ['ok', 'not-running'], run_status: 'cancelled', stored_status: null, error_code: null, model_calls: 1, tools_run: ['search'],
    events: CANCEL_EVENTS,
    refused_tools: [], final_answer_in_thread: false, request_states: ['parked'], events_tagged: true,
    approval_status_before: 'pending', approval_status_after: 'cancelled', decide_refused: true, resume_refused: true },
  'hrc-0005': { ...COMPLETED, outcomes: ['refused'] },
  'hrc-0006': { ...COMPLETED, outcomes: ['refused'] },
  'hrc-0007': { ...COMPLETED, outcomes: HOSTILE_FORMS.map(() => 'refused') },
  'hrc-0008': { ...COMPLETED, outcomes: ['no-turn', 'no-turn'] },
  // The run ended before the cancel, and events are projected from the cancel onward.
  'hrc-0009': { ...COMPLETED, outcomes: ['not-running', 'not-running'], model_calls: 1, tools_run: [], events: [] },
  'hrc-0010': { ...STOPPED, outcomes: ['ok', 'ok', 'not-running'], model_calls: 1, tools_run: ['search'], refused_tools: ['weather'], final_answer_in_thread: false },
  'hrc-0011': { ...COMPLETED, outcomes: [] },
};

const FIELDS = ['outcomes', 'run_status', 'stored_status', 'ended_as', 'error_code', 'model_calls', 'tools_run', 'refused_tools',
  'final_answer_in_thread', 'events', 'request_states', 'events_tagged', 'approval_status_before', 'approval_status_after',
  'decide_refused', 'resume_refused'];

// The hostile shape of every row, so the matrix cannot be collapsed into controls.
const SIGNATURES = {
  'hrc-0001': ['tool:search', 'same:current', '', false, '', ''],
  'hrc-0002': ['request:1', 'same:current', '', false, '', ''],
  'hrc-0003': ['request:2', 'same:current', '', false, '', ''],
  'hrc-0004': ['parked', 'same:current,same:current', '', true, '', 'weather'],
  'hrc-0005': ['tool:search', 'other:current', '', false, 'other', ''],
  'hrc-0006': ['tool:search', 'same:forged', '', false, '', ''],
  'hrc-0007': ['tool:search', HOSTILE_FORMS.map((form) => `same:${form}`).join(','), '', false, '', ''],
  'hrc-0008': ['tool:search', 'empty:current,empty:forged', '', false, '', ''],
  'hrc-0009': ['after', 'same:current,same:previous', '', false, 'same', ''],
  'hrc-0010': ['tool:search', 'same:current,same:current', 'same:current', false, '', ''],
  'hrc-0011': [null, '', '', false, '', ''],
};

function signature(input) {
  const list = (cancels) => cancels.map((one) => `${one.by}:${one.id}`).join(',');
  return [input.cancel_at, list(input.cancels), list(input.after), input.settle,
    input.before.map((turn) => turn.who).join(','), input.requires_approval.join(',')];
}

export function verifyRunCancelMatrix(cases) {
  assert.deepEqual(cases.map((row) => row.id), Object.keys(SIGNATURES), 'All eleven run-cancel rows must execute, in order');
  for (const row of cases) {
    assert.deepEqual(signature(row.input), SIGNATURES[row.id], `${row.id}: the hostile input is part of the contract; controls cannot replace hostile cases`);
  }
}

function count(list, value) {
  return list.filter((item) => item === value).length;
}

/** The invariants every row obeys, whatever its expectation table says. */
function invariants(label, result) {
  const ok = result.outcomes.includes('ok');
  assert.equal(count(result.events, 'cancel_requested'), ok ? 1 : 0, `${label}: exactly one request event per cancelled run, none without an ok`);
  assert.equal(count(result.events, 'cancelled'), ok ? 1 : 0, `${label}: exactly one cancelled event per cancelled run`);
  if (ok) {
    assert.equal(result.run_status, 'cancelled', `${label}: a cancel that returned ok is never followed by a run that reads otherwise`);
    const after = result.events.slice(result.events.indexOf('cancel_requested'));
    assert.deepEqual(after, CANCEL_EVENTS, `${label}: cancelled fires INSTEAD of finished/failed, never beside them`);
  } else {
    assert.notEqual(result.run_status, 'cancelled', `${label}: a run nobody cancelled must not read cancelled`);
  }
}

export function verifyRunCancelResult(label, id, result) {
  assert.deepEqual(Object.keys(result).sort(), [...FIELDS].sort(), `${label}: result fields`);
  const expected = EXPECTED[id];
  assert(expected, `${label}: no authored safety expectation`);
  for (const [field, value] of Object.entries(expected)) {
    assert.deepEqual(result[field], value, `${label}: run-cancel safety contract (${field})`);
  }
  invariants(label, result);
}

export function verifyRunCancelReport(language, report, cases, development = false) {
  assert(cases.length > 0, 'No run-cancel inputs were discovered');
  assert(LANGUAGES.includes(language), 'Unknown run-cancel language');
  if (!development) {
    assert(PUBLISHED[language], `${language}: no published harness release carries G-285; only --development can run`);
  }
  assert.deepEqual(report.results.map((row) => row.id), cases.map((row) => row.id), `${language}: missing, duplicate, or reordered execution`);
  for (const row of report.results) {
    const label = `${language}/${row.id}`;
    verifyRunCancelResult(label, row.id, row.result);
    const native = row.native;
    assert.deepEqual(Object.keys(native).sort(), ['decisions', 'error', 'event_names', 'package_version', 'park_stored_status', 'projected_from', 'resumes', 'run_id_shape'], `${label}: native fields`);
    // Events are projected from the first cancel onward; what came before is native park vocabulary.
    assert.equal(native.event_names.length - native.projected_from, row.result.events.length, `${label}: every projected event has its native name`);
    assert.equal(native.park_stored_status !== null, row.id === 'hrc-0004', `${label}: the stored record at park is recorded natively for the parked row only`);
    assert.equal(native.error === null, row.result.error_code === null, `${label}: a native error exactly when a code is projected`);
    if (!development) assert.equal(native.package_version, PUBLISHED[language], `${label}: install the published release version`);
  }
}

/**
 * The committed document may only carry a result where the manifest says that
 * language is full, and agreement only once every column is recorded. An
 * unrecorded row is null in every column, carries no agrees, and claims nothing.
 */
export function runCancelDocumentFailures(document, manifest) {
  const failures = [];
  for (const row of document.cases ?? []) {
    const recorded = LANGUAGES.filter((language) => row.result?.[language] !== null && row.result?.[language] !== undefined);
    for (const language of LANGUAGES) {
      const full = manifest.implementations?.[language]?.status === 'full';
      const hasResult = recorded.includes(language);
      const hasNative = row.native?.[language] !== null && row.native?.[language] !== undefined;
      if (hasResult !== hasNative) failures.push(`${row.id}/${language}: result and native must be recorded together`);
      if (hasResult && !full) failures.push(`${row.id}/${language}: a recorded result needs a full implementation; goldens come only from published artifacts`);
      if (!hasResult && full) failures.push(`${row.id}/${language}: a full implementation needs a recorded result`);
      if (hasResult) {
        try {
          verifyRunCancelResult(`${language}/${row.id}`, row.id, JSON.parse(row.result[language]));
        } catch (error) {
          failures.push(`${row.id}/${language}: recorded result breaks the safety contract: ${error.message}`);
        }
      }
    }
    const complete = recorded.length === LANGUAGES.length;
    const agreement = complete ? row.result.php === row.result.ts && row.result.php === row.result.py : undefined;
    if (row.agrees !== agreement) failures.push(`${row.id}: agrees must be ${agreement === undefined ? 'absent' : agreement} (${complete ? 'all columns recorded' : 'unrecorded rows claim nothing'})`);
  }
  return failures;
}
