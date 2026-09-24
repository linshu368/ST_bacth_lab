import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import { z } from 'zod';
import { CHUNK_BYTES, SOURCE_KINDS, datasetProvenanceSchema, type SourceRow } from '../server/datasets';
import { query as databaseQuery } from '../server/db';

type Kind = typeof SOURCE_KINDS[number];
type Execute = (text: string, values?: any[]) => Promise<any[]>;
const sourceManifestSchema = z.object({
  schema_version: z.literal(1),
  name: z.string().trim().min(1).max(120),
  idempotency_key: z.string().uuid(),
  files: z.array(z.object({
    kind: z.enum(SOURCE_KINDS), path: z.string().min(1).max(500),
    size: z.number().int().positive().safe().optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict()).length(3),
  provenance: datasetProvenanceSchema,
}).strict();

type Manifest = z.infer<typeof sourceManifestSchema>;
type FileSummary = { kind: Kind; name: string; path: string; size: number; sha256: string; chunks: number; rows: number };
type CsvSummary = { size: number; sha256: string; rows: number };
type PreparedImport = { manifest: Manifest; files: FileSummary[] };

function requiredFields(kind: Kind): string[][] {
  return kind === 'history'
    ? [['id'], ['session_id', 'source_session_id'], ['character_id', 'source_character_id'], ['user_input'], ['model', 'original_model']]
    : [['id']];
}

/** Reads at most a CSV parser chunk and a database batch, never a complete CSV file. */
export async function scanSourceCsv(filePath: string, kind: Kind, onRow?: (row: SourceRow, ordinal: number) => Promise<void>): Promise<CsvSummary> {
  const digest = createHash('sha256');
  let size = 0;
  let rows = 0;
  let headersChecked = false;
  const seen = new Set<string>();
  const source = createReadStream(filePath);
  // Decode across chunk boundaries; hash the original bytes before BOM/CSV parsing.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const text = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      digest.update(chunk); size += chunk.length;
      try { callback(null, decoder.decode(chunk, { stream: true })); } catch { callback(new Error(`${kind} CSV 不是有效 UTF-8`)); }
    },
    flush(callback) {
      try { callback(null, decoder.decode()); } catch { callback(new Error(`${kind} CSV 不是有效 UTF-8`)); }
    },
  });
  text.setEncoding('utf8');
  return await new Promise<CsvSummary>((resolve, reject) => {
    let failed = false;
    function fail(error: unknown) {
      if (failed) return;
      failed = true; source.destroy(); text.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
    source.on('error', fail);
    text.on('error', fail);
    Papa.parse<SourceRow>(text, {
      header: true, skipEmptyLines: 'greedy',
      beforeFirstChunk: chunk => chunk.replace(/^\uFEFF/, ''),
      chunk(result, parser) {
        parser.pause();
        void (async () => {
          const error = result.errors.find(item => item.code !== 'UndetectableDelimiter');
          if (error) throw new Error(`${kind} CSV 解析失败：${error.message}`);
          if (Object.keys(result.meta.renamedHeaders ?? {}).length) throw new Error(`${kind} CSV 存在重复表头`);
          if (!headersChecked && result.meta.fields?.length) {
            for (const group of requiredFields(kind)) {
              if (!group.some(field => result.meta.fields!.includes(field))) throw new Error(`${kind} CSV 缺少 ${group.join(' / ')} 列`);
            }
            headersChecked = true;
          }
          for (const row of result.data) {
            if (!row.id || seen.has(row.id)) throw new Error(`${kind} CSV 的 id 为空或重复`);
            seen.add(row.id);
            await onRow?.(row, rows);
            rows++;
          }
          if (!failed) parser.resume();
        })().catch(error => { fail(error); parser.abort(); });
      },
      complete() {
        if (failed) return;
        if (!headersChecked) { fail(new Error(`${kind} CSV 缺少有效表头`)); return; }
        resolve({ size, sha256: digest.digest('hex'), rows });
      },
      error: fail,
    });
    source.pipe(text);
  });
}

export async function prepareSourceImport(manifestPath: string): Promise<PreparedImport> {
  const resolvedManifest = await realpath(manifestPath);
  const directory = path.dirname(resolvedManifest);
  const manifest = sourceManifestSchema.parse(JSON.parse(await readFile(resolvedManifest, 'utf8')));
  if (new Set(manifest.files.map(file => file.kind)).size !== 3) throw new Error('来源清单必须包含三个不同种类的 CSV');
  const files: FileSummary[] = [];
  for (const definition of manifest.files) {
    if (path.isAbsolute(definition.path)) throw new Error('CSV 必须使用清单目录内的相对路径');
    const resolved = await realpath(path.resolve(directory, definition.path));
    const relative = path.relative(directory, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('CSV 路径超出受控的清单目录');
    if (!(await stat(resolved)).isFile()) throw new Error('CSV 路径不是普通文件');
    const scanned = await scanSourceCsv(resolved, definition.kind);
    if (!scanned.size) throw new Error(`${definition.kind} CSV 文件为空`);
    if (scanned.rows !== manifest.provenance.row_counts[definition.kind]) throw new Error(`${definition.kind} 实际行数 ${scanned.rows} 与来源清单 ${manifest.provenance.row_counts[definition.kind]} 不一致`);
    if (definition.size !== undefined && scanned.size !== definition.size) throw new Error(`${definition.kind} 文件大小与来源清单不一致`);
    if (definition.sha256 !== undefined && scanned.sha256 !== definition.sha256) throw new Error(`${definition.kind} 文件校验值与来源清单不一致`);
    files.push({ kind: definition.kind, name: path.basename(resolved), path: resolved, ...scanned, chunks: Math.ceil(scanned.size / CHUNK_BYTES) });
  }
  return { manifest, files };
}

class BoundedWrites {
  private active = new Set<Promise<void>>();
  private error: unknown;
  async add(operation: () => Promise<void>): Promise<void> {
    if (this.error) throw this.error;
    const task = operation().catch(error => { this.error ??= error; }).finally(() => this.active.delete(task));
    this.active.add(task);
    if (this.active.size >= 4) await Promise.race(this.active);
    if (this.error) throw this.error;
  }
  async finish(): Promise<void> {
    await Promise.all(this.active);
    if (this.error) throw this.error;
  }
}

async function* fileChunks(filePath: string): AsyncGenerator<Buffer> {
  let remaining: Buffer = Buffer.alloc(0);
  for await (const chunk of createReadStream(filePath, { highWaterMark: CHUNK_BYTES })) {
    remaining = remaining.length ? Buffer.concat([remaining, chunk as Buffer]) : chunk as Buffer;
    while (remaining.length >= CHUNK_BYTES) {
      yield remaining.subarray(0, CHUNK_BYTES);
      remaining = remaining.subarray(CHUNK_BYTES);
    }
  }
  if (remaining.length) yield remaining;
}

function sameFile(actual: CsvSummary, expected: FileSummary): boolean {
  return actual.size === expected.size && actual.sha256 === expected.sha256 && actual.rows === expected.rows;
}

/** Trusted local importer; no browser request-size or free-plan storage caps apply. */
export async function importSourceFiles(manifestPath: string, options: { dryRun?: boolean; execute?: Execute; log?: (message: string) => void } = {}): Promise<any> {
  const { manifest, files } = await prepareSourceImport(manifestPath);
  const summary = { name: manifest.name, idempotency_key: manifest.idempotency_key, files: files.map(({ path: _path, ...file }) => file), provenance: manifest.provenance };
  if (options.dryRun) return { dry_run: true, ...summary };
  const execute = options.execute ?? databaseQuery;
  const log = options.log ?? (() => {});
  const storedFiles = files.map(({ path: _path, rows: _rows, ...file }) => file);
  // Backwards-compatible and idempotent for installations predating provenance.
  await execute("ALTER TABLE lab_datasets ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}'");
  const [created] = await execute(`INSERT INTO lab_datasets(id,name,manifest,idempotency_key,provenance)
    VALUES($1,$2,$3::jsonb,$4,$5::jsonb) ON CONFLICT(idempotency_key) DO NOTHING RETURNING *`,
  [randomUUID(), manifest.name, JSON.stringify(storedFiles), manifest.idempotency_key, JSON.stringify(manifest.provenance)]);
  const dataset = created ?? (await execute('SELECT * FROM lab_datasets WHERE idempotency_key=$1', [manifest.idempotency_key]))[0];
  const [identity] = await execute('SELECT name=$2 AND manifest=$3::jsonb AND provenance=$4::jsonb AS matches FROM lab_datasets WHERE id=$1', [dataset.id, manifest.name, JSON.stringify(storedFiles), JSON.stringify(manifest.provenance)]);
  if (!identity?.matches) throw new Error('该 idempotency_key 已被不同文件、名称或来源信息使用；不能覆盖原版本');
  if (dataset.status === 'ready') return { id: dataset.id, version: Number(dataset.version), status: 'ready', resumed: true, counts: dataset.counts };

  const uploads = new BoundedWrites();
  try {
    for (const file of files) {
      const existing = new Map((await execute('SELECT chunk_index,md5(data) AS digest FROM lab_source_chunks WHERE dataset_id=$1 AND kind=$2', [dataset.id, file.kind])).map(row => [Number(row.chunk_index), row.digest]));
      const sha = createHash('sha256');
      let size = 0; let index = 0;
      for await (const chunk of fileChunks(file.path)) {
        sha.update(chunk); size += chunk.length;
        const data = chunk.toString('base64');
        const chunkIndex = index++;
        if (existing.has(chunkIndex)) {
          if (existing.get(chunkIndex) !== createHash('md5').update(data).digest('hex')) throw new Error(`${file.kind} 已保存分片与本地原件不一致，不能覆盖`);
          continue;
        }
        await uploads.add(async () => {
          const inserted = await execute(`INSERT INTO lab_source_chunks(dataset_id,kind,chunk_index,data)
            SELECT $1,$2,$3,$4 WHERE EXISTS(SELECT 1 FROM lab_datasets WHERE id=$1 AND status='uploading')
            ON CONFLICT DO NOTHING RETURNING chunk_index`, [dataset.id, file.kind, chunkIndex, data]);
          if (!inserted.length) {
            const [saved] = await execute('SELECT data=$4 AS matches FROM lab_source_chunks WHERE dataset_id=$1 AND kind=$2 AND chunk_index=$3', [dataset.id, file.kind, chunkIndex, data]);
            if (!saved?.matches) throw new Error(`${file.kind} 分片并发保存冲突`);
          }
        });
      }
      await uploads.finish();
      if (size !== file.size || sha.digest('hex') !== file.sha256 || index !== file.chunks) throw new Error(`${file.kind} 文件在导入期间发生变化，请重新导出`);
      log(`${file.name}：原始文件 ${file.size} bytes / ${file.chunks} 分片已完整保存。`);
    }
  } finally { await uploads.finish(); }

  const writes = new BoundedWrites();
  try {
    for (const file of files) {
      let batch: { ordinal: number; row_id: string; data: SourceRow }[] = [];
      let batchBytes = 0;
      async function flush() {
        if (!batch.length) return;
        const payload = JSON.stringify(batch);
        const expected = batch.length;
        batch = []; batchBytes = 0;
        await writes.add(async () => {
          // Existing identical rows are accepted; differing rows are never overwritten.
          const [result] = await execute(`WITH saved AS (
            INSERT INTO lab_source_rows(dataset_id,kind,ordinal,row_id,data)
            SELECT $1,$2,x.ordinal,x.row_id,x.data FROM jsonb_to_recordset($3::jsonb) AS x(ordinal int,row_id text,data jsonb)
            WHERE EXISTS(SELECT 1 FROM lab_datasets WHERE id=$1 AND status='uploading')
            ON CONFLICT(dataset_id,kind,row_id) DO UPDATE SET data=lab_source_rows.data
            WHERE lab_source_rows.ordinal=EXCLUDED.ordinal AND lab_source_rows.data=EXCLUDED.data
            RETURNING row_id
          ) SELECT count(*)::int AS count FROM saved`, [dataset.id, file.kind, payload]);
          if (Number(result?.count) !== expected) throw new Error(`${file.kind} 已保存行与原件不一致，不能覆盖`);
        });
      }
      const scanned = await scanSourceCsv(file.path, file.kind, async (row, ordinal) => {
        const rowBytes = Buffer.byteLength(JSON.stringify(row));
        if (batch.length && batchBytes + rowBytes > 750_000) await flush();
        // No 2 MB row cap here: originals and imported rows must not be silently dropped.
        batch.push({ ordinal, row_id: row.id, data: row }); batchBytes += rowBytes;
      });
      await flush(); await writes.finish();
      if (!sameFile(scanned, file)) throw new Error(`${file.kind} 文件在解析期间发生变化，请重新导出`);
      const [count] = await execute('SELECT count(*)::int AS count FROM lab_source_rows WHERE dataset_id=$1 AND kind=$2', [dataset.id, file.kind]);
      if (Number(count?.count) !== file.rows) throw new Error(`${file.kind} 数据库行数校验失败`);
      log(`${file.name}：${file.rows} 行已完整解析入库。`);
    }
  } finally { await writes.finish(); }

  for (const file of files) {
    const [saved] = await execute('SELECT count(*)::int AS count,min(chunk_index) AS first,max(chunk_index) AS last FROM lab_source_chunks WHERE dataset_id=$1 AND kind=$2', [dataset.id, file.kind]);
    if (Number(saved.count) !== file.chunks || saved.first !== 0 || Number(saved.last) !== file.chunks - 1) throw new Error(`${file.kind} 原始分片校验失败`);
  }
  const [previewable] = await execute(`SELECT count(*)::int AS count FROM lab_source_rows h
    JOIN lab_source_rows s ON s.dataset_id=h.dataset_id AND s.kind='sessions' AND s.row_id=coalesce(nullif(h.data->>'session_id',''),h.data->>'source_session_id')
    JOIN lab_source_rows c ON c.dataset_id=h.dataset_id AND c.kind='characters' AND c.row_id=coalesce(nullif(h.data->>'character_id',''),h.data->>'source_character_id')
    WHERE h.dataset_id=$1 AND h.kind='history' AND coalesce(h.data->>'user_input','')<>''
      AND coalesce(nullif(h.data->>'model',''),h.data->>'original_model','')<>'' AND coalesce(s.data->>'deleted_at','')=''`, [dataset.id]);
  const counts = {
    history_count: manifest.provenance.row_counts.history, session_count: manifest.provenance.row_counts.sessions,
    character_count: manifest.provenance.row_counts.characters, previewable_history_count: Number(previewable.count),
  };
  const [ready] = await execute("UPDATE lab_datasets SET status='ready',counts=$2::jsonb,ready_at=coalesce(ready_at,now()) WHERE id=$1 RETURNING id,version,status,counts", [dataset.id, JSON.stringify(counts)]);
  return { ...ready, version: Number(ready.version), provenance: manifest.provenance };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--manifest');
  if (index < 0 || !args[index + 1] || args.some((arg, position) => position !== index && position !== index + 1 && arg !== '--dry-run')) {
    console.error('用法：npx tsx script/import-source.ts --manifest <受控目录>/manifest.json [--dry-run]');
    process.exitCode = 1;
  } else {
    try {
      try { loadEnvFile('.env.local'); } catch { /* Environment may be supplied externally. */ }
      const result = await importSourceFiles(args[index + 1], { dryRun: args.includes('--dry-run'), log: message => console.log(message) });
      console.log(JSON.stringify(result));
    } catch (error) {
      // Never print driver errors: they can include SQL parameters with private conversations.
      console.error(error instanceof z.ZodError ? '来源清单字段无效，请核对格式、时区和来源信息。' : '来源导入未完成；未发布为可用版本。请检查导出文件、数据库连接及幂等清单后重试。');
      process.exitCode = 1;
    }
  }
}
