import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { datasetOperation } from './datasets';
import { sampleOperation } from './samples';
import { experimentOperation } from './experiments';
import { processorOperation, ensureDefaultProcessors } from './processors';
import { query } from './db';

function equal(a:string,b:string) { const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y); }
function signature(expires:string,key:string){return createHmac('sha256',key).update(`batch-lab:${expires}`).digest('hex');}
export function isAuthenticated(cookie:string,key=process.env.BATCH_LAB_ACCESS_KEY ?? '') {
  if(!key) return true;
  const token=cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith('batch_lab_session='))?.slice(18) ?? '';
  const [expires,sig]=token.split('.');
  return !!expires && Number(expires)>Date.now() && equal(sig??'',signature(expires,key));
}

export async function operation(op:string,input:any):Promise<unknown> {
  if(op==='getBatchLabContext') {
    await query('SELECT 1');
    return {backend_environment:process.env.VERCEL_ENV==='production'?'production':'development',source_environment:'test',capabilities:{sample_preview:true,experiment_execution:!!(process.env.BATCH_LAB_MODEL_KEY || process.env.VITE_BATCH_LAB_MODEL_KEY)}};
  }
  if(['listBatchLabDatasets','beginDatasetImport','uploadDatasetChunk','finishDatasetImport','getDatasetChunk'].includes(op)) return datasetOperation(op,input);
  if(['listBatchLabSqlTemplates','createBatchLabPreview','createBatchLabSampleSet','listBatchLabSampleSets','getBatchLabSampleSet','listBatchLabSampleSetSamples','deleteBatchLabSampleSet'].includes(op)) return sampleOperation(op,input);
  if(['listBatchLabProcessors','createBatchLabProcessor','previewBatchLabProcessor'].includes(op)) {
    await ensureDefaultProcessors();
    return processorOperation(op,input);
  }
  if(op==='exportTable') {
    const sources:Record<string,string>={
      datasets:'SELECT id,version,name,status,manifest,counts,provenance,created_at FROM lab_datasets WHERE status=\'ready\' ORDER BY version',
      sample_set:"SELECT data FROM lab_records WHERE kind='sample_set' ORDER BY id",
      processor:"SELECT data FROM lab_records WHERE kind='processor' ORDER BY id",
      experiment:"SELECT data FROM lab_records WHERE kind='experiment' ORDER BY id",
      snapshots:"SELECT sample_set_id,ordinal,data FROM lab_snapshots WHERE sample_set_id IN(SELECT id FROM lab_records WHERE kind='sample_set') ORDER BY sample_set_id,ordinal",
      attempts:'SELECT * FROM lab_attempts ORDER BY id',events:'SELECT * FROM lab_attempt_events ORDER BY id',
      annotations:'SELECT * FROM lab_annotations ORDER BY experiment_id,sample_ordinal,turn_index',
    };
    const sql=sources[input.kind];if(!sql)throw new Error('未知导出表');
    const offset=z.number().int().nonnegative().parse(input.cursor ?? 0);
    const rows=await query(`${sql} LIMIT 6 OFFSET $1`,[offset]);
    const items:any[]=[];let bytes=0;
    for(const row of rows.slice(0,5)) {
      const data=Object.keys(row).length===1 && row.data ? row.data : row;
      const size=Buffer.byteLength(JSON.stringify(data));
      if(items.length && bytes+size>2_000_000) break;
      items.push(data);bytes+=size;
    }
    return {items,next_cursor:rows.length>items.length?offset+items.length:null};
  }
  return experimentOperation(op,input);
}

export default async function handler(req:IncomingMessage & {body?:any},res:ServerResponse) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  const send=(status:number,value:unknown)=>{res.statusCode=status;res.end(JSON.stringify(value));};
  if(req.method!=='POST'){send(405,{success:false,error:{message:'请使用 POST'}});return;}
  try {
    const origin=req.headers.origin;
    const host=req.headers['x-forwarded-host'] || req.headers.host;
    if(origin && new URL(origin).host!==host){send(403,{success:false,error:{message:'不允许跨站操作'}});return;}
    let body=req.body;
    if(body===undefined) {
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>1_500_000)throw new Error('请求过大，请分片上传');chunks.push(b);}
      body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } else if(typeof body==='string')body=JSON.parse(body);
    const {op,input}=z.object({op:z.string().min(1).max(80),input:z.unknown().default({})}).parse(body);
    const key=process.env.BATCH_LAB_ACCESS_KEY ?? '';
    const authenticated=isAuthenticated(req.headers.cookie ?? '',key);
    if(op==='session'){send(200,{success:true,data:{authenticated,requires_key:!!key}});return;}
    if(op==='logout') {res.setHeader('Set-Cookie','batch_lab_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');send(200,{success:true,data:null});return;}
    if(op==='login') {
      if(key && !equal(String((input as any)?.accessKey??''),key)){send(401,{success:false,error:{message:'团队口令不正确'}});return;}
      const expires=String(Date.now()+7*24*60*60_000);
      res.setHeader('Set-Cookie',`batch_lab_session=${expires}.${signature(expires,key)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${process.env.VERCEL?' ; Secure':''}`);
      send(200,{success:true,data:null});return;
    }
    if(!authenticated){send(401,{success:false,error:{code:'AUTH_REQUIRED',message:'请先输入团队口令'}});return;}
    const data=await operation(op,input);
    send(200,{success:true,data});
  } catch(error) {
    const raw=error instanceof Error?error.message:'请求失败';
    const message=error instanceof z.ZodError?`参数无效：${error.issues[0]?.path.join('.') || '请求内容'}` : /[\u4e00-\u9fff]/.test(raw) ? raw : '操作失败，请检查输入或稍后重试';
    console.error('Batch Lab request failed:',error instanceof Error?error.name:'Error');
    send(400,{success:false,error:{message}});
  }
}
