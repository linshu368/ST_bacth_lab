import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { query, transaction } from './db';
import { requireDataset } from './datasets';
import { compileDatasetQuery } from './sql';
import { batchLabPreviewItemSchema, type BatchLabPreviewItem } from '../src/lib/batch-lab-contracts';

export const DEFAULT_SAMPLE_SQL = `SELECT h.id AS source_history_id
FROM experience.chat_history AS h
JOIN experience.chat_sessions AS s ON s.id = h.session_id
JOIN app_core.characters AS c ON c.id = h.character_id
WHERE h.user_input IS NOT NULL
  AND h.model IS NOT NULL
  AND h.turn_index >= :min_turn
  AND h.revision >= 0
  AND s.deleted_at IS NULL
ORDER BY h.created_at DESC`;

export function sourceSnapshot(row: any, ordinal: number): BatchLabPreviewItem {
  const h = row.history_row;
  let history: unknown;
  try { history = JSON.parse(h.history || '[]'); } catch { throw new Error('聊天记录的 history 不是有效 JSON'); }
  return batchLabPreviewItemSchema.parse({
    ordinal, source_history_id:h.id, source_session_id:h.session_id || h.source_session_id,
    source_user_id:h.user_id || h.source_user_id,
    source_character_id:h.character_id || h.source_character_id,
    turn_index:Number(h.turn_index || 1),revision:Number(h.revision || 0),
    user_input:h.user_input,original_assistant_reply:h.assistant_reply || h.original_assistant_reply || null,
    original_model:h.model || h.original_model || 'unknown',history,
    character_snapshot:row.character_row,
    dynamic_input_snapshot:{context_window_start_turn:Number(row.session_row?.context_window_start_turn || 1),source_status:h.status || 'unknown'},
    restoration_strategy:'exact_prompt_snapshot',
  });
}

export async function samplePage(sampleSetId:string, input:{cursor?:string|null;limit?:number} = {}) {
  z.string().uuid().parse(sampleSetId);
  const offset = input.cursor ? Number(input.cursor) : 0;
  if (!Number.isInteger(offset) || offset < 0) throw new Error('分页位置无效');
  const limit = Math.max(1,Math.min(input.limit ?? 5,5));
  const rows = await query('SELECT ordinal,data FROM lab_snapshots WHERE sample_set_id=$1 AND ordinal >= $2 ORDER BY ordinal LIMIT $3', [sampleSetId,offset,limit+1]);
  const items: any[] = []; let size = 0;
  for (const row of rows.slice(0,limit)) {
    const bytes = Buffer.byteLength(JSON.stringify(row.data));
    if (items.length && size+bytes>2_000_000) break;
    items.push(row.data); size += bytes;
  }
  return {sample_set_id:sampleSetId,items,next_cursor:rows.length>items.length ? String(items.at(-1).ordinal+1) : null};
}

export async function sampleOperation(op:string,input:any):Promise<unknown> {
  if (op === 'listBatchLabSqlTemplates') return [{key:'recent_chat_history',version:1,name:'最近有效对话样本',description:'在选定的原始数据版本内执行只读 SELECT，必须返回 source_history_id。',sql:DEFAULT_SAMPLE_SQL,default_parameters:{min_turn:1},enabled:true}];
  if (op === 'listBatchLabSampleSets') return (await query("SELECT data FROM lab_records WHERE kind='sample_set' AND coalesce(data->>'deleted_at','')='' ORDER BY created_at DESC")).map(r=>r.data);
  if (op === 'getBatchLabSampleSet') {
    const [row] = await query("SELECT data FROM lab_records WHERE kind='sample_set' AND id=$1",[z.string().uuid().parse(input.sampleSetId)]);
    if (!row) throw new Error('样本版本不存在');
    return row.data;
  }
  if (op === 'listBatchLabSampleSetSamples') return samplePage(input.sampleSetId,input.input);
  if (op === 'createBatchLabPreview') {
    const value = z.object({dataset_version_id:z.string().uuid(),sql:z.string().trim().min(1).max(20_000),parameters:z.record(z.union([z.string().max(1000),z.number().finite(),z.boolean(),z.null()])),sample_limit:z.number().int().min(1).max(500)}).parse(input);
    const dataset = await requireDataset(value.dataset_version_id);
    const compiled = compileDatasetQuery({datasetId:dataset.id,sql:value.sql,parameters:value.parameters,sampleLimit:value.sample_limit});
    const [, , result] = await transaction([
      {text:"SELECT set_config('statement_timeout','8000',true)"},
      {text:"SELECT set_config('lock_timeout','2000',true)"},
      compiled,
    ],{readOnly:true});
    const ids = [...new Set(result.slice(0,value.sample_limit).map((r:any)=>String(r.source_history_id ?? '')))];
    if (ids.some(id=>!id)) throw new Error('SQL 必须返回 source_history_id 列');
    const id = randomUUID();
    const items: BatchLabPreviewItem[] = [];
    const excluded:Record<string,number>={};
    for (let start=0;start<ids.length;start+=5) {
      const batch=ids.slice(start,start+5);
      const rows=await query(`SELECT h.row_id,h.data AS history_row,s.data AS session_row,c.data AS character_row
        FROM lab_source_rows h
        JOIN lab_source_rows s ON s.dataset_id=h.dataset_id AND s.kind='sessions' AND s.row_id=coalesce(nullif(h.data->>'session_id',''),h.data->>'source_session_id')
        JOIN lab_source_rows c ON c.dataset_id=h.dataset_id AND c.kind='characters' AND c.row_id=coalesce(nullif(h.data->>'character_id',''),h.data->>'source_character_id')
        WHERE h.dataset_id=$1 AND h.kind='history' AND h.row_id=ANY($2::text[])`,[dataset.id,batch]);
      const byId=new Map(rows.map(r=>[r.row_id,r]));
      for (const anchor of batch) {
        const row=byId.get(anchor);
        if(!row){excluded.missing_history=(excluded.missing_history??0)+1;continue;}
        try {
          const item=sourceSnapshot(row,items.length);
          const bytes=Buffer.byteLength(JSON.stringify(item));
          if(bytes>2_000_000){excluded.snapshot_too_large=(excluded.snapshot_too_large??0)+1;continue;}
          items.push(item);
        } catch { excluded.invalid_anchor=(excluded.invalid_anchor??0)+1; }
      }
    }
    if(!items.length) throw new Error('SQL 没有选出有效样本，请检查查询条件及关联数据');
    const digest='sha256:'+createHash('sha256').update(JSON.stringify({dataset:dataset.id,sql:value.sql,parameters:value.parameters,items:items.map(i=>i.source_history_id)})).digest('hex');
    const metadata={id,digest,source_environment:'test',dataset_version_id:dataset.id,dataset_version_number:Number(dataset.version),dataset_version_name:dataset.name,
      final_sql:value.sql,parameters:value.parameters,sample_limit:value.sample_limit,
      statistics:{requested_count:value.sample_limit,candidate_count:result.length,valid_count:items.length,user_count:new Set(items.map(i=>i.source_user_id)).size,session_count:new Set(items.map(i=>i.source_session_id)).size,character_count:new Set(items.map(i=>i.source_character_id)).size,excluded_by_reason:excluded,truncated:result.length>value.sample_limit,snapshot_bytes:Buffer.byteLength(JSON.stringify(items))},
      created_at:new Date().toISOString(),expires_at:new Date(Date.now()+15*60_000).toISOString()};
    // Publish the preview only after every snapshot is stored. Bounded writes keep
    // transport limits separate from the total size of a saved sample version.
    let batch:BatchLabPreviewItem[]=[];let batchBytes=0;
    const flush=async()=>{
      if(!batch.length)return;
      await query(`INSERT INTO lab_snapshots(sample_set_id,ordinal,data)
        SELECT $1,x.ordinal,x.data FROM jsonb_to_recordset($2::jsonb) AS x(ordinal int,data jsonb)`,
      [id,JSON.stringify(batch.map(item=>({ordinal:item.ordinal,data:item})))]);
      batch=[];batchBytes=0;
    };
    for(const item of items) {
      const bytes=Buffer.byteLength(JSON.stringify(item));
      if(batchBytes+bytes>2_000_000)await flush();
      batch.push(item);batchBytes+=bytes;
    }
    await flush();
    await query("INSERT INTO lab_records(kind,id,data) VALUES('preview',$1,$2::jsonb)",[id,JSON.stringify(metadata)]);
    const examples:BatchLabPreviewItem[]=[];let responseBytes=Buffer.byteLength(JSON.stringify(metadata));
    for(const item of items.slice(0,3)) {
      const bytes=Buffer.byteLength(JSON.stringify(item));
      if(examples.length && responseBytes+bytes>2_100_000)break;
      examples.push(item);responseBytes+=bytes;
    }
    return {...metadata,items:examples};
  }
  if (op === 'createBatchLabSampleSet') {
    const value=z.object({name:z.string().trim().min(1).max(120),preview_id:z.string().uuid(),preview_digest:z.string(),idempotency_key:z.string().uuid()}).parse(input);
    const [existing]=await query("SELECT data FROM lab_records WHERE kind='sample_set' AND data->>'idempotency_key'=$1",[value.idempotency_key]);
    const matchingRequest=(data:any)=>{
      if(data.name!==value.name || data.source_preview_id!==value.preview_id || data.source_digest!==value.preview_digest)throw new Error('保存请求与已保存的样本版本不一致');
      return data;
    };
    if(existing) return matchingRequest(existing.data);
    const [record]=await query("SELECT data FROM lab_records WHERE kind='preview' AND id=$1",[value.preview_id]);
    const preview=record?.data;
    if(!preview || preview.digest!==value.preview_digest) throw new Error('预览不存在或摘要不匹配，请重新预览');
    if(Date.parse(preview.expires_at)<Date.now()) throw new Error('预览已过期，请重新执行 SQL');
    const id=randomUUID();
    const sample={id,name:value.name,source_environment:'test',source_preview_id:preview.id,source_digest:preview.digest,sample_count:preview.statistics.valid_count,
      statistics:preview.statistics,frozen_sql:preview.final_sql,frozen_parameters:preview.parameters,dataset_version_id:preview.dataset_version_id,dataset_version_number:preview.dataset_version_number,dataset_version_name:preview.dataset_version_name,
      created_at:new Date().toISOString(),deleted_at:null,idempotency_key:value.idempotency_key};
    await transaction([
      {text:"INSERT INTO lab_records(kind,id,data) VALUES('sample_set',$1,$2::jsonb || jsonb_build_object('version',nextval('lab_sample_version_seq'))) ON CONFLICT DO NOTHING",values:[id,JSON.stringify(sample)]},
      {text:"INSERT INTO lab_snapshots(sample_set_id,ordinal,data) SELECT $1,ordinal,data FROM lab_snapshots WHERE sample_set_id=$2 AND EXISTS(SELECT 1 FROM lab_records WHERE kind='sample_set' AND id=$1) ON CONFLICT DO NOTHING",values:[id,value.preview_id]},
    ]);
    return matchingRequest((await query("SELECT data FROM lab_records WHERE kind='sample_set' AND data->>'idempotency_key'=$1",[value.idempotency_key]))[0].data);
  }
  if (op==='deleteBatchLabSampleSet') {
    const id=z.string().uuid().parse(input.sample_set_id);
    const [used]=await query("SELECT id FROM lab_records WHERE kind='experiment' AND data->>'sample_set_id'=$1 AND coalesce(data->>'deleted_at','')='' LIMIT 1",[id]);
    if(used) throw new Error('样本版本已被实验使用，不能归档');
    const date=new Date().toISOString();
    const rows=await query("UPDATE lab_records SET data=data || jsonb_build_object('deleted_at',$2::text) WHERE kind='sample_set' AND id=$1 RETURNING id",[id,date]);
    if(!rows.length) throw new Error('样本版本不存在');
    return {id,deleted_at:date};
  }
  throw new Error('未知样本操作');
}
