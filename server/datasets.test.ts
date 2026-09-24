import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { neonConfig } from '@neondatabase/serverless';
import Papa from 'papaparse';
import { CHUNK_BYTES, SOURCE_KINDS, datasetOperation, parseSourceCsv, type SourceFile } from './datasets.js';
import { DEFAULT_SAMPLE_SQL, sampleOperation } from './samples.js';

const HISTORY_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const CHARACTER_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const savedDatabaseUrl = process.env.DATABASE_URL;
const savedFetch = neonConfig.fetchFunction;
let db: PGlite;

before(async () => {
  // No database credentials or network are used. Exercise the production data
  // handlers through the Neon wire format, backed only by local PGlite.
  process.env.DATABASE_URL = 'postgresql://test:test@local.invalid/lab';
  db = new PGlite();
  await db.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  neonConfig.fetchFunction = async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body));
    async function execute(connection: { query: PGlite['query'] }, request: { query: string; params: unknown[] }) {
      const result = await connection.query<Record<string, unknown>>(request.query, request.params);
      return {
        ...result,
        rows: result.rows.map(row => result.fields.map(field => {
          const value = row[field.name];
          if (value === null || value === undefined) return null;
          if (field.dataTypeID === 114 || field.dataTypeID === 3802) return JSON.stringify(value);
          if (typeof value === 'boolean') return value ? 't' : 'f';
          if (value instanceof Date) return value.toISOString();
          return String(value);
        })),
      };
    }
    try {
      if (body.queries) {
        const results = await db.transaction(async transaction => {
          if (new Headers(init?.headers).get('Neon-Batch-Read-Only') === 'true') await transaction.exec('SET TRANSACTION READ ONLY');
          const result = [];
          for (const request of body.queries) result.push(await execute(transaction, request));
          return result;
        });
        return Response.json({ results });
      }
      return Response.json(await execute(db, body));
    } catch (error: any) {
      return Response.json({ message: error.message, code: error.code }, { status: 400 });
    }
  };
});

after(async () => {
  neonConfig.fetchFunction = savedFetch;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  await db?.close();
});

type Contents = Record<typeof SOURCE_KINDS[number], Buffer>;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function fixture(label: string, aliases = false, longHistory = false): Contents {
  const history = JSON.stringify([{ role: 'user', content: `${label} 引号"、逗号,\n换行${longHistory ? '汉'.repeat(180_000) : ''}` }]);
  const row: Record<string, string> = {
    id: HISTORY_ID, user_input: `${label} 输入`, history, turn_index: '3', revision: '0', created_at: '2026-09-24T00:00:00Z',
    [aliases ? 'source_session_id' : 'session_id']: SESSION_ID,
    [aliases ? 'source_character_id' : 'character_id']: CHARACTER_ID,
    [aliases ? 'source_user_id' : 'user_id']: USER_ID,
    [aliases ? 'original_model' : 'model']: 'test-model',
    [aliases ? 'original_assistant_reply' : 'assistant_reply']: `${label} 回复`,
  };
  const rawCsv = (rows: Record<string, string>[]) => Buffer.from('\uFEFF' + Papa.unparse(rows, { newline: '\r\n' }) + '\r\n', 'utf8');
  return {
    history: rawCsv([row]),
    sessions: rawCsv([{ id: SESSION_ID, context_window_start_turn: '7', deleted_at: '' }]),
    characters: rawCsv([{ id: CHARACTER_ID, name: `${label} 角色`, system_prompt: `${label} 角色提示词` }]),
  };
}

function manifest(contents: Contents): SourceFile[] {
  return SOURCE_KINDS.map(kind => ({ kind, name: `${kind}.csv`, size: contents[kind].length, sha256: hash(contents[kind]), chunks: Math.ceil(contents[kind].length / CHUNK_BYTES) }));
}

async function begin(contents: Contents, idempotencyKey = randomUUID(), name = '测试原始版本'): Promise<any> {
  return datasetOperation('beginDatasetImport', { name, idempotency_key: idempotencyKey, files: manifest(contents) });
}

async function uploadKind(datasetId: string, kind: typeof SOURCE_KINDS[number], bytes: Buffer): Promise<void> {
  for (let start = 0, index = 0; start < bytes.length; start += CHUNK_BYTES, index++) {
    await datasetOperation('uploadDatasetChunk', { datasetId, kind, index, data: bytes.subarray(start, start + CHUNK_BYTES).toString('base64') });
  }
}

async function importReady(contents: Contents, name = '测试原始版本'): Promise<any> {
  const dataset = await begin(contents, randomUUID(), name);
  for (const kind of SOURCE_KINDS) await uploadKind(dataset.id, kind, contents[kind]);
  return datasetOperation('finishDatasetImport', { datasetId: dataset.id });
}

async function preview(datasetId: string): Promise<any> {
  return sampleOperation('createBatchLabPreview', { dataset_version_id: datasetId, sql: DEFAULT_SAMPLE_SQL, parameters: { min_turn: 1 }, sample_limit: 50 });
}

async function sampleFromPreview(value: any, idempotencyKey = randomUUID(), name = '测试冻结样本'): Promise<any> {
  return sampleOperation('createBatchLabSampleSet', { name, preview_id: value.id, preview_digest: value.digest, idempotency_key: idempotencyKey });
}

test('CSV parsing preserves BOM-compatible Chinese text, commas, quotes and line breaks', () => {
  const content = fixture('原始');
  const rows = parseSourceCsv(content.history.toString('utf8'), 'history');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, HISTORY_ID);
  assert.equal(rows[0].user_input, '原始 输入');
  assert.equal(JSON.parse(rows[0].history)[0].content, '原始 引号"、逗号,\n换行');
});

test('valid single-column CSV is accepted and ambiguous duplicate headers are rejected', () => {
  assert.deepEqual(parseSourceCsv(`id\n${SESSION_ID}\n`, 'sessions'), [{ id: SESSION_ID }]);
  assert.throws(() => parseSourceCsv(`id,id\n${SESSION_ID},${CHARACTER_ID}\n`, 'sessions'), /重复|表头/);
});

test('CSV rejects duplicate identifiers, missing columns and malformed quoting', () => {
  assert.throws(() => parseSourceCsv(`id,name\n${SESSION_ID},one\n${SESSION_ID},two`, 'sessions'), /id.*重复/);
  assert.throws(() => parseSourceCsv('name,title\nmissing,test', 'sessions'), /缺少 id/);
  assert.throws(() => parseSourceCsv(`id,name\n${SESSION_ID},"unfinished`, 'sessions'), /解析失败/);
  assert.throws(() => parseSourceCsv('id,name\n', 'sessions'), /没有数据行/);
});

test('an incomplete import stays hidden; completed CSV downloads match the original bytes exactly', async () => {
  const contents = fixture('字节精确', false, true);
  assert.ok(contents.history.length > CHUNK_BYTES, 'fixture must cross chunk boundaries');
  const idempotencyKey = randomUUID();
  const dataset = await begin(contents, idempotencyKey);
  assert.equal(dataset.status, 'uploading');
  assert.equal((await begin(contents, idempotencyKey)).id, dataset.id);
  assert.equal((await datasetOperation('listBatchLabDatasets', {}) as any[]).some(row => row.id === dataset.id), false);
  await assert.rejects(() => preview(dataset.id), /尚未完成上传/);
  await assert.rejects(() => datasetOperation('getDatasetChunk', { datasetId: dataset.id, kind: 'history', index: 0 }), /尚未完成上传/);
  await uploadKind(dataset.id, 'history', contents.history);
  await assert.rejects(() => datasetOperation('finishDatasetImport', { datasetId: dataset.id }), /尚未完成/);
  assert.equal((await datasetOperation('listBatchLabDatasets', {}) as any[]).some(row => row.id === dataset.id), false);
  for (const kind of ['sessions', 'characters'] as const) await uploadKind(dataset.id, kind, contents[kind]);
  const finished: any = await datasetOperation('finishDatasetImport', { datasetId: dataset.id });
  assert.equal(finished.dataset.status, 'ready');
  assert.equal(finished.previewable_history_count, 1);
  assert.equal((await datasetOperation('listBatchLabDatasets', {}) as any[]).some(row => row.id === dataset.id), true);
  const repeated: any = await datasetOperation('finishDatasetImport', { datasetId: dataset.id });
  assert.equal(repeated.dataset.version, finished.dataset.version);
  for (const file of manifest(contents)) {
    const chunks = [];
    for (let index = 0; index < file.chunks; index++) {
      const value: any = await datasetOperation('getDatasetChunk', { datasetId: dataset.id, kind: file.kind, index });
      chunks.push(Buffer.from(value.data, 'base64'));
    }
    const downloaded = Buffer.concat(chunks);
    assert.equal(downloaded.length, contents[file.kind].length);
    assert.equal(hash(downloaded), hash(contents[file.kind]));
  }
  const changed = Buffer.from(contents.history.subarray(0, CHUNK_BYTES));
  changed[100] ^= 1;
  await assert.rejects(() => datasetOperation('uploadDatasetChunk', { datasetId: dataset.id, kind: 'history', index: 0, data: changed.toString('base64') }), /不能覆盖/);
  const conflictingManifest = manifest(contents).map(file => file.kind === 'history' ? { ...file, sha256: 'f'.repeat(64) } : file);
  await assert.rejects(() => datasetOperation('beginDatasetImport', { name: '测试原始版本', idempotency_key: idempotencyKey, files: conflictingManifest }), /不一致/);
});

test('a checksum mismatch cannot publish a ready source version', async () => {
  const contents = fixture('校验失败');
  const files = manifest(contents).map(file => file.kind === 'history' ? { ...file, sha256: 'f'.repeat(64) } : file);
  const dataset: any = await datasetOperation('beginDatasetImport', { name: '校验失败', idempotency_key: randomUUID(), files });
  for (const kind of SOURCE_KINDS) await uploadKind(dataset.id, kind, contents[kind]);
  await assert.rejects(() => datasetOperation('finishDatasetImport', { datasetId: dataset.id }), /校验失败/);
  assert.equal((await datasetOperation('listBatchLabDatasets', {}) as any[]).some(row => row.id === dataset.id), false);
});

test('frozen samples retain the original version after another import reuses all source IDs', async () => {
  const first = await importReady(fixture('第一版'), '原始 V1');
  const firstPreview = await preview(first.dataset.id);
  assert.equal(firstPreview.items[0].dynamic_input_snapshot.context_window_start_turn, 7);
  const idempotencyKey = randomUUID();
  const [sample, retry] = await Promise.all([
    sampleFromPreview(firstPreview, idempotencyKey),
    sampleFromPreview(firstPreview, idempotencyKey),
  ]);
  assert.equal(sample.id, retry.id);
  assert.equal(sample.dataset_version_id, first.dataset.id);
  const frozenBefore: any = await sampleOperation('listBatchLabSampleSetSamples', { sampleSetId: sample.id });
  assert.equal(frozenBefore.items.length, 1);
  const frozenHash = hash(JSON.stringify(frozenBefore.items));
  const second = await importReady(fixture('第二版'), '原始 V2');
  assert.notEqual(second.dataset.id, first.dataset.id);
  assert.ok(second.dataset.version > first.dataset.version);
  const secondPreview = await preview(second.dataset.id);
  assert.equal(secondPreview.items[0].user_input, '第二版 输入');
  assert.equal(secondPreview.items[0].character_snapshot.system_prompt, '第二版 角色提示词');
  assert.equal((await preview(first.dataset.id)).items[0].user_input, '第一版 输入');
  const frozenAfter: any = await sampleOperation('listBatchLabSampleSetSamples', { sampleSetId: sample.id });
  assert.equal(hash(JSON.stringify(frozenAfter.items)), frozenHash);
  assert.equal(frozenAfter.items[0].original_assistant_reply, '第一版 回复');
  await assert.rejects(() => sampleFromPreview(secondPreview, idempotencyKey), /不一致|冲突/);
  await assert.rejects(() => sampleFromPreview(firstPreview, idempotencyKey, '不同名称'), /不一致|冲突/);
});

test('accepted source_* and original_* CSV columns also work with the default SQL', async () => {
  const imported = await importReady(fixture('别名列', true));
  assert.equal(imported.previewable_history_count, 1);
  const result = await preview(imported.dataset.id);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].source_session_id, SESSION_ID);
  assert.equal(result.items[0].source_character_id, CHARACTER_ID);
  assert.equal(result.items[0].source_user_id, USER_ID);
  assert.equal(result.items[0].original_model, 'test-model');
  assert.equal(result.items[0].original_assistant_reply, '别名列 回复');
});

test('more than 8 MB of selected snapshots are all frozen and remain available through bounded pages', async () => {
  const contents = fixture('完整保留大样本');
  const template = parseSourceCsv(contents.history.toString('utf8'), 'history')[0];
  const histories = Array.from({ length: 6 }, (_, index) => ({
    ...template,
    id: `55555555-5555-4555-8555-${String(index + 1).padStart(12, '0')}`,
    created_at: `2026-09-${String(index + 10).padStart(2, '0')}T00:00:00Z`,
    history: JSON.stringify([{ role: 'user', content: `sample-${index}:` + 'x'.repeat(1_550_000) }]),
  }));
  contents.history = Buffer.from(Papa.unparse(histories, { newline: '\r\n' }), 'utf8');
  assert.ok(contents.history.length > 8 * 1024 * 1024);
  const imported = await importReady(contents, '大于 8 MB 的完整样本');
  const result = await preview(imported.dataset.id);
  assert.equal(result.statistics.valid_count, 6);
  assert.ok(result.statistics.snapshot_bytes > 8 * 1024 * 1024);
  assert.equal(result.statistics.excluded_by_reason.snapshot_budget_exceeded, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2_200_000, 'preview response must stay small while preserving every stored snapshot');
  const sample = await sampleFromPreview(result);
  assert.equal(sample.sample_count, 6);
  const actualHashes = new Map<string, string>();
  let cursor: string | null = null;
  do {
    const page: any = await sampleOperation('listBatchLabSampleSetSamples', { sampleSetId: sample.id, input: { cursor, limit: 5 } });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 2_200_000);
    for (const item of page.items) actualHashes.set(item.source_history_id, hash(JSON.stringify(item.history)));
    cursor = page.next_cursor;
  } while (cursor !== null);
  assert.equal(actualHashes.size, 6);
  for (const row of histories) assert.equal(actualHashes.get(row.id), hash(row.history));
});
