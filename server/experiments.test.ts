import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createExperimentService, CLAIM_SQL, COMPLETE_SQL, buildAttemptMessages, modelUrl } from './experiments.js';

const db = new PGlite();
const q = async <T = any>(text: string, values: any[] = []): Promise<T[]> => (await db.query<T>(text, values)).rows;
const transaction = async (statements: Array<{ text: string; values?: any[] }>) => db.transaction(async client => {
  const results: any[][] = [];
  for (const statement of statements) results.push((await client.query(statement.text, statement.values ?? [])).rows);
  return results;
});
before(async () => { await db.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8')); });
after(async () => { await db.close(); });

const env = { BATCH_LAB_MODEL_KEY: 'unit-test-key' };
function variant(key: string, turns = 2) {
  return { key, name: key, model_id: `test-${key}`, openrouter_model_id: `test/${key}`, tier: null,
    is_free: true, sampling: { temperature: 0.4 }, processor_version_id: null, max_turns: turns };
}
async function fixture(label: string, turns = 2, fetcher: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  return Response.json({ id: randomUUID(), model: body.model, choices: [{ message: { content: `result:${body.model}:${body.messages.at(-1).content}` }, finish_reason: 'stop' }] });
}) {
  const setId = randomUUID();
  const data = { id: setId, name: label, version: 1, source_environment: 'test', dataset_version_id: randomUUID(), sample_count: 2 };
  await q(`INSERT INTO lab_records(kind,id,data) VALUES ('sample_set',$1,$2)`, [setId, JSON.stringify(data)]);
  for (let ordinal = 0; ordinal < 2; ordinal++) {
    await q(`INSERT INTO lab_snapshots(sample_set_id,ordinal,data) VALUES($1,$2,$3)`, [setId, ordinal, JSON.stringify({
      ordinal, source_history_id: randomUUID(), history: [{ role: 'system', content: `context:${label}` }], user_input: `${label}:${ordinal}`,
    })]);
  }
  const operation = createExperimentService({ query: q, transaction, fetch: fetcher, env });
  const input = { name: label, sample_set_id: setId, source_environment: 'test', idempotency_key: randomUUID(), variants: [variant('a', turns), variant('b', turns)] };
  const experiment = await operation('createBatchLabExperiment', input) as any;
  await operation('startBatchLabExperiment', { experiment_id: experiment.id, source_environment: 'test', idempotency_key: randomUUID() });
  return { operation, experiment, input };
}
const runInput = (id: string, worker: string, limit = 4) => ({ experiment_id: id, worker_id: worker, claim_limit: limit, source_environment: 'test' });

test('creation and start are idempotent; configuration cannot change under a request key', async () => {
  const { operation, experiment, input } = await fixture('idempotent');
  const again = await operation('createBatchLabExperiment', input) as any;
  assert.equal(again.id, experiment.id);
  await assert.rejects(operation('createBatchLabExperiment', { ...input, name: 'changed' }), /请求标识/);
  await operation('startBatchLabExperiment', { experiment_id: experiment.id, source_environment: 'test', idempotency_key: randomUUID() });
  const counts = await q(`SELECT count(*)::int AS count FROM lab_attempts WHERE experiment_id=$1`, [experiment.id]);
  assert.equal(counts[0].count, 8);
});

test('two claimers never receive the same task; experiments and dependent turns remain isolated', async () => {
  const first = await fixture('first');
  const second = await fixture('second');
  const [one, two] = await Promise.all([
    q(CLAIM_SQL, [first.experiment.id, 'worker-one', 3]),
    q(CLAIM_SQL, [first.experiment.id, 'worker-two', 3]),
  ]);
  const claimed = [...one, ...two];
  assert.equal(claimed.length, 4);
  assert.equal(new Set(claimed.map(row => row.id)).size, 4);
  assert.ok(claimed.every(row => row.experiment_id === first.experiment.id && row.turn_index === 1));
  const other = await q(CLAIM_SQL, [second.experiment.id, 'worker-three', 1]);
  assert.equal(other[0].experiment_id, second.experiment.id);
  const task = claimed[0];
  assert.deepEqual(await q(COMPLETE_SQL, [task.id, second.experiment.id, task.lease_owner, task.attempt_count, 'succeeded', JSON.stringify({ raw_output: 'must-not-write' })]), []);
  assert.deepEqual(await q(COMPLETE_SQL, [task.id, first.experiment.id, 'wrong-owner', task.attempt_count, 'succeeded', '{}']), []);
  const saved = await q(COMPLETE_SQL, [task.id, first.experiment.id, task.lease_owner, task.attempt_count, 'succeeded', JSON.stringify({ raw_output: 'first-only' })]);
  assert.equal(saved.length, 1);
  const next = await q(CLAIM_SQL, [first.experiment.id, 'next-turn', 4]);
  assert.equal(next.length, 1);
  assert.equal(next[0].turn_index, 2);
  assert.equal(next[0].sample_ordinal, task.sample_ordinal);
  assert.equal(next[0].variant_key, task.variant_key);
});

test('stop prevents new claims and stays cancelled when an in-flight result is saved', async () => {
  let entered!: () => void, release!: () => void;
  const requested = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const { operation, experiment } = await fixture('stop', 1, async () => {
    entered(); await resume;
    return Response.json({ choices: [{ message: { content: 'already-in-flight' }, finish_reason: 'stop' }] });
  });
  const running = operation('runBatchLabExperimentWorkerOnce', runInput(experiment.id, 'in-flight', 1));
  await requested;
  await operation('stopBatchLabExperiment', { experiment_id: experiment.id, source_environment: 'test' });
  const blocked = await operation('runBatchLabExperimentWorkerOnce', runInput(experiment.id, 'new-worker')) as any;
  assert.equal(blocked.claimed_count, 0);
  release(); await running;
  const stored = await operation('getBatchLabExperiment', { experimentId: experiment.id }) as any;
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.completed_attempts, 1);
  const events = await operation('listBatchLabAttemptEvents', { experimentId: experiment.id }) as any[];
  assert.ok(events.some(event => event.event_type === 'stop_requested'));
});

test('two experiments executing at once save only their own frozen inputs and generated outputs', async () => {
  const first = await fixture('parallel-first', 1);
  const second = await fixture('parallel-second', 1);
  await Promise.all([
    first.operation('runBatchLabExperimentWorkerOnce', runInput(first.experiment.id, 'first-member')),
    second.operation('runBatchLabExperimentWorkerOnce', runInput(second.experiment.id, 'second-member')),
  ]);
  for (const [label, item] of [['parallel-first', first], ['parallel-second', second]] as const) {
    const result = await item.operation('getBatchLabExperimentResults', { experimentId: item.experiment.id }) as any;
    assert.equal(result.experiment.completed_attempts, 4);
    assert.equal(result.experiment.status, 'completed');
    assert.ok(result.attempts.every((attempt: any) => attempt.experiment_id === item.experiment.id && attempt.raw_output.includes(label)));
    const rows = await q(`SELECT data FROM lab_attempts WHERE experiment_id=$1`, [item.experiment.id]);
    assert.ok(rows.every(row => row.data.input_messages[0].content === `context:${label}`));
  }
});

test('expired execution is visible, retry retains history, and the old owner cannot overwrite a new execution', async () => {
  const { operation, experiment } = await fixture('interrupted');
  const [original] = await q(CLAIM_SQL, [experiment.id, 'original-worker', 1]);
  await q(`UPDATE lab_attempts SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [original.id]);
  const visible = await operation('getBatchLabExperimentResults', { experimentId: experiment.id }) as any;
  assert.equal(visible.attempts.find((row: any) => row.id === original.id).status, 'unknown');
  assert.equal(visible.attempts.find((row: any) => row.sample_ordinal === original.sample_ordinal && row.variant_key === original.variant_key && row.turn_index === 2).status, 'blocked');
  await operation('retryBatchLabExperiment', { experiment_id: experiment.id });
  const [current] = await q(CLAIM_SQL, [experiment.id, 'current-worker', 1]);
  assert.equal(current.id, original.id);
  assert.equal(current.attempt_count, 2);
  assert.deepEqual(await q(COMPLETE_SQL, [original.id, original.experiment_id, original.lease_owner, original.attempt_count, 'succeeded', JSON.stringify({ raw_output: 'stale' })]), []);
  const events = await operation('listBatchLabAttemptEvents', { experimentId: experiment.id }) as any[];
  assert.ok(events.some(event => event.event_type === 'interrupted'));
  assert.ok(events.some(event => event.event_type === 'retry_requested'));
  assert.ok(events.filter(event => event.event_type === 'claimed' && event.attempt_id === original.id).length === 2);
});

test('execution saves actual messages and outputs; reuse display never calls the model again', async () => {
  let calls = 0;
  const { operation, experiment } = await fixture('reuse', 1, async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.temperature, 0.4);
    return Response.json({ id: `generation-${calls}`, choices: [{ message: { content: `saved:${body.messages.at(-1).content}:${body.model}` }, finish_reason: 'stop' }] });
  });
  const completed = await operation('runBatchLabExperimentWorkerOnce', runInput(experiment.id, 'generation')) as any;
  assert.equal(completed.completed_count, 4);
  const before = await operation('getBatchLabExperimentResults', { experimentId: experiment.id }) as any;
  assert.ok(before.attempts.every((attempt: any) => !('input_messages' in attempt)));
  const persisted = await q(`SELECT data FROM lab_attempts WHERE experiment_id=$1`, [experiment.id]);
  assert.ok(persisted.every((row: any) => row.data.input_messages[0].content === 'context:reuse'));
  const copied = await operation('createBatchLabReuseDisplayExperiment', { source_experiment_id: experiment.id, name: 'new-display',
    source_environment: 'test', idempotency_key: randomUUID(), variants: [variant('a', 1), variant('b', 1)] }) as any;
  await operation('startBatchLabExperiment', { experiment_id: copied.id, source_environment: 'test', idempotency_key: randomUUID() });
  await operation('runBatchLabExperimentWorkerOnce', runInput(copied.id, 'display-only'));
  assert.equal(calls, 4);
  const after = await operation('getBatchLabExperimentResults', { experimentId: copied.id }) as any;
  assert.deepEqual(after.attempts.map((attempt: any) => attempt.raw_output), before.attempts.map((attempt: any) => attempt.raw_output));
  assert.ok(after.attempts.every((attempt: any) => attempt.reused_from_attempt_id));
  assert.ok(after.attempts.every((attempt: any) => attempt.experiment_id === copied.id));
});

test('annotation global targets do not duplicate; exports include global annotations', async () => {
  const { operation, experiment } = await fixture('annotations', 1);
  const annotation = { experiment_id: experiment.id, sample_ordinal: null, turn_index: null, tag: 'review', note: 'first', source_environment: 'test' };
  await operation('upsertBatchLabAnnotation', annotation);
  await operation('upsertBatchLabAnnotation', { ...annotation, note: 'updated' });
  const rows = await q(`SELECT data FROM lab_annotations WHERE experiment_id=$1`, [experiment.id]);
  assert.equal(rows.length, 1);
  const output = await operation('downloadBatchLabExperimentJsonl', { experimentId: experiment.id }) as string;
  assert.ok(output.trim().split('\n').every(row => JSON.parse(row).annotations[0].note === 'updated'));
});

test('large result pages stay bounded while full Unicode outputs and display data remain retrievable', async () => {
  const { operation, experiment } = await fixture('large-output', 5);
  const raw = '"'.repeat(24_000) + '😀甲';
  const display = { id: randomUUID(), processor_version_id: randomUUID(), processor_digest: 'sha256:' + 'a'.repeat(64),
    input_text: raw, output_text: raw, sanitized_html: raw.replaceAll('"', '&quot;'), status: 'success', match_count: 0,
    error_code: null, renderer: { protocol: 'batch_lab_html_v1', version: 1 } };
  await q(`UPDATE lab_attempts SET status='succeeded',data=data || $2::jsonb WHERE experiment_id=$1`, [experiment.id, JSON.stringify({
    raw_output: raw, display_result: display, input_messages: [{ role: 'user', content: '甲'.repeat(30_000) }],
  })]);
  await q(`UPDATE lab_snapshots SET data=data || $2::jsonb WHERE sample_set_id=$1`, [experiment.sample_set_id,
    JSON.stringify({ history: [{ role: 'system', content: 's'.repeat(350_000) }] })]);
  const first = await operation('getBatchLabExperimentResults', { experimentId: experiment.id }) as any;
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 3 * 1024 * 1024);
  assert.equal(first.samples.length, 1);
  assert.equal(first.next_sample_cursor, '1');
  assert.ok(first.attempts.every((attempt: any) => attempt.preview_truncated && !('input_messages' in attempt)));
  const second = await operation('getBatchLabExperimentResults', { experimentId: experiment.id, input: { cursor: first.next_sample_cursor } }) as any;
  assert.equal(second.samples[0].ordinal, 1);
  assert.equal(second.next_sample_cursor, null);
  let cursor: string | null = null;
  let restored = '';
  do {
    const part = await operation('getBatchLabAttemptContent', { attemptId: first.attempts[0].id, field: 'raw_output', cursor: cursor ?? 0, limit: 10_000 }) as any;
    restored += part.text; cursor = part.next_cursor;
  } while (cursor !== null);
  assert.equal(restored, raw);
  let displayJson = ''; cursor = null;
  do {
    const part = await operation('getBatchLabAttemptContent', { attemptId: first.attempts[0].id, field: 'display_result', cursor: cursor ?? 0 }) as any;
    displayJson += part.text; cursor = part.next_cursor;
  } while (cursor !== null);
  assert.deepEqual(JSON.parse(displayJson), display);
});

test('request messages preserve frozen history, and server keys cannot be sent to arbitrary hosts', () => {
  const history = [{ role: 'system' as const, content: 'frozen' }];
  const messages = buildAttemptMessages(history, ['previous'], 'next', { content: 'brief', format: 'json' });
  assert.deepEqual(messages.map(message => message.role), ['system', 'system', 'assistant', 'user']);
  assert.equal(history.length, 1);
  assert.equal(modelUrl('https://openrouter.ai/api/v1', {}), 'https://openrouter.ai/api/v1/chat/completions');
  assert.throws(() => modelUrl('https://attacker.example/api/v1', {}), /允许列表/);
  assert.throws(() => modelUrl('http://127.0.0.1', {}), /允许列表/);
  assert.equal(modelUrl('https://models.example/v1', { BATCH_LAB_ALLOWED_MODEL_HOSTS: 'models.example' }), 'https://models.example/v1/chat/completions');
});
