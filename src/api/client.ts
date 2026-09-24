import Papa from 'papaparse';
import type * as C from '../lib/batch-lab-contracts';
import type { DatasetVersion } from '../lib/datasets';

export type BatchLabClientErrorKind = 'configuration' | 'cancelled' | 'timeout' | 'network' | 'http' | 'protocol';
export class BatchLabClientError extends Error {
  constructor(readonly kind: BatchLabClientErrorKind, message: string, readonly code?: string, readonly status?: number) { super(message); this.name = 'BatchLabClientError'; }
}
export const newIdempotencyKey = () => crypto.randomUUID();

export async function rpc<T>(op: string, input: unknown = {}, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new BatchLabClientError('cancelled', '操作已取消');
  let response: Response;
  try {
    response = await fetch('/api/lab', { method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify({op,input}), signal });
  } catch (error) {
    if (signal?.aborted) throw new BatchLabClientError('cancelled','操作已取消');
    throw new BatchLabClientError('network', '无法连接共享数据库服务，请检查网络后重试');
  }
  const payload = await response.json().catch(()=>null);
  if (!response.ok || !payload?.success) throw new BatchLabClientError('http', payload?.error?.message || `服务请求失败 (${response.status})`, payload?.error?.code, response.status);
  return payload.data as T;
}

export const getBatchLabSession = () => rpc<{authenticated:boolean;requires_key:boolean}>('session');
export const loginBatchLab = (accessKey:string) => rpc<void>('login',{accessKey});
export const logoutBatchLab = () => rpc<void>('logout');
export const getBatchLabContext = (signal?:AbortSignal) => rpc<C.BatchLabContext>('getBatchLabContext',{},signal);
export const listBatchLabSqlTemplates = (signal?:AbortSignal) => rpc<C.BatchLabSqlTemplate[]>('listBatchLabSqlTemplates',{},signal);
export const listBatchLabProcessors = (signal?:AbortSignal) => rpc<C.BatchLabProcessorVersion[]>('listBatchLabProcessors',{},signal);
export const createBatchLabProcessor = (input:C.BatchLabCreateProcessorVersionRequest,signal?:AbortSignal) => rpc<C.BatchLabProcessorVersion>('createBatchLabProcessor',input,signal);
export const previewBatchLabProcessor = (input:C.BatchLabProcessorPreviewRequest,signal?:AbortSignal) => rpc<C.BatchLabDisplayResult>('previewBatchLabProcessor',input,signal);
export const createBatchLabPreview = (input:C.BatchLabPreviewRequest,signal?:AbortSignal) => rpc<C.BatchLabPreview>('createBatchLabPreview',input,signal);
export const createBatchLabSampleSet = (input:C.BatchLabCreateSampleSetRequest,signal?:AbortSignal) => rpc<C.BatchLabSampleSet>('createBatchLabSampleSet',input,signal);
export const listBatchLabSampleSets = (signal?:AbortSignal) => rpc<C.BatchLabSampleSet[]>('listBatchLabSampleSets',{},signal);
export const getBatchLabSampleSet = (sampleSetId:string,signal?:AbortSignal) => rpc<C.BatchLabSampleSetDetail>('getBatchLabSampleSet',{sampleSetId},signal);
export const listBatchLabSampleSetSamples = (sampleSetId:string,input:{cursor?:string|null;limit?:number}={},signal?:AbortSignal) => rpc<C.BatchLabSampleSnapshotPage>('listBatchLabSampleSetSamples',{sampleSetId,input},signal);
export const deleteBatchLabSampleSet = (input:C.BatchLabDeleteSampleSetRequest,signal?:AbortSignal) => rpc<{id:string;deleted_at:string}>('deleteBatchLabSampleSet',input,signal);
export const listBatchLabExperiments = (signal?:AbortSignal) => rpc<C.BatchLabExperimentSummary[]>('listBatchLabExperiments',{},signal);
export const createBatchLabExperiment = (input:C.BatchLabCreateExperimentRequest,signal?:AbortSignal) => rpc<C.BatchLabExperimentSummary>('createBatchLabExperiment',input,signal);
export const getBatchLabExperiment = (experimentId:string,signal?:AbortSignal) => rpc<C.BatchLabExperimentDetail>('getBatchLabExperiment',{experimentId},signal);
export const getBatchLabExperimentResults = (experimentId:string,input:{cursor?:string|null;limit?:number}={},signal?:AbortSignal) => rpc<C.BatchLabExperimentResultDetail>('getBatchLabExperimentResults',{experimentId,input},signal);
export const copyBatchLabExperiment = (input:C.BatchLabCopyExperimentRequest,signal?:AbortSignal) => rpc<C.BatchLabExperimentSummary>('copyBatchLabExperiment',input,signal);
export const createBatchLabReuseDisplayExperiment = (input:C.BatchLabReuseDisplayExperimentRequest,signal?:AbortSignal) => rpc<C.BatchLabExperimentSummary>('createBatchLabReuseDisplayExperiment',input,signal);
export const upsertBatchLabAnnotation = (input:C.BatchLabUpsertAnnotationRequest,signal?:AbortSignal) => rpc<C.BatchLabAnnotation>('upsertBatchLabAnnotation',input,signal);
export const startBatchLabExperiment = (input:C.BatchLabStartExperimentRequest,signal?:AbortSignal) => rpc<C.BatchLabExperimentSummary>('startBatchLabExperiment',input,signal);
export const stopBatchLabExperiment = (input:C.BatchLabStopExperimentRequest,signal?:AbortSignal) => rpc<C.BatchLabExperimentSummary>('stopBatchLabExperiment',input,signal);
export const deleteBatchLabExperiment = (input:C.BatchLabDeleteExperimentRequest,signal?:AbortSignal) => rpc<{id:string;deleted_at:string}>('deleteBatchLabExperiment',input,signal);
export const runBatchLabWorkerOnce = (input:C.BatchLabRunWorkerRequest,signal?:AbortSignal) => rpc<C.BatchLabRunWorkerResult>('runBatchLabWorkerOnce',input,signal);
export const runBatchLabExperimentWorkerOnce = (input:C.BatchLabRunExperimentWorkerRequest,signal?:AbortSignal) => rpc<C.BatchLabRunWorkerResult>('runBatchLabExperimentWorkerOnce',input,signal);
export const retryBatchLabExperiment = (input:{experiment_id:string}) => rpc<C.BatchLabExperimentSummary>('retryBatchLabExperiment',input);
export const listBatchLabAttemptEvents = (experimentId:string,signal?:AbortSignal) => rpc<Array<{id:string;attempt_id:string;event_type:string;created_at:string;data:any}>>('listBatchLabAttemptEvents',{experimentId,limit:100},signal);
export const listBatchLabDatasets = (signal?:AbortSignal) => rpc<DatasetVersion[]>('listBatchLabDatasets',{},signal);

const CHUNK_BYTES=512*1024;
export function bytesToBase64(bytes:Uint8Array):string {
  let binary=''; for(let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(binary);
}
function base64ToBytes(value:string):Uint8Array { const binary=atob(value); return Uint8Array.from(binary,c=>c.charCodeAt(0)); }
export type BatchLabSourceCsvImportResult = {history_count:number;session_count:number;character_count:number;previewable_history_count:number;dataset:DatasetVersion};
export async function importBatchLabSourceCsvFiles(input:{historyFile:File;sessionsFile:File;charactersFile:File;name?:string;onProgress?:(progress:number)=>void}):Promise<BatchLabSourceCsvImportResult> {
  const files=[{kind:'history',file:input.historyFile},{kind:'sessions',file:input.sessionsFile},{kind:'characters',file:input.charactersFile}] as const;
  const buffers=await Promise.all(files.map(({file})=>file.arrayBuffer()));
  const manifest=await Promise.all(files.map(async({kind,file},i)=>({kind,name:file.name,size:file.size,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffers[i]))).map(b=>b.toString(16).padStart(2,'0')).join(''),chunks:Math.ceil(file.size/CHUNK_BYTES)})));
  input.onProgress?.(0);
  const dataset=await rpc<DatasetVersion>('beginDatasetImport',{name:input.name?.trim() || `原始数据 ${new Date().toLocaleString()}`,files:manifest,idempotency_key:newIdempotencyKey()});
  const total=manifest.reduce((sum,f)=>sum+f.chunks,0); let completed=0;
  const jobs=manifest.flatMap((file,f)=>Array.from({length:file.chunks},(_,i)=>({f,i})));
  let next=0;
  await Promise.all(Array.from({length:Math.min(4,jobs.length)},async()=>{
    while(next<jobs.length) {
      const {f,i}=jobs[next++];
      const bytes=new Uint8Array(buffers[f]);
      const body={datasetId:dataset.id,kind:files[f].kind,index:i,data:bytesToBase64(bytes.subarray(i*CHUNK_BYTES,(i+1)*CHUNK_BYTES))};
      // A chunk is immutable, so transport retries are safe.
      try { await rpc('uploadDatasetChunk',body); } catch (error) { if(error instanceof BatchLabClientError && error.kind==='network') await rpc('uploadDatasetChunk',body); else throw error; }
      completed++;input.onProgress?.(Math.round(completed/total*90));
    }
  }));
  const result=await rpc<BatchLabSourceCsvImportResult>('finishDatasetImport',{datasetId:dataset.id});
  input.onProgress?.(100);return result;
}
function download(blob:Blob,name:string) { const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30_000); }
export async function getBatchLabAttemptContent(attemptId:string,field:'raw_output'|'input_messages'|'display_result'|'response_metadata',signal?:AbortSignal):Promise<string> {
  const parts:string[]=[];let cursor:string|null=null;
  do {
    const page:{text:string;next_cursor:string|null}=await rpc('getBatchLabAttemptContent',{attemptId,field,cursor:cursor??0,limit:20_000},signal);
    parts.push(page.text);cursor=page.next_cursor;
  } while(cursor!==null);
  return parts.join('');
}
export async function downloadBatchLabAttemptOutput(attemptId:string):Promise<void> {
  download(new Blob([await getBatchLabAttemptContent(attemptId,'raw_output')],{type:'text/plain;charset=utf-8'}),`output-${attemptId}.txt`);
}
export async function downloadBatchLabSourceCsv(datasetId:string,kind:'history'|'sessions'|'characters'):Promise<void> {
  const first=await rpc<{data:string;file:{name:string;chunks:number;size:number;sha256:string}}>('getDatasetChunk',{datasetId,kind,index:0});
  const chunks: Uint8Array<ArrayBuffer>[]=[base64ToBytes(first.data) as Uint8Array<ArrayBuffer>];
  for(let index=1;index<first.file.chunks;index++) chunks.push(base64ToBytes((await rpc<{data:string}>('getDatasetChunk',{datasetId,kind,index})).data) as Uint8Array<ArrayBuffer>);
  const blob=new Blob(chunks,{type:'text/csv;charset=utf-8'});
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))).map(b=>b.toString(16).padStart(2,'0')).join('');
  if(blob.size!==first.file.size || hash!==first.file.sha256) throw new Error('下载的 CSV 校验失败，请重试');
  download(blob,first.file.name);
}
export async function downloadBatchLabExperimentJsonl(experimentId:string,signal?:AbortSignal):Promise<Blob> {
  const lines:string[]=[];let cursor:string|null=null;
  do {
    const page=await getBatchLabExperimentResults(experimentId,{cursor,limit:5},signal);
    for(let sample of page.samples) {
      if((sample as any).preview_truncated) sample=(await listBatchLabSampleSetSamples(page.experiment.sample_set_id,{cursor:String(sample.ordinal),limit:1},signal)).items[0];
      const attempts=await Promise.all(page.attempts.filter(a=>a.sample_ordinal===sample.ordinal).map(async(attempt)=>{
        if(!(attempt as any).preview_truncated)return attempt;
        const [raw,display]=await Promise.all([getBatchLabAttemptContent(attempt.attempt_id,'raw_output',signal),getBatchLabAttemptContent(attempt.attempt_id,'display_result',signal)]);
        return {...attempt,raw_output:raw,display_result:JSON.parse(display || 'null'),preview_truncated:false};
      }));
      lines.push(JSON.stringify({schema_version:'batch_lab_v2',experiment:page.experiment,sample,attempts,annotations:page.annotations.filter(a=>a.sample_ordinal===sample.ordinal || a.sample_ordinal===null)}));
    }
    cursor=page.next_sample_cursor;
  } while(cursor);
  return new Blob([lines.join('\n')+'\n'],{type:'application/x-ndjson'});
}
function flatten(row:any):Record<string,string> {return Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v==null?'':typeof v==='object'?JSON.stringify(v):String(v)]));}
export async function exportBatchLabCsvBundle():Promise<void> {
  for(const kind of ['datasets','sample_set','snapshots','processor','experiment','attempts','events','annotations']) {
    const rows:any[]=[];let cursor:number|null=0;
    do { const page:{items:any[];next_cursor:number|null}=await rpc('exportTable',{kind,cursor});rows.push(...page.items);cursor=page.next_cursor; } while(cursor!==null);
    download(new Blob([Papa.unparse(rows.map(flatten))],{type:'text/csv;charset=utf-8'}),`${kind}.csv`);
  }
}
