import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bytesToBase64,
  rpc,
  BatchLabClientError,
  downloadBatchLabExperimentJsonl,
  getBatchLabExperimentResults,
  listBatchLabAttemptEvents,
  runBatchLabExperimentWorkerOnce,
} from './client';
import { createExperimentService } from '../../server/experiments';

const EXPERIMENT_A = '14d87288-e769-4eab-8c01-ef7b1ba523d2';
const EXPERIMENT_B = '328aefcd-2e0d-49f2-a779-fb5d453dc083';

function success(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), { status: 200 });
}

test('chunk encoding round-trips Chinese CSV across byte boundaries',()=>{
  const original=new TextEncoder().encode('id,history\r\n1,"中文🙂多轮历史"\r\n'.repeat(30_000));
  const restored:Buffer[]=[];
  for(let i=0;i<original.length;i+=512*1024) restored.push(Buffer.from(bytesToBase64(original.subarray(i,i+512*1024)),'base64'));
  assert.deepEqual(Buffer.concat(restored),Buffer.from(original));
});
test('failed saves report server error and cannot look locally successful',async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({success:false,error:{message:'数据版本尚未完成'}}),{status:400});
  try { await assert.rejects(rpc('finishDatasetImport',{}),(e:any)=>e instanceof BatchLabClientError && e.message==='数据版本尚未完成'); }
  finally {globalThis.fetch=previous;}
});
test('cancelled reads do not send a request',async()=>{
  const abort=new AbortController();abort.abort();
  await assert.rejects(rpc('listBatchLabDatasets',{},abort.signal),(e:any)=>e.kind==='cancelled');
});

test('event client receives an array containing the latest 100 persisted events', async () => {
  const previous = globalThis.fetch;
  const allEvents = Array.from({ length: 120 }, (_, index) => ({
    id: String(index + 1),
    attempt_id: `attempt-${index + 1}`,
    experiment_id: EXPERIMENT_A,
    event_type: index === 119 ? 'succeeded' : 'created',
    created_at: '2026-09-24T00:00:00.000Z',
    data: { attempt_count: 1 },
  }));
  const service = createExperimentService({
    query: async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
      if (sql.includes('FROM lab_records')) return [{ data: { id: EXPERIMENT_A } }] as T[];
      assert.equal(values[0], EXPERIMENT_A);
      // Exercise the actual dispatcher: the incremental endpoint and latest-event
      // endpoint deliberately use different SQL queries.
      const items = sql.includes('ORDER BY id DESC LIMIT 100')
        ? allEvents.slice(-100)
        : allEvents.filter((event) => Number(event.id) > Number(values[1] ?? 0)).slice(0, Number(values[2] ?? 100));
      return items as T[];
    },
    fetch: async () => { throw new Error('The event read must never call a model'); },
  });
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    return success(await service(request.op, request.input));
  };
  try {
    const events = await listBatchLabAttemptEvents(EXPERIMENT_A);
    assert.ok(Array.isArray(events));
    assert.equal(events.length, 100);
    assert.equal(events[0].id, '21');
    assert.equal(events.at(-1)?.id, '120');
    assert.equal(events.at(-1)?.event_type, 'succeeded');
  } finally { globalThis.fetch = previous; }
});

test('concurrent JSONL exports follow every result cursor and keep experiment outputs separate', async () => {
  const previous = globalThis.fetch;
  const requests: Array<{ experimentId: string; input: { cursor: string | null; limit: number } }> = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.op, 'getBatchLabExperimentResults');
    const { experimentId, input } = request.input;
    requests.push(request.input);
    const offset = Number(input.cursor ?? 0);
    assert.equal(input.limit, 5);
    const samples = Array.from({ length: Math.min(5, 7 - offset) }, (_, index) => ({ ordinal: offset + index }));
    return success({
      experiment: { id: experimentId },
      samples,
      attempts: samples.map((sample) => ({ sample_ordinal: sample.ordinal, raw_output: `${experimentId}/${sample.ordinal}` })),
      annotations: [{ sample_ordinal: null, note: '实验备注' }, { sample_ordinal: 6, note: '最后一页备注' }],
      next_sample_cursor: offset === 0 ? '5' : null,
    });
  };
  try {
    const exports = await Promise.all([EXPERIMENT_A, EXPERIMENT_B].map((id) => downloadBatchLabExperimentJsonl(id)));
    for (const [index, blob] of exports.entries()) {
      const id = index === 0 ? EXPERIMENT_A : EXPERIMENT_B;
      const lines = (await blob.text()).trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(lines.map((line) => line.sample.ordinal), [0, 1, 2, 3, 4, 5, 6]);
      for (const line of lines) {
        assert.equal(line.experiment.id, id);
        assert.equal(line.attempts.length, 1);
        assert.equal(line.attempts[0].raw_output, `${id}/${line.sample.ordinal}`);
        assert.equal(line.annotations.length, line.sample.ordinal === 6 ? 2 : 1);
      }
      assert.deepEqual(requests.filter((request) => request.experimentId === id).map((request) => request.input.cursor), [null, '5']);
    }
  } finally { globalThis.fetch = previous; }
});

test('parallel reads and worker requests retain their explicit experiment scope', async () => {
  const previous = globalThis.fetch;
  const seen: Array<{ op: string; input: any }> = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    seen.push(request);
    assert.notEqual(request.op, 'runBatchLabWorkerOnce', 'UI requests must not use the unscoped worker');
    return request.op === 'getBatchLabExperimentResults'
      ? success({ experiment: { id: request.input.experimentId }, samples: [], next_sample_cursor: null })
      : success({ claimed_count: 1, completed_count: 1, failed_count: 0 });
  };
  try {
    await Promise.all([
      getBatchLabExperimentResults(EXPERIMENT_A, { cursor: '5', limit: 5 }),
      getBatchLabExperimentResults(EXPERIMENT_B, { cursor: null, limit: 5 }),
      runBatchLabExperimentWorkerOnce({ experiment_id: EXPERIMENT_A, source_environment: 'test', worker_id: 'worker-a', claim_limit: 1 }),
      runBatchLabExperimentWorkerOnce({ experiment_id: EXPERIMENT_B, source_environment: 'test', worker_id: 'worker-b', claim_limit: 1 }),
    ]);
    assert.deepEqual(seen.filter((request) => request.op === 'getBatchLabExperimentResults').map((request) => [request.input.experimentId, request.input.input.cursor]), [[EXPERIMENT_A, '5'], [EXPERIMENT_B, null]]);
    assert.deepEqual(seen.filter((request) => request.op === 'runBatchLabExperimentWorkerOnce').map((request) => [request.input.experiment_id, request.input.worker_id]), [[EXPERIMENT_A, 'worker-a'], [EXPERIMENT_B, 'worker-b']]);
  } finally { globalThis.fetch = previous; }
});

test('JSONL export restores truncated snapshots and full Unicode output using server content cursors', async () => {
  const previous = globalThis.fetch;
  const attemptId = '6a1a5b95-53a3-4a8e-88b2-312794c31bca';
  const sampleSetId = 'cc7557cf-1b57-4874-960d-b3e15526e9d5';
  const rawOutput = '🙂中文'.repeat(15_001) + '\n完整结尾🧪';
  const displayResult = { sanitized_html: `<p>${'🧪实验'.repeat(12_000)}</p>`, status: 'ok' };
  const fullSample = { ordinal: 6, history: [{ role: 'user', content: '🙂完整历史'.repeat(4_000) }], user_input: '继续' };
  const contents = { raw_output: rawOutput, display_result: JSON.stringify(displayResult) };
  const chunkCursors: Record<keyof typeof contents, Array<number | string>> = { raw_output: [], display_result: [] };
  globalThis.fetch = async (_url, init) => {
    const { op, input } = JSON.parse(String(init?.body));
    if (op === 'getBatchLabExperimentResults') {
      assert.equal(input.experimentId, EXPERIMENT_A);
      return success({
        experiment: { id: EXPERIMENT_A, sample_set_id: sampleSetId },
        samples: [{ ordinal: 6, history: [], user_input: '继续', preview_truncated: true }],
        attempts: [
          { attempt_id: attemptId, sample_ordinal: 6, raw_output: '预览', display_result: null, preview_truncated: true },
          { attempt_id: 'unchanged-attempt', sample_ordinal: 6, raw_output: '短回复', display_result: null },
        ],
        annotations: [],
        next_sample_cursor: null,
      });
    }
    if (op === 'listBatchLabSampleSetSamples') {
      assert.equal(input.sampleSetId, sampleSetId);
      assert.deepEqual(input.input, { cursor: '6', limit: 1 });
      return success({ sample_set_id: sampleSetId, items: [fullSample], next_cursor: null });
    }
    assert.equal(op, 'getBatchLabAttemptContent');
    assert.equal(input.attemptId, attemptId);
    assert.equal(input.limit, 20_000);
    const field = input.field as keyof typeof contents;
    assert.ok(field in contents);
    chunkCursors[field].push(input.cursor);
    // PostgreSQL cursors count Unicode characters, while JavaScript length
    // counts UTF-16 code units. Emoji make those positions differ.
    const characters = Array.from(contents[field]);
    const offset = Number(input.cursor);
    assert.equal(offset, (chunkCursors[field].length - 1) * 20_000);
    const end = Math.min(offset + input.limit, characters.length);
    return success({ text: characters.slice(offset, end).join(''), next_cursor: end < characters.length ? String(end) : null });
  };
  try {
    const exported = JSON.parse((await (await downloadBatchLabExperimentJsonl(EXPERIMENT_A)).text()).trim());
    assert.deepEqual(exported.sample, fullSample);
    assert.equal(exported.attempts[0].raw_output, rawOutput);
    assert.deepEqual(exported.attempts[0].display_result, displayResult);
    assert.equal(exported.attempts[0].preview_truncated, false);
    assert.equal(exported.attempts[1].raw_output, '短回复');
    assert.deepEqual(chunkCursors.raw_output, [0, '20000', '40000']);
    assert.deepEqual(chunkCursors.display_result, [0, '20000']);
  } finally { globalThis.fetch = previous; }
});
