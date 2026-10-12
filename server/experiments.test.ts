import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createExperimentService, CLAIM_SQL, COMPLETE_SQL, buildAttemptMessages, modelUrl } from './experiments.js';
import { extractInstructionSlots, fillInstructionSlots, pureUserInput, withInstructionPrompt } from '../src/lib/instruction-prompt.js';
import { excludeLastTurn } from '../src/lib/replay-sample.js';

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
      ordinal, source_history_id: randomUUID(), history: [{ role: 'system', content: `context:${label}` },
        ...Array.from({ length: turns - 1 }, (_, index) => [
          { role: 'user', content: `${label}:${ordinal}:earlier-${index}` },
          { role: 'assistant', content: `old-reply-${index}` },
        ]).flat()], user_input: `${label}:${ordinal}`, original_assistant_reply: `online-final:${label}:${ordinal}`, original_model: 'online-model',
    })]);
  }
  const operation = createExperimentService({ query: q, transaction, fetch: fetcher, env });
  const input = { exclude_last_turn: false, name: label, sample_set_id: setId, source_environment: 'test', run_mode: turns > 1 ? 'multi_turn' : 'single', idempotency_key: randomUUID(), variants: [variant('a', turns), variant('b', turns)] };
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

test('debug runs freeze one random sample across start and result pages', async () => {
  const { operation, input } = await fixture('random-debug', 1);
  const experiment: any = await operation('createBatchLabExperiment', {
    ...input, name: 'random-debug-one', sample_limit: 1, idempotency_key: randomUUID(),
  });
  assert.equal(experiment.sample_limit, 1);
  assert.equal(experiment.selected_sample_ordinals.length, 1);
  await operation('startBatchLabExperiment', { experiment_id: experiment.id, source_environment: 'test', idempotency_key: randomUUID() });
  const attempts = await q(`SELECT sample_ordinal FROM lab_attempts WHERE experiment_id=$1 ORDER BY sample_ordinal`, [experiment.id]);
  assert.equal(attempts.length, 2);
  assert.deepEqual([...new Set(attempts.map(row => row.sample_ordinal))], experiment.selected_sample_ordinals);
  const results: any = await operation('getBatchLabExperimentResults', { experimentId: experiment.id, input: { limit: 5 } });
  assert.deepEqual(results.samples.map((sample: any) => sample.ordinal), experiment.selected_sample_ordinals);
  const copied: any = await operation('copyBatchLabExperiment', {
    source_experiment_id: experiment.id, name: 'random-debug-copy', source_environment: 'test', idempotency_key: randomUUID(),
  });
  assert.equal(copied.sample_limit, 1);
  assert.equal(copied.selected_sample_ordinals.length, 1);
});

test('experiments retain the frozen two-table sources',async()=>{
  const {operation,input}=await fixture('derived-session-lineage');
  const source_versions={
    history:{dataset_version_id:randomUUID(),dataset_version_number:2,dataset_version_name:'聊天',row_count:4},
    characters:{dataset_version_id:randomUUID(),dataset_version_number:3,dataset_version_name:'角色',row_count:1},
  };
  await q("UPDATE lab_records SET data=(data-'dataset_version_id') || $2::jsonb WHERE kind='sample_set' AND id=$1",[input.sample_set_id,JSON.stringify({source_versions})]);
  const experiment:any=await operation('createBatchLabExperiment',{...input,idempotency_key:randomUUID()});
  const stored:any=await operation('getBatchLabExperiment',{experimentId:experiment.id});
  assert.deepEqual(stored.source_versions,source_versions);
  assert.equal(stored.dataset_version_id,undefined);
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

test('execution saves original output and bypasses legacy processors; rich-text reuse is disabled', async () => {
  let calls = 0;
  const { operation, experiment } = await fixture('reuse', 1, async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.temperature, 0.4);
    return Response.json({ id: `generation-${calls}`, choices: [{ message: { content: `saved:${body.messages.at(-1).content}:${body.model}` }, finish_reason: 'stop' }] });
  });
  const legacyVariants = experiment.variants.map((v:any)=>({...v,processor_version_id:randomUUID()}));
  await q("UPDATE lab_records SET data=data || $2::jsonb WHERE kind='experiment' AND id=$1",[experiment.id,JSON.stringify({variants:legacyVariants})]);
  const completed = await operation('runBatchLabExperimentWorkerOnce', runInput(experiment.id, 'generation')) as any;
  assert.equal(completed.completed_count, 4);
  const before = await operation('getBatchLabExperimentResults', { experimentId: experiment.id }) as any;
  assert.ok(before.attempts.every((attempt: any) => !('input_messages' in attempt)));
  const persisted = await q(`SELECT data FROM lab_attempts WHERE experiment_id=$1`, [experiment.id]);
  assert.ok(persisted.every((row: any) => row.data.input_messages[0].content === 'context:reuse'));
  assert.ok(persisted.every((row:any)=>row.data.raw_output.startsWith('saved:') && row.data.display_result===null));
  await assert.rejects(operation('createBatchLabReuseDisplayExperiment', {source_experiment_id:experiment.id}), /暂未开放/);
  assert.equal(calls,4);
  const copied:any=await operation('copyBatchLabExperiment',{source_experiment_id:experiment.id,name:'副本',source_environment:'test',idempotency_key:randomUUID()});
  assert.ok(copied.variants.every((v:any)=>v.processor_version_id===null));

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
  const first = await operation('getBatchLabExperimentResults', { experimentId: experiment.id, input: { limit: 1 } }) as any;
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
  const messages = buildAttemptMessages(history, [], 'next', { content: 'brief', format: 'json' });
  assert.deepEqual(messages.map(message => message.role), ['system', 'user']);
  assert.equal(history.length, 1);
  assert.equal(modelUrl('https://openrouter.ai/api/v1', {}), 'https://openrouter.ai/api/v1/chat/completions');
  assert.throws(() => modelUrl('https://attacker.example/api/v1', {}), /允许列表/);
  assert.throws(() => modelUrl('http://127.0.0.1', {}), /允许列表/);
  assert.equal(modelUrl('https://models.example/v1', { BATCH_LAB_ALLOWED_MODEL_HOSTS: 'models.example' }), 'https://models.example/v1/chat/completions');
});

test('replay keeps original user inputs, replaces only the selected replies, and does not duplicate wrapped input', () => {
  const history = [
    { role: 'system' as const, content: 'context' },
    { role: 'user' as const, content: 'outside-window' },
    { role: 'assistant' as const, content: 'keep-reply' },
    { role: 'user' as const, content: 'first' },
    { role: 'assistant' as const, content: 'replace-reply' },
    { role: 'user' as const, content: '##系统指令:old\n##用户指令:last\n' },
  ];
  const frozen = JSON.stringify(history);
  assert.deepEqual(buildAttemptMessages(history, [], 'last'), [...history.slice(0, 5), { role: 'user', content: 'last' }]);
  assert.deepEqual(buildAttemptMessages(history, [], 'last', null, 2), history.slice(0, 4));
  assert.deepEqual(buildAttemptMessages(history, ['new-reply'], 'last', null, 2), [
    ...history.slice(0, 4), { role: 'assistant', content: 'new-reply' }, { role: 'user', content: 'last' },
  ]);
  assert.equal(JSON.stringify(history), frozen);
  assert.throws(() => buildAttemptMessages([], [], 'last', null, 2), /只有 1 轮/);
});

test('instruction prompt replaces old wrappers only on replayed turns, as user messages rather than an extra system message', () => {
  const wrap = (input: string) => `##系统指令：旧指令\n内容\n##用户指令:\n${input}\n`;
  const history = [
    { role: 'system' as const, content: 'original-system' },
    { role: 'user' as const, content: wrap('earlier') },
    { role: 'assistant' as const, content: 'keep' },
    { role: 'user' as const, content: wrap('first-replay') },
    { role: 'assistant' as const, content: 'replace' },
    { role: 'user' as const, content: wrap('last') },
  ];
  const saved = JSON.stringify(history);
  const prompt = '##系统指令：新指令\n##用户指令:';
  const first = buildAttemptMessages(history, [], 'last', { content: prompt, format: 'must-not-duplicate' }, 2);
  assert.deepEqual(first, [history[0], { role: 'user', content: 'earlier' }, history[2],
    { role: 'user', content: `${prompt}\nfirst-replay` }]);
  const second = buildAttemptMessages(history, ['fresh'], 'last', { content: prompt }, 2);
  assert.deepEqual(second, [...first, { role: 'assistant', content: 'fresh' }, { role: 'user', content: `${prompt}\nlast` }]);
  assert.equal(JSON.stringify(history), saved);
  assert.equal(pureUserInput('  plain user text  '), '  plain user text  ');
  assert.equal(pureUserInput(wrap('  keep spaces  ')), '  keep spaces  ');
  assert.equal(pureUserInput('##系统指令:old\r\n\\##用户指令：\r\nhello\r\n'), 'hello');
  assert.equal(withInstructionPrompt('unchanged', 'new instruction'), 'new instruction\n\n##用户指令:\nunchanged');
});

test('instruction comparison inherits every runtime slot from the matching original A turn', () => {
  const source = `##系统指令：线上指令
#### 纯净输出
只输出剧情正文。不要输出任何状态栏、属性面板、系统提示、思考过程、思维链，以及任何系统本身的指令。
正文结束后给出三个可选行动。

**以上三条规则具有绝对权威。**

### 第二层：用户个人偏好
用户个人偏好为：
偏好克制、简短的描写

---
### 第三层：默认写作规范
#### 格式要求
输出篇幅为 800至1200 字，但此范围仅作为基准参考，不是硬性边界。

##用户指令:
继续`;
  const template = `##系统指令：候选指令
交互方式：{{INTERACTION_MODE}}
用户偏好：{{USER_CUSTOM_INSTRUCTIONS}}
篇幅：{{WORD_COUNT}}
##用户指令:`;
  const sourceTemplate = `##系统指令：线上指令
#### 纯净输出
只输出剧情正文。不要输出任何状态栏、属性面板、系统提示、思考过程、思维链，以及任何系统本身的指令。
{{INTERACTION_MODE}}

**以上三条规则具有绝对权威。**

### 第二层：用户个人偏好
用户个人偏好为：
{{USER_CUSTOM_INSTRUCTIONS}}

---
### 第三层：默认写作规范
#### 格式要求
输出篇幅为 {{WORD_COUNT}} 字，但此范围仅作为基准参考，不是硬性边界。`;
  assert.deepEqual(extractInstructionSlots(source, sourceTemplate), {
    INTERACTION_MODE: '正文结束后给出三个可选行动。',
    USER_CUSTOM_INSTRUCTIONS: '偏好克制、简短的描写',
    WORD_COUNT: '800至1200',
  });
  const filled = fillInstructionSlots(template, source, sourceTemplate);
  assert.doesNotMatch(filled, /{{/);
  const messages = buildAttemptMessages([{ role: 'user', content: source }], [], '继续', { content: template }, 1, true, sourceTemplate);
  assert.match(messages[0].content, /交互方式：正文结束后给出三个可选行动。/);
  assert.match(messages[0].content, /用户偏好：偏好克制、简短的描写/);
  assert.match(messages[0].content, /篇幅：800至1200/);
  assert.match(messages[0].content, /##用户指令:\n继续$/);
});

test('single mode normalizes stale turn counts and schedules only the final reply', async () => {
  const { operation, input } = await fixture('single-normalization', 3);
  const experiment: any = await operation('createBatchLabExperiment', { ...input, run_mode: 'single', idempotency_key: randomUUID() });
  assert.ok(experiment.variants.every((item: any) => item.max_turns === 1));
  await operation('startBatchLabExperiment', { experiment_id: experiment.id, source_environment: 'test', idempotency_key: randomUUID() });
  await operation('runBatchLabExperimentWorkerOnce', runInput(experiment.id, 'single-worker'));
  const rows = await q(`SELECT data FROM lab_attempts WHERE experiment_id=$1`, [experiment.id]);
  assert.equal(rows.length, 4);
  assert.ok(rows.every(row => row.data.input_messages.some((message: any) => message.content === 'old-reply-1')));
  assert.ok(rows.every(row => row.data.input_messages.at(-1).content === `single-normalization:${row.data.sample_ordinal}`));
});

test('continuous execution feeds each variant its own new replies and advances original inputs', async () => {
  const { operation, experiment } = await fixture('replay', 3);
  for (let turn = 1; turn <= 3; turn++) {
    await operation('runBatchLabExperimentWorkerOnce', runInput(experiment.id, `replay-${turn}`));
  }
  const rows = await q(`SELECT data FROM lab_attempts WHERE experiment_id=$1 ORDER BY turn_index`, [experiment.id]);
  assert.equal(rows.length, 12);
  for (const { data } of rows) {
    const expected = `replay:${data.sample_ordinal}${data.turn_index < 3 ? `:earlier-${data.turn_index - 1}` : ''}`;
    assert.equal(data.status, 'succeeded');
    assert.equal(data.replay_user_input, expected);
    assert.equal(data.input_messages.at(-1).content, expected);
    const replies = data.input_messages.filter((message: any) => message.role === 'assistant');
    assert.equal(replies.length, data.turn_index - 1);
    assert.ok(replies.every((message: any) => message.content.startsWith(`result:test/${data.variant_key}:replay:${data.sample_ordinal}`)));
  }
});

test('insufficient original turns rejects the entire start before scheduling any calls', async () => {
  const { operation, input } = await fixture('short-history', 1);
  const experiment: any = await operation('createBatchLabExperiment', { ...input, run_mode: 'multi_turn', variants: [variant('a', 3), variant('b', 3)], idempotency_key: randomUUID() });
  await assert.rejects(operation('startBatchLabExperiment', { experiment_id: experiment.id, source_environment: 'test', idempotency_key: randomUUID() }), /无法重跑最后 3 轮/);
  const rows = await q(`SELECT id FROM lab_attempts WHERE experiment_id=$1`, [experiment.id]);
  assert.equal(rows.length, 0);
});

test('either fixed variant reuses the matching original reply at every turn without model calls', async () => {
  for (const fixedKey of ['a', 'b']) {
    let calls = 0;
    const { operation, input } = await fixture(`fixed-${fixedKey}`, 3, async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, `test/${fixedKey === 'a' ? 'b' : 'a'}`);
      return Response.json({ choices: [{ message: { content: `new:${calls}` }, finish_reason: 'stop' }] });
    });
    const experiment: any = await operation('createBatchLabExperiment', { ...input, idempotency_key: randomUUID(),
      variants: input.variants.map(v => ({ ...v, generation_mode: v.key === fixedKey ? 'original' : 'generate' })) });
    const start = { experiment_id: experiment.id, source_environment: 'test', idempotency_key: randomUUID() };
    await operation('startBatchLabExperiment', start);
    await operation('startBatchLabExperiment', start);
    const before: any = await operation('getBatchLabExperimentResults', { experimentId: experiment.id });
    assert.equal(before.progress.completed_attempts, 6);
    assert.equal(calls, 0);
    const fixed = before.attempts.filter((attempt: any) => attempt.variant_key === fixedKey);
    assert.equal(fixed.length, 6);
    for (const row of fixed) {
      assert.equal(row.raw_output, row.turn_index === 3 ? `online-final:fixed-${fixedKey}:${row.sample_ordinal}` : `old-reply-${row.turn_index - 1}`);
      assert.equal(row.finish_reason, 'original_reused');
    }
    for (let turn = 0; turn < 3; turn++) await operation('runBatchLabExperimentWorkerOnce', runInput(experiment.id, `fixed-worker-${turn}`));
    assert.equal(calls, 6);
    const after: any = await operation('getBatchLabExperimentResults', { experimentId: experiment.id });
    assert.equal(after.experiment.status, 'completed');
    assert.equal(after.samples[0].replay_start_index, 1);
    assert.ok(after.attempts.filter((row: any) => row.variant_key === fixedKey).every((row: any) => row.attempt_count === 0));
  }
});

test('both original groups finish immediately; missing original data never falls back to generation', async () => {
  const { operation, input } = await fixture('fixed-only', 1, async () => { throw new Error('must not call model'); });
  const create = { ...input, variants: input.variants.map(v => ({ ...v, generation_mode: 'original' })) };
  const experiment: any = await operation('createBatchLabExperiment', { ...create, idempotency_key: randomUUID() });
  const started: any = await operation('startBatchLabExperiment', { experiment_id: experiment.id, source_environment: 'test', idempotency_key: randomUUID() });
  assert.equal(started.status, 'completed');
  assert.equal(started.completed_attempts, 4);
  await q(`UPDATE lab_snapshots SET data=data-'original_assistant_reply' WHERE sample_set_id=$1`, [input.sample_set_id]);
  const missing: any = await operation('createBatchLabExperiment', { ...create, idempotency_key: randomUUID() });
  await assert.rejects(operation('startBatchLabExperiment', { experiment_id: missing.id, source_environment: 'test', idempotency_key: randomUUID() }), /缺少原始线上回复/);
  assert.equal((await q('SELECT id FROM lab_attempts WHERE experiment_id=$1', [missing.id])).length, 0);
});

test('per-turn preferences persist, update, and remain isolated across samples, turns, and experiments', async () => {
  const { operation, experiment } = await fixture('preferences', 2);
  const input = { experiment_id: experiment.id, sample_ordinal: 0, turn_index: 1, tag: 'preference:a', note: null, source_environment: 'test' };
  await assert.rejects(operation('upsertBatchLabAnnotation', input), /完成后才能评价/);
  await operation('runBatchLabExperimentWorkerOnce', runInput(experiment.id, 'preferences-1'));
  await operation('runBatchLabExperimentWorkerOnce', runInput(experiment.id, 'preferences-2'));
  await operation('upsertBatchLabAnnotation', input);
  await operation('upsertBatchLabAnnotation', { ...input, tag: 'preference:b' });
  await operation('upsertBatchLabAnnotation', { ...input, turn_index: 2, tag: 'preference:tie' });
  await operation('upsertBatchLabAnnotation', { ...input, sample_ordinal: 1 });
  await assert.rejects(operation('upsertBatchLabAnnotation', { ...input, tag: 'preference:unknown' }), /有效/);
  const result: any = await operation('getBatchLabExperimentResults', { experimentId: experiment.id });
  assert.equal(result.annotations.length, 3);
  assert.equal(result.annotations.find((row: any) => row.sample_ordinal === 0 && row.turn_index === 1).tag, 'preference:b');
  const exported: any = await operation('downloadBatchLabExperimentJsonl', { experimentId: experiment.id });
  assert.match(exported, /preference:b/);
  const other = await fixture('other-preferences', 1);
  assert.equal(((await other.operation('getBatchLabExperimentResults', { experimentId: other.experiment.id })) as any).annotations.length, 0);
  await operation('upsertBatchLabAnnotation', { ...input, tag: null });
  const cleared: any = await operation('getBatchLabExperimentResults', { experimentId: experiment.id });
  assert.equal(cleared.annotations.find((row: any) => row.sample_ordinal === 0 && row.turn_index === 1).tag, null);
});

test('new experiments drop the final source turn and align generated and original groups on preceding turns', async () => {
  const requests: any[] = [];
  const { operation, input } = await fixture('exclude-final', 3, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    return Response.json({ choices: [{ message: { content: 'new reply' }, finish_reason: 'stop' }] });
  });
  for (const mode of ['single', 'multi_turn']) {
    const experiment: any = await operation('createBatchLabExperiment', { ...input, exclude_last_turn: undefined,
      run_mode: mode, idempotency_key: randomUUID(), variants: [
        { ...variant('a', 2), generation_mode: 'original' },
        { ...variant('b', 2), output_preset: { name: 'new', content: 'new instruction', format: '' } },
      ] });
    assert.equal(experiment.exclude_last_turn, true);
    await operation('startBatchLabExperiment', { experiment_id: experiment.id, source_environment: 'test', idempotency_key: randomUUID() });
    for (let turn = 0; turn < (mode === 'single' ? 1 : 2); turn++) await operation('runBatchLabExperimentWorkerOnce', runInput(experiment.id, `exclude-${turn}`));
    const result: any = await operation('getBatchLabExperimentResults', { experimentId: experiment.id });
    assert.equal(result.experiment.status, 'completed');
    assert.equal(result.samples[0].user_input, 'exclude-final:0:earlier-1');
    assert.equal(result.samples[0].original_assistant_reply, 'old-reply-1');
    for (const row of result.attempts.filter((item: any) => item.variant_key === 'a')) {
      assert.equal(row.raw_output, `old-reply-${mode === 'single' ? 1 : row.turn_index - 1}`);
    }
  }
  assert.equal(requests.length, 6);
  assert.ok(requests.every(body => body.messages.at(-1).content.startsWith('new instruction\n\n##用户指令:\nexclude-final:')));
  assert.ok(requests.every(body => body.messages.at(-1).content.includes(':earlier-')));
  const original = (await q('SELECT data FROM lab_snapshots WHERE sample_set_id=$1 AND ordinal=0', [input.sample_set_id]))[0].data;
  assert.equal(original.user_input, 'exclude-final:0');
  assert.equal(original.original_assistant_reply, 'online-final:exclude-final:0');
  const saved = JSON.stringify(original);
  const derived = excludeLastTurn({ ...original, turn_index: 43 });
  assert.equal(derived.turn_index, 42);
  assert.equal(JSON.stringify(original), saved);
  assert.throws(() => excludeLastTurn({ history: [], user_input: 'only turn' }), /没有可用/);
});

test('saved concurrency controls parallel calls, supports more than four, and survives copying', async () => {
  for (const concurrency of [1, 6]) {
    let started = 0;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { operation, input, experiment: defaultExperiment } = await fixture('concurrency', 1, async () => {
      started++;
      if (started === concurrency) entered();
      await gate;
      return Response.json({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] });
    });
    assert.equal(defaultExperiment.concurrency, 4);
    await q(`INSERT INTO lab_snapshots(sample_set_id,ordinal,data)
      SELECT sample_set_id,n,data FROM lab_snapshots CROSS JOIN generate_series(2,5) n WHERE sample_set_id=$1 AND ordinal=0`, [input.sample_set_id]);
    const experiment: any = await operation('createBatchLabExperiment', { ...input, concurrency, idempotency_key: randomUUID() });
    await operation('startBatchLabExperiment', { experiment_id: experiment.id, source_environment: 'test', idempotency_key: randomUUID() });
    const running = operation('runBatchLabExperimentWorkerOnce', runInput(experiment.id, 'parallel', 20));
    await ready;
    assert.equal(started, concurrency);
    release();
    const result: any = await running;
    assert.equal(result.claimed_count, concurrency);
    assert.equal(result.completed_count, concurrency);
    const copied: any = await operation('copyBatchLabExperiment', { source_experiment_id: experiment.id, name: 'copy', source_environment: 'test', idempotency_key: randomUUID() });
    assert.equal(copied.concurrency, concurrency);
    const maximum: any = await operation('createBatchLabExperiment', { ...input, concurrency: 100, idempotency_key: randomUUID() });
    assert.equal(maximum.concurrency, 100);
    await assert.rejects(operation('createBatchLabExperiment', { ...input, concurrency: 101, idempotency_key: randomUUID() }));
  }
});

test('model comparison uses a manual shared prompt and identical request settings except model', async () => {
  const requests: any[] = [];
  const { operation, input } = await fixture('model-variable', 1, async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { content: 'model result' }, finish_reason: 'stop' }] });
  });
  const shared = { name: 'manual', content: 'Manually supplied instruction', format: '' };
  const experiment: any = await operation('createBatchLabExperiment', { ...input, comparison_variable: 'model', output_preset: shared,
    variants: [{ ...variant('a', 1), model_source: 'sample', generation_mode: 'original' },
      { ...variant('b', 1), output_preset: { ...shared, content: 'must not override shared prompt' }, sampling: { temperature: 1.2 } }],
    idempotency_key: randomUUID() });
  assert.ok(experiment.variants.every((v: any) => v.generation_mode === 'generate' && v.output_preset.content === shared.content));
  await operation('startBatchLabExperiment', { experiment_id: experiment.id, source_environment: 'test', idempotency_key: randomUUID() });
  await operation('runBatchLabExperimentWorkerOnce', runInput(experiment.id, 'models'));
  assert.equal(requests.length, 4);
  for (const ordinal of [0, 1]) {
    const pair = requests.filter(body => body.messages.at(-1).content.endsWith(`model-variable:${ordinal}`));
    assert.equal(pair.length, 2);
    assert.deepEqual(pair.map(body => body.model).sort(), ['online-model', 'test/b']);
    assert.deepEqual(pair[0].messages, pair[1].messages);
    assert.deepEqual({ ...pair[0], model: null }, { ...pair[1], model: null });
    assert.match(pair[0].messages.at(-1).content, /^Manually supplied instruction/);
  }
  const result: any = await operation('getBatchLabExperimentResults', { experimentId: experiment.id });
  assert.equal(result.experiment.comparison_variable, 'model');
  assert.ok(result.attempts.every((a: any) => a.request_model === (a.variant_key === 'a' ? 'online-model' : 'test/b')));
  const copied: any = await operation('copyBatchLabExperiment', { source_experiment_id: experiment.id, name: 'models copy', source_environment: 'test', idempotency_key: randomUUID() });
  assert.equal(copied.comparison_variable, 'model');
  assert.equal(copied.output_preset.content, shared.content);
  await assert.rejects(operation('createBatchLabExperiment', { ...input, comparison_variable: 'model', idempotency_key: randomUUID() }), /手动填写/);
});

test('instruction comparison fixes the sample model while retaining the two manual instructions', async () => {
  const requests: any[] = [];
  const { operation, input } = await fixture('instruction-variable', 1, async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { content: 'instruction result' }, finish_reason: 'stop' }] });
  });
  const experiment: any = await operation('createBatchLabExperiment', { ...input, comparison_variable: 'instruction_prompt',
    variants: input.variants.map(v => ({ ...v, output_preset: { name: v.key, content: `instruction-${v.key}`, format: '' } })), idempotency_key: randomUUID() });
  await operation('startBatchLabExperiment', { experiment_id: experiment.id, source_environment: 'test', idempotency_key: randomUUID() });
  await operation('runBatchLabExperimentWorkerOnce', runInput(experiment.id, 'instructions'));
  assert.equal(requests.length, 4);
  assert.ok(requests.every(body => body.model === 'online-model'));
  assert.equal(new Set(requests.map(body => body.messages.at(-1).content.split('\n')[0])).size, 2);
});

test('comparison summary covers every page, groups model pairs, and updates amended or cleared votes', async () => {
  const { operation, experiment } = await fixture('summary', 2);
  const vote = (ordinal: number, turn: number, tag: string | null) => operation('upsertBatchLabAnnotation', {
    experiment_id: experiment.id, sample_ordinal: ordinal, turn_index: turn, tag, note: null, source_environment: 'test',
  });
  await operation('runBatchLabExperimentWorkerOnce', runInput(experiment.id, 'summary-first'));
  await vote(0, 1, 'preference:a');
  await vote(1, 1, 'preference:tie');
  const page: any = await operation('getBatchLabExperimentResults', { experimentId: experiment.id, input: { limit: 1 } });
  assert.equal(page.samples.length, 1);
  const { by_model, ...totals } = page.comparison_summary;
  assert.deepEqual(totals, { total: 4, a_wins: 1, b_wins: 0, ties: 1, unrated: 2, awaiting_results: 2 });
  const modelPair = by_model.find((row: any) => row.model_a === 'test/a' && row.model_b === 'test/b');
  assert.equal(modelPair.a_wins, 1);
  assert.equal(modelPair.ties, 1);
  await operation('runBatchLabExperimentWorkerOnce', runInput(experiment.id, 'summary-second'));
  await vote(0, 1, 'preference:b');
  await vote(1, 1, null);
  const after: any = await operation('getBatchLabExperimentResults', { experimentId: experiment.id, input: { limit: 1, cursor: '1' } });
  assert.deepEqual(after.comparison_summary, { total: 4, a_wins: 0, b_wins: 1, ties: 0, unrated: 3, awaiting_results: 0,
    by_model: [{ model_a: 'test/a', model_b: 'test/b', total: 4, a_wins: 0, b_wins: 1, ties: 0, unrated: 3, awaiting_results: 0 }] });
});

test('per-turn models stay aligned after startup truncation and last-turn exclusion',async()=>{
  const {operation,input}=await fixture('per-turn-models',2);
  const history=[{role:'system',content:'shared'}];
  const turn_models=[];
  for(let turn=1;turn<=8;turn++){
    const user_message_index=history.length;
    history.push({role:'user',content:`user-${turn}`});
    const assistant_message_indices=turn<8?[history.length]:[];
    if(turn<8)history.push({role:'assistant',content:`original-${turn}`});
    turn_models.push({turn_index:turn,user_message_index,assistant_message_indices,source_history_id:randomUUID(),model:`model/${turn}`,llm_model:null});
  }
  await q(`UPDATE lab_snapshots SET data=data || $2::jsonb WHERE sample_set_id=$1`,[input.sample_set_id,JSON.stringify({history,user_input:'user-8',turn_index:8,original_model:'model/8',original_assistant_reply:'original-8',turn_models})]);
  const experiment:any=await operation('createBatchLabExperiment',{...input,idempotency_key:randomUUID(),exclude_last_turn:true,comparison_variable:'instruction_prompt',variants:[{...variant('a',2),generation_mode:'original',model_source:'sample'},{...variant('b',2),generation_mode:'generate',model_source:'sample'}]});
  await operation('startBatchLabExperiment',{experiment_id:experiment.id,source_environment:'test',idempotency_key:randomUUID()});
  await operation('runBatchLabExperimentWorkerOnce',runInput(experiment.id,'turn-model-worker',10));
  await operation('runBatchLabExperimentWorkerOnce',runInput(experiment.id,'turn-model-worker',10));
  const attempts=await q(`SELECT variant_key,turn_index,status,data FROM lab_attempts WHERE experiment_id=$1 ORDER BY sample_ordinal,variant_key,turn_index`,[experiment.id]);
  assert.equal(attempts.length,8);
  for(const attempt of attempts){
    assert.equal(attempt.status,'succeeded');
    assert.equal(attempt.data.request_model,`model/${attempt.turn_index+5}`);
    if(attempt.variant_key==='a')assert.equal(attempt.data.source_model_verified,true);
  }
});
