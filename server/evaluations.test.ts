import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createEvaluationService} from './evaluations.js';
import {evaluationContext,cleanBody,renderInput} from './evaluation-context.js';
import {INPUT_TEMPLATE,evaluationResultSchema,DEFAULT_MAPPING,verdict,flattenJson,firstLevelComparison,singleOutputFormat,pairedOutputFormat,validatePairedResult,validateComparisonResult,validateDirectionalComparisonResult,DEFAULT_OUTPUT_FORMAT} from '../src/lib/evaluation.js';
const db=new PGlite();const q=async<T=any>(sql:string,args:any[]=[])=> (await db.query<T>(sql,args)).rows;
const tx=async(statements:Array<{text:string;values?:any[]}>)=>db.transaction(async c=>{const result:any[]=[];for(const s of statements)result.push((await c.query(s.text,s.values??[])).rows);return result;});
before(async()=>db.exec(await readFile(new URL('./schema.sql',import.meta.url),'utf8')));after(()=>db.close());
function contextFixture(){
 const history=[];for(let i=1;i<=6;i++){history.push({role:'user',content:`USER${i}`});if(i<6)history.push({role:'assistant',content:`OLD${i}`});}
 const experiment={exclude_last_turn:true,run_mode:'multi_turn',comparison_variable:'instruction_prompt',variants:[
  {key:'a',name:'线上 A',max_turns:2,generation_mode:'original',model_source:'sample',model_id:'original',openrouter_model_id:'original'},
  {key:'b',name:'候选 B',max_turns:2,generation_mode:'generate',model_source:'sample',model_id:'sample-original-model',openrouter_model_id:'sample-original-model',output_preset:{content:'候选指令'}},
 ]};
 const stored={history,user_input:'USER6',turn_index:6,character_snapshot:{name:'角色'}};
 const attempts=['a','b'].flatMap(variant_key=>[1,2].map(turn_index=>({id:randomUUID(),attempt_count:1,variant_key,turn_index,status:'succeeded',data:{raw_output:`${variant_key}-NEW${turn_index}`,replay_user_input:`USER${turn_index+3}`,finish_reason:'stop'}})));
 return {stored,experiment,attempts};
}
test('context keeps all past users, splits regenerated paths and never leaks future turns',()=>{
 const f=contextFixture();const c=evaluationContext(f.stored,f.experiment,f.attempts,2,1);
 assert.match(c.values.far_history,/USER1/);assert.match(c.values.far_history,/USER3/);assert.doesNotMatch(c.values.far_history,/OLD/);
 assert.match(c.values.near_history,/a-NEW1/);assert.match(c.values.near_history,/b-NEW1/);assert.doesNotMatch(c.values.near_history,/OLD4/);
 assert.equal(c.values.user_input,'USER5');assert.equal(c.source_turn,5);assert.equal(c.values.reply_a,'a-NEW2');
 assert.doesNotMatch(JSON.stringify(c),/USER6/);
 const rendered=renderInput(INPUT_TEMPLATE,c.values);assert.match(rendered,/<conversation_history>/);assert.match(rendered,/<user_input>/);assert.match(rendered,/<reply_a>/);
 assert.throws(()=>renderInput('{reply_a}',c.values),/缺少/);
 const dirty=cleanBody('正文<p>保留</p><status>状态栏</status>\n1. 去花园\n2. 留下');assert.match(dirty.text,/去花园/);assert.doesNotMatch(dirty.text,/状态栏/);
 assert.deepEqual(evaluationResultSchema.parse({scores:{A:8,B:5},notes:['自定义']}),{scores:{A:8,B:5},notes:['自定义']});
 assert.equal(verdict({结论:{胜者:'左'}},{...DEFAULT_MAPPING,winner_path:'/结论/胜者',a_value:'左'}),'A');
 assert.equal(verdict({score:9}),'unclassified');
 assert.equal(flattenJson({dimensions:[{rating:4}]})['/dimensions/0/rating'],4);
 assert.deepEqual(evaluationResultSchema.parse([1,null,true]),[1,null,true]);
});
test('evaluation freezes inputs, preserves manual votes, supports retry and isolates concurrent claims',async()=>{
 const f=contextFixture();const experimentId=randomUUID(),set=randomUUID();const experiment={...f.experiment,id:experimentId,sample_set_id:set,status:'completed'};
 await q("INSERT INTO lab_records(kind,id,data) VALUES('experiment',$1,$2)",[experimentId,JSON.stringify(experiment)]);
 await q('INSERT INTO lab_snapshots(sample_set_id,ordinal,data) VALUES($1,0,$2)',[set,JSON.stringify(f.stored)]);
 for(const a of f.attempts)await q('INSERT INTO lab_attempts(id,experiment_id,sample_set_id,sample_ordinal,variant_key,turn_index,status,attempt_count,data) VALUES($1,$2,$3,0,$4,$5,$6,1,$7)',[a.id,experimentId,set,a.variant_key,a.turn_index,a.status,JSON.stringify(a.data)]);
 await q('INSERT INTO lab_annotations VALUES($1,0,1,$2)',[experimentId,JSON.stringify({tag:'preference:b'})]);
 let calls=0;let invalid=true;let responseResult:any={解释原因:'A 准确承接用户行动，B 遗漏关键要求。',结论:'A'};let lastMessages:any;
 const operation=createEvaluationService({query:q,transaction:tx,env:{BATCH_LAB_MODEL_KEY:'test'},fetcher:async(_url,init)=>{calls++;assert.equal(new Headers(init?.headers).get('Authorization'),calls===1?'Bearer custom-evaluation-key':'Bearer test');const body=JSON.parse(String(init?.body));lastMessages=body.messages;assert.equal(body.model,'judge/model');assert.doesNotMatch(body.messages[1].content,/USER6|角色与世界设定|数据有效性信息/);assert.match(body.messages[1].content,/输出格式以以下 JSON 示例为准/);assert.doesNotMatch(body.messages[0].content,/本次手动标准/);return Response.json({model:'judge/model',choices:[{message:{content:invalid?'not json':JSON.stringify(responseResult)},finish_reason:'stop'}]});}});
 const input={experiment_id:experimentId,name:'评估',model:'judge/model',base_url:'https://openrouter.ai/api/v1',input_template_id:'builtin-input-v1',criteria_template_id:'builtin-criteria-v3',criteria_content:'本次手动标准：只比较是否准确承接用户动作。',near_turns:1,concurrency:1,idempotency_key:randomUUID()};
 const job=await operation('evaluationCreate',input);assert.equal(calls,0);assert.equal((await operation('evaluationCreate',input)).id,job.id);
 assert.equal(job.templates.input.id,'fixed-input-v4');
 assert.deepEqual(job.comparison.variants.map((variant:any)=>[variant.name,variant.generation_mode]),[['线上 A','original'],['候选 B','generate']]);
 assert.equal(job.comparison.variants[1].instruction_prompt,'候选指令');
 assert.doesNotMatch(job.templates.input.content,/user_profile|用户画像|character|角色与世界设定|data_validity|数据有效性信息/);
 assert.equal(job.generate_profile,undefined);
 assert.ok((await operation('evaluationTemplates')).every((t:any)=>t.kind==='criteria'));
 await assert.rejects(operation('evaluationSaveTemplate',{kind:'input',name:'替换输入',content:'随意'}),/输入格式已固定/);
 const before=await operation('evaluationDetail',{job_id:job.id});assert.equal(before.summary.total,2);assert.equal(before.items[0].prompt,undefined);assert.match(before.items[0].review.reply_a,/a-NEW1/);assert.match(before.items[0].review.reply_b,/b-NEW1/);
 const frozen=await operation('evaluationItem',{job_id:job.id,item_id:before.items[0].id});
 assert.equal(frozen.request_sent,false);const assembled=frozen.request_messages[1].content;assert.ok(assembled.startsWith(`<evaluation_material>\n${frozen.prompt}`));assert.match(assembled,/本次手动标准/);assert.match(assembled,/\"解释原因\"/);assert.ok(assembled.indexOf('</evaluation_material>')<assembled.indexOf('<evaluation_criteria>'));assert.ok(assembled.indexOf('</evaluation_criteria>')<assembled.indexOf('<output_requirements>'));assert.ok(assembled.trim().endsWith('</output_requirements>'));assert.ok(assembled.lastIndexOf('解释原因')<assembled.lastIndexOf('结论'));assert.match(job.templates.criteria.version,/本次手动调整/);
 await q("UPDATE lab_attempts SET data=jsonb_set(data,'{raw_output}','\"CHANGED\"') WHERE experiment_id=$1",[experimentId]);
 assert.equal((await operation('evaluationItem',{job_id:job.id,item_id:before.items[0].id})).prompt,frozen.prompt);
 await operation('evaluationPause',{job_id:job.id});assert.equal((await operation('evaluationRun',{job_id:job.id})).claimed,0);
 await operation('evaluationResume',{job_id:job.id});await operation('evaluationRun',{job_id:job.id,api_key:' custom-evaluation-key '});assert.equal((await operation('evaluationDetail',{job_id:job.id})).summary.failed,1);
 const failedItem=(await operation('evaluationDetail',{job_id:job.id})).items.find((i:any)=>i.status==='failed');
 const sent=await operation('evaluationItem',{job_id:job.id,item_id:failedItem.id});assert.equal(sent.request_sent,true);assert.deepEqual(sent.request_messages,lastMessages);
 assert.doesNotMatch(JSON.stringify(await operation('evaluationDetail',{job_id:job.id})),/custom-evaluation-key/);
 invalid=false;await operation('evaluationRetry',{job_id:job.id});await Promise.all([operation('evaluationRun',{job_id:job.id}),operation('evaluationRun',{job_id:job.id})]);
 const final=await operation('evaluationDetail',{job_id:job.id});assert.equal(final.summary.A,2);assert.equal(final.job.status,'completed');assert.equal(calls,3);
 const savedSets=await operation('evaluationResultList');const saved=savedSets.find((item:any)=>item.id===job.id);assert.equal(saved.summary.A,2);assert.equal(saved.summary.total,2);
 responseResult={解释原因:'B 准确落实要求，A 遗漏一个关键动作。',结论:'B'};
 const custom=await operation('evaluationCreate',{...input,output_format:JSON.stringify({质量:0,解释:'说明'}),idempotency_key:randomUUID()});
 assert.equal(custom.output_format,DEFAULT_OUTPUT_FORMAT);
 await operation('evaluationRun',{job_id:custom.id});const customDetail=await operation('evaluationDetail',{job_id:custom.id});assert.equal(customDetail.summary.B,1);assert.deepEqual(customDetail.items.find((i:any)=>i.status==='completed').result,responseResult);
 responseResult={解释原因:'理由',结论:'左边'};await operation('evaluationRun',{job_id:custom.id});assert.equal((await operation('evaluationDetail',{job_id:custom.id})).summary.failed,1);
 assert.equal((await q('SELECT data FROM lab_annotations WHERE experiment_id=$1',[experimentId]))[0].data.tag,'preference:b');
 const template=await operation('evaluationSaveTemplate',{kind:'criteria',name:'改版',content:'新的要求'});assert.ok(template.id);assert.notEqual(final.job.templates.criteria.content,'新的要求');
});

test('comparison splits one level only and preserves nested content',()=>{
 const value={A:{评分:8,说明:{证据:['原话']}},B:{评分:6,说明:{证据:['另一句']}},结论:'A 更好'};
 const rows=firstLevelComparison(value);
 assert.deepEqual(rows.map(r=>r.key),['评分','说明','结论']);
 assert.deepEqual(rows[1].A,{证据:['原话']});
 assert.deepEqual(firstLevelComparison({质量:{A:{分数:8},B:{分数:6}},解释:'依据'}),[{key:'质量',A:{分数:8},B:{分数:6}},{key:'解释',shared:'依据'}]);
});

test('define one output dictionary and enforce identical A and B keys',()=>{
 const format='{"评分":0,"评分理由":"详细解释"}';
 assert.deepEqual(pairedOutputFormat(format),{A:{评分:0,评分理由:'详细解释'},B:{评分:0,评分理由:'详细解释'}});
 assert.throws(()=>singleOutputFormat('{"A":{},"B":{}}'),/不要包含外层/);
 assert.throws(()=>singleOutputFormat('[]'),/字典/);
 assert.doesNotThrow(()=>validatePairedResult({A:{评分:9,评分理由:'详细证据'},B:{评分:7,评分理由:'具体问题'}},format));
 assert.throws(()=>validatePairedResult({A:{评分:9},B:{评分:7,评分理由:'解释'}},format),/字段/);
});

test('fixed comparison output contains explanation first and a constrained conclusion',()=>{
 assert.deepEqual(Object.keys(JSON.parse(DEFAULT_OUTPUT_FORMAT)),['解释原因','结论']);
 assert.equal(JSON.parse(DEFAULT_OUTPUT_FORMAT).结论,'A');
 assert.doesNotThrow(()=>validateComparisonResult({解释原因:'A 更准确地回应了用户的动作。',结论:'A'}));
 assert.doesNotThrow(()=>validateComparisonResult({解释原因:'两边没有足够明显的差异。',结论:'平局'}));
 assert.throws(()=>validateComparisonResult({结论:'A',解释原因:'理由'}),/先写/);
 assert.throws(()=>validateComparisonResult({解释原因:'理由',结论:'左边'}),/A.*B.*平局/);
 assert.throws(()=>validateComparisonResult({解释原因:'理由',结论:'B',评分:8}),/两个字段/);
 assert.equal(verdict({解释原因:'理由',结论:'B'}),'B');
 assert.doesNotThrow(()=>validateDirectionalComparisonResult({解释原因:'旧记录理由',结论:'左边'}));
});

test('evaluation creation loads all snapshots in one query',async()=>{
 const f=contextFixture();const experimentId=randomUUID(),set=randomUUID();
 await q("INSERT INTO lab_records(kind,id,data) VALUES('experiment',$1,$2)",[experimentId,JSON.stringify({...f.experiment,id:experimentId,sample_set_id:set,status:'completed'})]);
 for(const ordinal of [0,1]){
  await q('INSERT INTO lab_snapshots(sample_set_id,ordinal,data) VALUES($1,$2,$3)',[set,ordinal,JSON.stringify(f.stored)]);
  for(const a of f.attempts)await q('INSERT INTO lab_attempts(id,experiment_id,sample_set_id,sample_ordinal,variant_key,turn_index,status,attempt_count,data) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8)',[randomUUID(),experimentId,set,ordinal,a.variant_key,a.turn_index,a.status,JSON.stringify(a.data)]);
 }
 let snapshotReads=0;
 const countedQuery:typeof q=async(sql,args=[])=>{if(/FROM lab_snapshots/i.test(sql))snapshotReads++;return q(sql,args);};
 const operation=createEvaluationService({query:countedQuery as any,transaction:tx,env:{BATCH_LAB_MODEL_KEY:'test'}});
 const job=await operation('evaluationCreate',{experiment_id:experimentId,name:'批量读取测试',model:'judge/model',base_url:'https://openrouter.ai/api/v1',criteria_template_id:'builtin-criteria-v3',near_turns:1,concurrency:1,idempotency_key:randomUUID()});
 assert.equal(snapshotReads,1);
 assert.equal((await operation('evaluationDetail',{job_id:job.id})).summary.total,4);
});
