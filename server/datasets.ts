import { createHash, randomUUID } from 'node:crypto';
import Papa from 'papaparse';
import { z } from 'zod';
import { query } from './db.js';

export const SOURCE_KINDS = ['history', 'sessions', 'characters'] as const;
export const CHUNK_BYTES = 512 * 1024;
const kindSchema = z.enum(SOURCE_KINDS);
const fileSchema = z.object({
  kind: kindSchema,
  name: z.string().min(1).max(240),
  size: z.number().int().positive().max(64 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  chunks: z.number().int().positive().max(128),
});
export type SourceFile = z.infer<typeof fileSchema>;
export type SourceRow = Record<string, string>;

const utcTime = z.string().datetime({ offset: true }).refine(value => value.endsWith('Z'), 'UTC 时间必须以 Z 结尾');
const beijingTime = z.string().datetime({ offset: true }).refine(value => value.endsWith('+08:00'), '北京时间必须使用 +08:00');
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(100);
/** Explicit fields prevent connection strings, access keys or arbitrary export payloads being persisted. */
export const datasetProvenanceSchema = z.object({
  source: z.literal('supabase'),
  project_ref: z.string().regex(/^[a-z0-9]{20}$/),
  project_name: z.string().min(1).max(120).optional(),
  schema: identifier,
  table: identifier,
  time_column: identifier,
  start_utc: utcTime,
  end_utc_exclusive: utcTime,
  start_beijing: beijingTime,
  end_beijing_exclusive: beijingTime,
  timezone: z.literal('Asia/Shanghai'),
  snapshot_cutoff_utc: utcTime,
  characters_scope: z.enum(['all_rows', 'enabled_rows', 'referenced_rows']).optional(),
  characters_snapshot_cutoff_utc: utcTime.optional(),
  exported_at: utcTime,
  row_counts: z.object({ history: z.number().int().nonnegative().safe(), sessions: z.number().int().nonnegative().safe(), characters: z.number().int().nonnegative().safe() }).strict(),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.start_utc) !== Date.parse(value.start_beijing) || Date.parse(value.end_utc_exclusive) !== Date.parse(value.end_beijing_exclusive)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'UTC 与北京时间范围不一致' });
  }
  if (Date.parse(value.start_utc) >= Date.parse(value.end_utc_exclusive)) context.addIssue({ code: z.ZodIssueCode.custom, message: '来源时间范围无效' });
  if (Date.parse(value.exported_at) < Date.parse(value.snapshot_cutoff_utc)) context.addIssue({ code: z.ZodIssueCode.custom, message: '导出时间不能早于快照截止时间' });
  if (value.characters_snapshot_cutoff_utc && Date.parse(value.exported_at) < Date.parse(value.characters_snapshot_cutoff_utc)) context.addIssue({ code: z.ZodIssueCode.custom, message: '导出时间不能早于角色快照截止时间' });
});

function view(row: any) {
  return {
    id: row.id, version: Number(row.version), name: row.name,
    status: row.status, created_at: new Date(row.created_at).toISOString(),
    history_count: row.counts.history_count ?? 0,
    session_count: row.counts.session_count ?? 0,
    character_count: row.counts.character_count ?? 0,
    previewable_history_count: row.counts.previewable_history_count ?? 0,
    files: row.manifest, provenance: row.provenance ?? {},
  };
}

export async function requireDataset(id: string, ready = true): Promise<any> {
  z.string().uuid().parse(id);
  const [row] = await query('SELECT * FROM lab_datasets WHERE id = $1', [id]);
  if (!row || (ready && row.status !== 'ready')) throw new Error('原始数据版本不存在或尚未完成上传');
  return row;
}

export function parseSourceCsv(content: string, kind: typeof SOURCE_KINDS[number]): SourceRow[] {
  const parsed = Papa.parse<SourceRow>(content, { header: true, skipEmptyLines: 'greedy' });
  const errors = parsed.errors.filter(error => error.code !== 'UndetectableDelimiter');
  if (errors.length) throw new Error(`${kind} CSV 解析失败：${errors[0].message}`);
  if (Object.keys(parsed.meta.renamedHeaders ?? {}).length) throw new Error(`${kind} CSV 存在重复表头`);
  const fields = parsed.meta.fields ?? [];
  const required = kind === 'history'
    ? [['id'], ['session_id', 'source_session_id'], ['character_id', 'source_character_id'], ['user_input'], ['model', 'original_model']]
    : [['id']];
  for (const options of required) {
    if (!options.some(field => fields.includes(field))) throw new Error(`${kind} CSV 缺少 ${options.join(' / ')} 列`);
  }
  if (!parsed.data.length) throw new Error(`${kind} CSV 没有数据行`);
  const seen = new Set<string>();
  for (const row of parsed.data) {
    if (!row.id || seen.has(row.id)) throw new Error(`${kind} CSV 的 id 为空或重复`);
    seen.add(row.id);
  }
  return parsed.data;
}

export async function datasetOperation(op: string, input: any): Promise<unknown> {
  if (op === 'listBatchLabDatasets') {
    return (await query("SELECT * FROM lab_datasets WHERE status='ready' ORDER BY version DESC")).map(view);
  }
  if (op === 'beginDatasetImport') {
    const value = z.object({ name: z.string().trim().min(1).max(120), idempotency_key: z.string().uuid(), files: z.array(fileSchema).length(3), provenance: datasetProvenanceSchema.optional() }).parse(input);
    if (new Set(value.files.map(f => f.kind)).size !== 3) throw new Error('请提供聊天、会话、角色三个 CSV');
    for (const file of value.files) {
      if (file.chunks !== Math.ceil(file.size / CHUNK_BYTES)) throw new Error('CSV 分片数量与文件大小不匹配');
    }
    if (value.files.reduce((sum, f) => sum + f.size, 0) > 128 * 1024 * 1024) throw new Error('每个版本总大小最多 128 MB');
    const [created] = await query(`INSERT INTO lab_datasets(id,name,manifest,idempotency_key,provenance)
      VALUES($1,$2,$3::jsonb,$4,$5::jsonb) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [randomUUID(), value.name, JSON.stringify(value.files), value.idempotency_key, JSON.stringify(value.provenance ?? {})]);
    const row = created ?? (await query('SELECT * FROM lab_datasets WHERE idempotency_key=$1', [value.idempotency_key]))[0];
    const [provenanceMatch] = await query('SELECT provenance = $2::jsonb AS matches FROM lab_datasets WHERE id=$1', [row.id, JSON.stringify(value.provenance ?? {})]);
    if (!provenanceMatch?.matches) throw new Error('导入请求的来源记录与已保存的版本不一致');
    if (JSON.stringify(row.manifest) !== JSON.stringify(value.files) &&
      createHash('sha256').update(JSON.stringify([...row.manifest].sort((a: any,b: any) => a.kind.localeCompare(b.kind)).map((f: any)=>[f.kind,f.sha256,f.size]))).digest('hex') !==
      createHash('sha256').update(JSON.stringify([...value.files].sort((a,b)=>a.kind.localeCompare(b.kind)).map(f=>[f.kind,f.sha256,f.size]))).digest('hex')) throw new Error('导入请求与已保存的版本不一致');
    return view(row);
  }
  if (op === 'uploadDatasetChunk') {
    const value = z.object({ datasetId: z.string().uuid(), kind: kindSchema, index: z.number().int().nonnegative(), data: z.string().max(710_000) }).parse(input);
    const dataset = await requireDataset(value.datasetId, false);
    const file: SourceFile = dataset.manifest.find((f: SourceFile) => f.kind === value.kind);
    if (!file || value.index >= file.chunks) throw new Error('CSV 分片位置无效');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw new Error('CSV 分片编码无效');
    const bytes = Buffer.from(value.data, 'base64');
    const expected = Math.min(CHUNK_BYTES, file.size - value.index * CHUNK_BYTES);
    if (bytes.length !== expected || bytes.toString('base64') !== value.data) throw new Error('CSV 分片大小或编码不匹配');
    if (dataset.status === 'uploading') {
      await query(`INSERT INTO lab_source_chunks(dataset_id,kind,chunk_index,data)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [value.datasetId, value.kind, value.index, value.data]);
    }
    const [stored] = await query('SELECT data=$4 AS matches FROM lab_source_chunks WHERE dataset_id=$1 AND kind=$2 AND chunk_index=$3', [value.datasetId,value.kind,value.index,value.data]);
    if (!stored?.matches) throw new Error('该版本分片已经保存，不能覆盖；请重新导入为新版本');
    return { uploaded: true };
  }
  if (op === 'finishDatasetImport') {
    const dataset = await requireDataset(input.datasetId, false);
    if (dataset.status === 'ready') return { ...dataset.counts, dataset: view(dataset) };
    const tables: Record<string, SourceRow[]> = {};
    for (const file of dataset.manifest as SourceFile[]) {
      // Read bounded pages; large originals can exceed an HTTP database response.
      const chunks: any[] = [];
      for (let offset = 0; offset < file.chunks; offset += 2) {
        const page = await query('SELECT chunk_index,data FROM lab_source_chunks WHERE dataset_id=$1 AND kind=$2 AND chunk_index >= $3 AND chunk_index < $4 ORDER BY chunk_index', [dataset.id,file.kind,offset,offset+2]);
        chunks.push(...page);
      }
      if (chunks.length !== file.chunks || chunks.some((c,i) => c.chunk_index !== i)) throw new Error(`${file.name} 上传尚未完成，可重新上传`);
      const bytes = Buffer.concat(chunks.map(c => Buffer.from(c.data,'base64')));
      if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`${file.name} 校验失败，请重新导入`);
      tables[file.kind] = parseSourceCsv(bytes.toString('utf8'), file.kind);
    }
    for (const kind of SOURCE_KINDS) {
      let batch: any[] = [], size = 0;
      const flush = async () => {
        if (!batch.length) return;
        await query(`INSERT INTO lab_source_rows(dataset_id,kind,ordinal,row_id,data)
          SELECT $1,$2,x.ordinal,x.row_id,x.data FROM jsonb_to_recordset($3::jsonb) AS x(ordinal int,row_id text,data jsonb)
          ON CONFLICT DO NOTHING`, [dataset.id,kind,JSON.stringify(batch)]);
        batch = []; size = 0;
      };
      for (const [ordinal,row] of tables[kind].entries()) {
        const rowSize = Buffer.byteLength(JSON.stringify(row));
        if (rowSize > 2 * 1024 * 1024) throw new Error(`${kind} 单条记录超过 2 MB`);
        if (size + rowSize > 750_000) await flush();
        batch.push({ ordinal, row_id: row.id, data: row }); size += rowSize;
      }
      await flush();
    }
    const validSessions = new Set(tables.sessions.filter(r=>!r.deleted_at).map(r=>r.id));
    const characters = new Set(tables.characters.map(r=>r.id));
    const counts = { history_count: tables.history.length, session_count: tables.sessions.length, character_count: tables.characters.length,
      previewable_history_count: tables.history.filter(r => r.user_input && (r.model || r.original_model) && validSessions.has(r.session_id || r.source_session_id) && characters.has(r.character_id || r.source_character_id)).length };
    const [ready] = await query("UPDATE lab_datasets SET status='ready',counts=$2::jsonb,ready_at=coalesce(ready_at,now()) WHERE id=$1 RETURNING *", [dataset.id,JSON.stringify(counts)]);
    return { ...counts, dataset: view(ready) };
  }
  if (op === 'getDatasetChunk') {
    const value = z.object({ datasetId:z.string().uuid(),kind:kindSchema,index:z.number().int().nonnegative() }).parse(input);
    const dataset = await requireDataset(value.datasetId);
    const [row] = await query('SELECT data FROM lab_source_chunks WHERE dataset_id=$1 AND kind=$2 AND chunk_index=$3', [value.datasetId,value.kind,value.index]);
    if (!row) throw new Error('原始 CSV 分片不存在');
    return { data:row.data, file:dataset.manifest.find((f: SourceFile)=>f.kind===value.kind) };
  }
  throw new Error('未知数据集操作');
}
