import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Papa from 'papaparse';
import { importSourceFiles, prepareSourceImport, scanSourceCsv } from './import-source.js';

let directory: string;
let db: PGlite;
const provenance = {
  source: 'supabase', project_ref: 'wbtsfzozlmurljvglhpn', project_name: 'ST_telegrambot',
  schema: 'experience', table: 'chat_history', time_column: 'created_at',
  start_utc: '2026-09-23T16:00:00Z', end_utc_exclusive: '2026-09-24T04:00:00Z',
  start_beijing: '2026-09-24T00:00:00+08:00', end_beijing_exclusive: '2026-09-24T12:00:00+08:00',
  timezone: 'Asia/Shanghai', snapshot_cutoff_utc: '2026-09-24T03:26:41.882742Z',
  exported_at: '2026-09-24T03:30:00Z', row_counts: { history: 2, sessions: 1, characters: 1 },
};
let manifest: any;
let manifestPath: string;
let original: Buffer;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'batch-lab-stream-import-'));
  db = new PGlite();
  await db.exec(await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8'));
  original = Buffer.from('\uFEFF' + Papa.unparse([
    { id: 'h1', session_id: 's1', character_id: 'c1', user_input: '大于2MB也保存', model: 'test', history: JSON.stringify([{ role: 'user', content: '汉'.repeat(750_000) + '\nquote"comma,' }]) },
    { id: 'h2', session_id: 's1', character_id: 'c1', user_input: 'second', model: 'test', history: '[]' },
  ], { newline: '\r\n' }) + '\r\n');
  await writeFile(path.join(directory, 'history.csv'), original);
  await writeFile(path.join(directory, 'sessions.csv'), 'id,deleted_at\r\ns1,\r\n');
  await writeFile(path.join(directory, 'characters.csv'), 'id,name\r\nc1,角色\r\n');
  manifest = {
    schema_version: 1, name: '本地流式导入验证', idempotency_key: randomUUID(),
    files: ['history', 'sessions', 'characters'].map(kind => ({ kind, path: `${kind}.csv` })), provenance,
  };
  manifestPath = path.join(directory, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
});

after(async () => { await db?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const execute = async (text: string, values: any[] = []) => (await db.query(text, values)).rows as any[];

test('stream parsing handles split UTF-8, BOM, multiline CSV and a row larger than 2 MB', async () => {
  let rows = 0;
  const summary = await scanSourceCsv(path.join(directory, 'history.csv'), 'history', async (row, ordinal) => {
    assert.equal(ordinal, rows++);
    if (ordinal === 0) {
      assert.equal(row.id, 'h1');
      const message = JSON.parse(row.history)[0].content;
      assert.equal(message, '汉'.repeat(750_000) + '\nquote"comma,');
    }
  });
  assert.equal(summary.rows, 2);
  assert.equal(summary.size, original.length);
  assert.equal(summary.sha256, hash(original));
});

test('dry run validates all files and provenance without any database call', async () => {
  const result = await importSourceFiles(manifestPath, { dryRun: true, execute: async () => { throw new Error('must not access database'); } });
  assert.equal(result.dry_run, true);
  assert.equal(result.files[0].rows, 2);
  assert.equal(result.files[0].sha256, hash(original));
  assert.equal(result.provenance.snapshot_cutoff_utc, provenance.snapshot_cutoff_utc);
});

test('a failed stream import resumes safely and preserves complete original bytes and rows', async () => {
  let rowWrites = 0;
  await assert.rejects(() => importSourceFiles(manifestPath, { execute: async (text, values) => {
    if (text.includes('WITH saved AS') && ++rowWrites === 2) throw new Error('simulated interrupted write');
    return execute(text, values);
  } }), /simulated/);
  const [unfinished] = await execute('SELECT id,status FROM lab_datasets WHERE idempotency_key=$1', [manifest.idempotency_key]);
  assert.equal(unfinished.status, 'uploading');
  const ready = await importSourceFiles(manifestPath, { execute });
  assert.equal(ready.id, unfinished.id);
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.counts, { history_count: 2, session_count: 1, character_count: 1, previewable_history_count: 2 });
  const chunks = await execute("SELECT data FROM lab_source_chunks WHERE dataset_id=$1 AND kind='history' ORDER BY chunk_index", [ready.id]);
  assert.equal(hash(Buffer.concat(chunks.map(row => Buffer.from(row.data, 'base64')))), hash(original));
  const [stored] = await execute("SELECT data FROM lab_source_rows WHERE dataset_id=$1 AND kind='history' AND row_id='h1'", [ready.id]);
  assert.equal(JSON.parse(stored.data.history)[0].content.length, 750_000 + '\nquote"comma,'.length);
  const repeated = await importSourceFiles(manifestPath, { execute });
  assert.equal(repeated.version, ready.version);
  assert.equal(repeated.resumed, true);
});

test('wrong row counts, secret fields, timezone mismatches and escaping paths fail before writes', async () => {
  for (const [label, replacement] of [
    ['rows', { ...manifest, provenance: { ...provenance, row_counts: { ...provenance.row_counts, history: 3 } } }],
    ['secret', { ...manifest, provenance: { ...provenance, service_role_key: 'not-a-real-key' } }],
    ['time', { ...manifest, provenance: { ...provenance, start_beijing: '2026-09-23T00:00:00+08:00' } }],
    ['path', { ...manifest, files: [{ kind: 'history', path: '../outside.csv' }, ...manifest.files.slice(1)] }],
  ] as const) {
    const file = path.join(directory, `${label}.json`);
    await writeFile(file, JSON.stringify(replacement));
    await assert.rejects(() => prepareSourceImport(file));
  }
});
