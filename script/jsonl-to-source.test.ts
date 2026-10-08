import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import Papa from 'papaparse';
import { convertJsonlSource } from './jsonl-to-source.js';

test('JSONL conversion writes only history and characters with either new or legacy provenance', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'batch-lab-two-source-'));
  try {
    const source = path.join(directory, 'source');
    await mkdir(path.join(source, 'history'), { recursive: true });
    await mkdir(path.join(source, 'relations'), { recursive: true });
    const history = [
      { id: 'h1', user_id: 'u1', character_id: 'c1', created_at: '2026-09-24T00:00:00Z', user_input: '中文🙂', model: 'test', history: [] },
      { id: 'h2', source_user_id: 'u2', source_character_id: 'c1', created_at: '2026-09-24T01:00:00Z', user_input: '后续', model: 'test', history: [{ role: 'user', content: '引号"和\n换行' }] },
    ];
    await writeFile(path.join(source, 'history', 'page-1.jsonl'), history.map(row => JSON.stringify(row)).join('\n') + '\n');
    await writeFile(path.join(source, 'relations', 'characters-1.jsonl'), JSON.stringify({ id: 'c1', name: '角色' }) + '\n');
    // Obsolete session exports must neither be read nor deleted by the converter.
    const legacyPath = path.join(source, 'relations', 'sessions-1.jsonl');
    await writeFile(legacyPath, 'legacy session export is not required\n');
    for (const legacy of [false, true]) {
      const metadata = {
        schema_version: 1, name: legacy ? '旧元数据' : '两表元数据', idempotency_key: randomUUID(),
        provenance: {
          source: 'supabase', project_ref: 'wbtsfzozlmurljvglhpn', schema: 'experience', table: 'chat_history', time_column: 'created_at',
          start_utc: '2026-09-23T16:00:00Z', end_utc_exclusive: '2026-09-24T04:00:00Z',
          start_beijing: '2026-09-24T00:00:00+08:00', end_beijing_exclusive: '2026-09-24T12:00:00+08:00',
          timezone: 'Asia/Shanghai', snapshot_cutoff_utc: '2026-09-24T03:00:00Z', exported_at: '2026-09-24T03:30:00Z',
          row_counts: { history: 2, characters: 1, ...(legacy ? { sessions: 999 } : {}) },
        },
      };
      const metadataPath = path.join(directory, `metadata-${legacy}.json`);
      const output = path.join(directory, `output-${legacy}`);
      await writeFile(metadataPath, JSON.stringify(metadata));
      const result = await convertJsonlSource(source, output, metadataPath);
      assert.deepEqual(result.files.map(file => file.kind), ['history', 'characters']);
      assert.deepEqual((await readdir(output)).sort(), ['characters_rows.csv', 'chat_history_rows.csv', 'manifest.json']);
      const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
      assert.deepEqual(manifest.provenance.row_counts, metadata.provenance.row_counts);
      const rows = Papa.parse<Record<string, string>>(await readFile(path.join(output, 'chat_history_rows.csv'), 'utf8'), { header: true, skipEmptyLines: 'greedy' }).data;
      assert.equal(rows.length, 2);
      assert.equal(rows[0].session_id, undefined);
      assert.equal(rows[0].user_input, history[0].user_input);
      assert.deepEqual(JSON.parse(rows[1].history), history[1].history);
    }
    assert.equal(await readFile(legacyPath, 'utf8'), 'legacy session export is not required\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
