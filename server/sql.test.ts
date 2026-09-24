import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { compileDatasetQuery } from './sql.js';

const DATASET = '11111111-1111-4111-8111-111111111111';
const OTHER_DATASET = '22222222-2222-4222-8222-222222222222';
const DEFAULT_SQL = `SELECT h.id AS source_history_id
FROM experience.chat_history AS h
JOIN experience.chat_sessions AS s ON s.id = h.session_id
JOIN app_core.characters AS c ON c.id = h.character_id
WHERE h.user_input IS NOT NULL
  AND h.model IS NOT NULL
  AND h.turn_index >= :min_turn
  AND h.revision >= 0
  AND s.deleted_at IS NULL
ORDER BY h.created_at DESC`;
const SIMPLE_SQL = 'SELECT h.id AS source_history_id FROM experience.chat_history AS h';
const injectionText = "中文 ':missing'; DROP TABLE public.lab_source_rows; --";
let db: PGlite;

before(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE lab_source_rows (
    dataset_id uuid NOT NULL, kind text NOT NULL, ordinal int NOT NULL,
    row_id text NOT NULL, data jsonb NOT NULL
  )`);
  const histories = [
    { id: 'h1', turn_index: '1', created_at: '2026-09-23T00:00:00Z', user_input: '你好' },
    { id: 'h2', turn_index: '3', created_at: '2026-09-24T00:00:00Z', user_input: injectionText },
    { id: 'h3', turn_index: '5', created_at: '2026-09-25T00:00:00Z', user_input: 'deleted session', session_id: 'deleted' },
    { id: 'h4', turn_index: 'not a number', created_at: '2026-09-26T00:00:00Z', user_input: 'dirty number' },
    { id: 'h5', turn_index: '2', created_at: 'not a timestamp', user_input: 'dirty date' },
  ];
  let ordinal = 0;
  for (const history of histories) {
    const data = { revision: '0', session_id: 's1', character_id: 'c1', model: 'test-model', ...history };
    await insert(DATASET, 'history', ordinal++, data);
  }
  await insert(DATASET, 'sessions', 0, { id: 's1', deleted_at: '' });
  await insert(DATASET, 'sessions', 1, { id: 'deleted', deleted_at: '2026-09-24T00:00:00Z' });
  await insert(DATASET, 'characters', 0, { id: 'c1', enabled: 'true', is_test: 'dirty boolean' });
  // Same anchor and join IDs in another version must never influence a query.
  await insert(OTHER_DATASET, 'history', 0, { id: 'h1', revision: '0', session_id: 's1', character_id: 'c1', model: 'test-model', turn_index: '99', user_input: 'other version', created_at: '2099-01-01' });
  await insert(OTHER_DATASET, 'sessions', 0, { id: 's1', deleted_at: '' });
  await insert(OTHER_DATASET, 'characters', 0, { id: 'c1', enabled: 'false' });
});

after(async () => { await db?.close(); });

async function insert(dataset: string, kind: string, ordinal: number, row: Record<string, string>): Promise<void> {
  await db.query('INSERT INTO lab_source_rows (dataset_id, kind, ordinal, row_id, data) VALUES ($1, $2, $3, $4, $5)', [dataset, kind, ordinal, row.id, JSON.stringify(row)]);
}

function compile(sql = SIMPLE_SQL, parameters: Record<string, unknown> = {}, sampleLimit = 50) {
  return compileDatasetQuery({ datasetId: DATASET, sql, parameters, sampleLimit });
}

async function anchors(sql: string, parameters: Record<string, unknown> = {}, sampleLimit = 50): Promise<string[]> {
  const query = compile(sql, parameters, sampleLimit);
  const result = await db.query<{ source_history_id: string }>(query.text, query.values);
  return result.rows.map(row => row.source_history_id);
}

test('executes the default SQL and binds the immutable source version', async () => {
  const query = compile(DEFAULT_SQL, { min_turn: 3 });
  assert.deepEqual(query.values, [DATASET, 3, 51]);
  assert.equal((query.text.match(/dataset_id = \$1::uuid/g) ?? []).length, 3);
  assert.deepEqual(await anchors(DEFAULT_SQL, { min_turn: 3 }), ['h2']);
  const otherQuery = compileDatasetQuery({ datasetId: OTHER_DATASET, sql: DEFAULT_SQL, parameters: { min_turn: 3 }, sampleLimit: 50 });
  const other = await db.query<{ source_history_id: string }>(otherQuery.text, otherQuery.values);
  assert.deepEqual(other.rows, [{ source_history_id: 'h1' }]);
});

test('SQL WHERE and ORDER BY actually change the selected anchors and order', async () => {
  const ascending = `${SIMPLE_SQL} WHERE h.turn_index BETWEEN :min AND :max ORDER BY h.turn_index ASC`;
  const descending = ascending.replace('ASC', 'DESC');
  assert.deepEqual(await anchors(ascending, { min: 1, max: 3 }), ['h1', 'h5', 'h2']);
  assert.deepEqual(await anchors(descending, { min: 1, max: 3 }), ['h2', 'h5', 'h1']);
  assert.deepEqual(await anchors(ascending, { min: 3, max: 3 }), ['h2']);
});

test('outer cap returns at most sampleLimit + 1 and respects a smaller SQL LIMIT', async () => {
  assert.deepEqual(await anchors(`${SIMPLE_SQL} ORDER BY h.id`, {}, 2), ['h1', 'h2', 'h3']);
  assert.deepEqual(await anchors(`${SIMPLE_SQL} ORDER BY h.id LIMIT 1`, {}, 2), ['h1']);
});

test('blank and dirty numeric, timestamp and boolean source values become SQL NULL', async () => {
  assert.deepEqual(await anchors(`${SIMPLE_SQL} WHERE h.turn_index IS NULL`), ['h4']);
  assert.deepEqual(await anchors(`${SIMPLE_SQL} WHERE h.created_at IS NULL`), ['h5']);
  const query = `${SIMPLE_SQL} JOIN app_core.characters c ON c.id = h.character_id WHERE c.enabled = true AND c.is_test IS NULL ORDER BY h.id LIMIT 1`;
  assert.deepEqual(await anchors(query), ['h1']);
});

test('parameter contents remain data, including SQL-like text and Chinese characters', async () => {
  const sql = `${SIMPLE_SQL} WHERE h.user_input = :needle`;
  const query = compile(sql, { needle: injectionText });
  assert.equal(query.text.includes('DROP TABLE'), false);
  assert.equal(query.values[1], injectionText);
  assert.deepEqual(await anchors(sql, { needle: injectionText }), ['h2']);
  assert.deepEqual(await anchors(`${SIMPLE_SQL} WHERE h.id = :id OR h.id = :id`, { id: 'h2' }), ['h2']);
  assert.deepEqual(compile(`${SIMPLE_SQL} WHERE h.id = :id OR h.id = :id`, { id: 'h2' }).values, [DATASET, 'h2', 51]);
});

test('parameter tokenizer leaves quoted strings and comments unchanged', async () => {
  const sql = `${SIMPLE_SQL} WHERE 'it''s :ignored' = 'it''s :ignored'
    AND h.id = :id /* :comment */ -- :line
    ORDER BY h.id`;
  assert.deepEqual(await anchors(sql, { id: 'h1' }), ['h1']);
  const quoted = `SELECT "h"."id" AS "source_history_id" FROM "experience"."chat_history" AS "h" WHERE "h"."id" = :id`;
  assert.deepEqual(await anchors(quoted, { id: 'h1' }), ['h1']);
  const escaped = `${SIMPLE_SQL} WHERE E'escaped\\\' :ignored' = E'escaped\\\' :ignored' AND h.id = :id`;
  // The parser does not support these uncommon literals. They fail closed as
  // syntax errors, without treating their contents as named parameters.
  assert.throws(() => compile(escaped, { id: 'h1' }), /请检查 SQL 语法/);
  assert.throws(() => compile(`${SIMPLE_SQL} WHERE $$:ignored$$ = $$:ignored$$`), /请检查 SQL 语法/);
});

test('casts do not become named parameters and resolve only to builtin types', async () => {
  const sql = `${SIMPLE_SQL} WHERE h.turn_index >= :turn::int ORDER BY h.id`;
  assert.match(compile(sql, { turn: 3 }).text, /pg_catalog/);
  assert.deepEqual(await anchors(sql, { turn: 3 }), ['h2', 'h3']);
  assert.deepEqual(await anchors(`${SIMPLE_SQL} WHERE h.created_at >= '2026-09-24'::timestamptz ORDER BY h.id`), ['h2', 'h3', 'h4']);
});

test('schema-qualified columns and unqualified allowed table names are rewritten safely', async () => {
  assert.deepEqual(await anchors('SELECT experience.chat_history.id AS source_history_id FROM experience.chat_history WHERE experience.chat_history.id = :id', { id: 'h2' }), ['h2']);
  assert.deepEqual(await anchors('SELECT id AS source_history_id FROM chat_history WHERE id = :id', { id: 'h1' }), ['h1']);
});

const rejectedSql = [
  'DELETE FROM experience.chat_history',
  'UPDATE experience.chat_history SET user_input = \'changed\'',
  'INSERT INTO experience.chat_history (id) VALUES (\'x\')',
  'DROP TABLE public.lab_source_rows',
  `${SIMPLE_SQL}; DELETE FROM public.lab_source_rows`,
  `${SIMPLE_SQL}; ${SIMPLE_SQL}`,
  'WITH removed AS (DELETE FROM public.lab_source_rows RETURNING *) SELECT id AS source_history_id FROM removed',
  `WITH source AS (${SIMPLE_SQL}) SELECT source_history_id FROM source`,
  `${SIMPLE_SQL} UNION ${SIMPLE_SQL}`,
  'SELECT h.id AS source_history_id INTO stolen FROM experience.chat_history h',
  `${SIMPLE_SQL} FOR UPDATE`,
  `${SIMPLE_SQL} FOR SHARE`,
  'SELECT h.id AS source_history_id FROM public.lab_source_rows h',
  'SELECT h.id AS source_history_id FROM pg_catalog.pg_authid h',
  'SELECT h.id AS source_history_id FROM information_schema.tables h',
  'SELECT h.id AS source_history_id FROM public.chat_history h',
  'SELECT h.id AS source_history_id FROM experience.chat_sessions h',
  'SELECT h.id AS source_history_id FROM generate_series(1, 1000) h',
  `${SIMPLE_SQL} WHERE pg_sleep(10) IS NULL`,
  `${SIMPLE_SQL} WHERE pg_catalog.set_config('statement_timeout','0',true) IS NULL`,
  `${SIMPLE_SQL} WHERE (SELECT count(*) FROM public.lab_source_rows) > 0`,
  `${SIMPLE_SQL} WHERE EXISTS (SELECT 1 FROM public.lab_source_rows)`,
  `${SIMPLE_SQL} WHERE h.id::regclass IS NOT NULL`,
  `${SIMPLE_SQL} WHERE h.id::public.custom_type IS NOT NULL`,
  `${SIMPLE_SQL} WHERE h.id OPERATOR(public.=) 'h1'`,
  `${SIMPLE_SQL} WHERE current_user IS NOT NULL`,
  `${SIMPLE_SQL} WHERE h.dataset_id IS NOT NULL`,
  'SELECT h.* FROM experience.chat_history h',
  'SELECT h.id AS source_history_id, h.user_input FROM experience.chat_history h',
  "SELECT 'invented' AS source_history_id FROM experience.chat_history h",
  'SELECT h.user_input AS source_history_id FROM experience.chat_history h',
  `${SIMPLE_SQL} WHERE h.id = $1`,
];

for (const sql of rejectedSql) {
  test(`rejects unsafe or unsupported SQL: ${sql.slice(0, 100)}`, () => {
    assert.throws(() => compile(sql), /SQL 无效/);
  });
}

test('invalid inputs fail before reaching the database', () => {
  assert.throws(() => compile(`${SIMPLE_SQL} WHERE h.id = :missing`), /缺少参数/);
  assert.throws(() => compile(`${SIMPLE_SQL} WHERE h.id = :id`, { id: {} }), /仅支持/);
  assert.throws(() => compile(`${SIMPLE_SQL} WHERE h.id = :id`, { id: Number.NaN }), /仅支持/);
  assert.throws(() => compile(`${SIMPLE_SQL} WHERE h.id = :id`, { id: 'x'.repeat(1001) }), /1000/);
  assert.throws(() => compile(`${SIMPLE_SQL} WHERE h.id = :toString`), /缺少参数/);
  assert.throws(() => compileDatasetQuery({ datasetId: "'; DROP TABLE x; --", sql: SIMPLE_SQL, parameters: {}, sampleLimit: 50 }), /版本 ID/);
  for (const limit of [0, -1, 501, 1.5, Number.NaN]) assert.throws(() => compile(SIMPLE_SQL, {}, limit), /样本数量/);
  assert.throws(() => compile('x'.repeat(20001)), /20000/);
  assert.throws(() => compile(`${SIMPLE_SQL} /* unfinished`), /注释/);
  assert.throws(() => compile(`${SIMPLE_SQL} WHERE h.id = 'unfinished`), /引号/);
});
