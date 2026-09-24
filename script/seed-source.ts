import { loadEnvFile } from 'node:process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { datasetOperation, CHUNK_BYTES } from '../server/datasets';
try { loadEnvFile('.env.local'); } catch { /* CI */ }
const definitions=[['history','chat_history_rows.csv'],['sessions','chat_sessions_rows.csv'],['characters','characters_rows.csv']] as const;
const files=await Promise.all(definitions.map(async([kind,name])=>{
  const bytes=await readFile(new URL(`../data/resouce/${name}`,import.meta.url));
  return {kind,name,bytes,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),chunks:Math.ceil(bytes.length/CHUNK_BYTES)};
}));
const dataset:any=await datasetOperation('beginDatasetImport',{name:'初始 CSV（仓库导入）',idempotency_key:'653cd132-afb0-4c11-a1d1-23766c1c6d38',files:files.map(({bytes,...metadata})=>metadata)});
if(dataset.status==='ready'){console.log(`原始数据 V${dataset.version} 已存在，未覆盖。`);process.exit(0);}
for(const file of files) {
  for(let index=0;index<file.chunks;index++) await datasetOperation('uploadDatasetChunk',{datasetId:dataset.id,kind:file.kind,index,data:file.bytes.subarray(index*CHUNK_BYTES,(index+1)*CHUNK_BYTES).toString('base64')});
  console.log(`${file.name} 原件上传完成。`);
}
const result:any=await datasetOperation('finishDatasetImport',{datasetId:dataset.id});
console.log(JSON.stringify({version:result.dataset.version,history:result.history_count,sessions:result.session_count,characters:result.character_count}));
