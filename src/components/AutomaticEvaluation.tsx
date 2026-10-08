import type {BatchLabExperimentSummary} from '../lib/batch-lab-contracts';
import {JsonEvaluationView} from './JsonEvaluationView';
import {useEffect,useRef,useState} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {Alert,Button,Card,Collapse,Drawer,Form,Input,InputNumber,Modal,Select,Space,Statistic,Table,Tag,Typography,message} from 'antd';
import {rpc,newIdempotencyKey} from '../api/client';
import {INPUT_TEMPLATE,CRITERIA_TEMPLATE,DEFAULT_OUTPUT_FORMAT,verdict,type EvaluationTemplate,type EvaluationJob,type EvaluationItem,type EvaluationComparisonSnapshot} from '../lib/evaluation';
type Detail={job:EvaluationJob;summary:Record<string,number>;items:EvaluationItem[]};
type ResultSet=EvaluationJob&{summary:Record<string,number>};
const itemConclusion=(item:EvaluationItem)=>item.result&&typeof item.result==='object'&&!Array.isArray(item.result)?String((item.result as Record<string,unknown>).结论??''):'';
const itemReason=(item:EvaluationItem)=>item.result&&typeof item.result==='object'&&!Array.isArray(item.result)?String((item.result as Record<string,unknown>).解释原因??''):'';
function comparisonFrom(job:EvaluationJob,experiment?:BatchLabExperimentSummary):EvaluationComparisonSnapshot|undefined{
 if(job.comparison)return job.comparison;if(!experiment)return undefined;
 return {variable:experiment.comparison_variable,shared_instruction_prompt:experiment.output_preset?.content,variants:experiment.variants.slice(0,2).map(variant=>({
  key:variant.key,name:variant.name,generation_mode:variant.generation_mode,model_source:variant.model_source,
  model_id:variant.generation_mode==='original'?'original':variant.openrouter_model_id||variant.model_id,instruction_prompt:variant.output_preset?.content,
 }))};
}
const sideName=(comparison:EvaluationComparisonSnapshot|undefined,index:number)=>{
 const variant=comparison?.variants[index];const side=index?'B':'A';
 return `${side} · ${variant?.name??(index?'候选':'基准')} · ${variant?.generation_mode==='original'?'原始线上回复':'重新生成'}`;
};
function ComparisonIdentity({comparison}:{comparison:EvaluationComparisonSnapshot}){
 const variable=comparison.variable==='model'?'模型':comparison.variable==='instruction_prompt'?'Instruction prompt':'历史实验配置';
 return <Card size="small" title="本次 A/B 对照关系" extra={<Tag color="geekblue">唯一对比变量：{variable}</Tag>}>
  <div className="two-column">{comparison.variants.slice(0,2).map((variant,index)=>{
   const original=variant.generation_mode==='original';
   const model=original?'样本中该轮的原始线上模型':variant.model_source==='sample'?'沿用样本中该轮记录的模型':variant.model_id;
   const prompt=comparison.variable==='model'?comparison.shared_instruction_prompt:variant.instruction_prompt;
   return <Card key={variant.key} size="small" title={`${index?'B':'A'} · ${variant.name}`} extra={<Tag color={index?'purple':'blue'}>{original?'原始线上回复':'重新生成'}</Tag>}>
    <Typography.Paragraph style={{marginBottom:8}}><strong>模型：</strong>{model}</Typography.Paragraph>
    <Typography.Paragraph style={{marginBottom:0}} ellipsis={prompt?{rows:2,expandable:true,symbol:'展开完整指令'}:undefined}><strong>Instruction prompt：</strong>{original?'使用原始线上结果，不重新运行':prompt||'未填写'}</Typography.Paragraph>
   </Card>;
  })}</div>
 </Card>;
}
function ReviewComparison({item,comparison,onNext,nextDisabled,position,total}:{item:EvaluationItem;comparison?:EvaluationComparisonSnapshot;onNext:()=>void;nextDisabled:boolean;position:number;total:number}){
 const review=item.review,conclusion=itemConclusion(item);if(!review)return <Alert type="info" message="这条旧记录没有可直接展示的 A/B 摘要，请使用完整 Prompt 查看。"/>;
 const body=(text:string)=><div style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:480,overflowY:'auto'}}>{text}</div>;
 return <Space direction="vertical" className="full-width">
  <Card size="small" title={`本轮用户输入 · 原第 ${item.source_turn} 轮`}>{body(review.user_input)}</Card>
  <div className="two-column">
   <Card size="small" title={sideName(comparison,0)} extra={conclusion==='A'||conclusion==='左边'?<Tag color="blue">AI 选择</Tag>:null}>{body(review.reply_a)}</Card>
   <Card size="small" title={sideName(comparison,1)} extra={conclusion==='B'||conclusion==='右边'?<Tag color="purple">AI 选择</Tag>:null}>{body(review.reply_b)}</Card>
  </div>
  {item.status==='completed'?<Alert type="info" message={<>AI 结论：<strong>{conclusion||'未识别'}</strong></>} description={<div style={{whiteSpace:'pre-wrap'}}>{itemReason(item)||'模型没有返回解释原因'}</div>}/>:null}
  <div style={{display:'flex',justifyContent:'flex-end',alignItems:'center',gap:12}}>
   <Typography.Text type="secondary">正在复核 {position} / {total}</Typography.Text>
   <Button type="primary" disabled={nextDisabled} onClick={onNext}>下一个</Button>
  </div>
 </Space>;
}
function EvaluationSummaryView({detail}:{detail:Detail}){
 const s=detail.summary,total=s.A+s.B+s.tie+s.unclassified;
 return <>
  <Alert type="success" showIcon message={s.A>s.B?`当前结论：A 领先，${s.A}:${s.B}`:s.B>s.A?`当前结论：B 领先，${s.A}:${s.B}`:`当前结论：A、B 持平，${s.A}:${s.B}`} description={`A 胜 ${s.A} 条，B 胜 ${s.B} 条，平局 ${s.tie} 条，未识别 ${s.unclassified} 条${s.A+s.B?`；只计算明确胜负时，A 占 ${Math.round(s.A/(s.A+s.B)*100)}%，B 占 ${Math.round(s.B/(s.A+s.B)*100)}%`:''}`}/>
  <div className="stats-grid">{[['completed','已评估',total],['pending','待评估',s.pending],['running','进行中',s.running],['skipped','跳过',s.skipped],['failed','失败',s.failed]].map(([key,label,value])=><Statistic key={key} title={label} value={value}/>)}</div>
  <div className="stats-grid">{[['A','A 胜'],['B','B 胜'],['tie','平局'],['unclassified','未识别']].map(([key,label])=><Statistic key={key} title={label} value={s[key]}/>)}</div>
 </>;
}
function EvaluationItemsTable({detail,comparison,onInspect,inspectLoading,inspectId}:{detail:Detail;comparison?:EvaluationComparisonSnapshot;onInspect?:(id:string)=>void;inspectLoading?:boolean;inspectId?:string}){
 const [winnerFilter,setWinnerFilter]=useState<'all'|'A'|'B'|'tie'>('all');const [expandedRows,setExpandedRows]=useState<string[]>([]);const [page,setPage]=useState(1);const pageSize=10;
 const filtered=detail.items.filter(item=>winnerFilter==='all'||(item.status==='completed'&&verdict(item.result,detail.job.mapping)===winnerFilter));
 const reviewable=filtered.filter(item=>item.review);const currentIndex=reviewable.findIndex(item=>expandedRows.includes(item.id));
 const openReview=(id:string)=>{setExpandedRows([id]);const index=filtered.findIndex(item=>item.id===id);if(index>=0)setPage(Math.floor(index/pageSize)+1);setTimeout(()=>document.getElementById(`evaluation-row-${id}`)?.scrollIntoView({behavior:'smooth',block:'center'}),80);};
 const next=()=>{const target=reviewable[currentIndex+1]??(currentIndex<0?reviewable[0]:undefined);if(target)openReview(target.id);};
 return <>
  <Space wrap>
   <Typography.Text strong>筛选评估结论</Typography.Text>
   <Select aria-label="筛选评估结论" value={winnerFilter} style={{width:150}} onChange={value=>{setWinnerFilter(value);setExpandedRows([]);setPage(1);}} options={[{value:'all',label:`全部 (${detail.items.length})`},{value:'A',label:`A 胜 (${detail.summary.A})`},{value:'B',label:`B 胜 (${detail.summary.B})`},{value:'tie',label:`平局 (${detail.summary.tie})`}]}/>
   <Typography.Text type="secondary">共 {reviewable.length} 条可直接对比</Typography.Text>
  </Space>
  <Table size="small" rowKey="id" dataSource={filtered} pagination={{current:page,pageSize,onChange:setPage}} onRow={r=>({id:`evaluation-row-${r.id}`})} scroll={{x:1100}} expandable={{showExpandColumn:false,expandedRowKeys:expandedRows,rowExpandable:r=>!!r.review,onExpand:(open,r)=>setExpandedRows(open?[r.id]:[]),expandedRowRender:r=><ReviewComparison item={r} comparison={comparison} onNext={next} nextDisabled={currentIndex===reviewable.length-1} position={currentIndex+1} total={reviewable.length}/>}} columns={[
   {title:'样本',dataIndex:'sample_ordinal',render:n=>`#${n}`},{title:'轮次',render:(_,r)=>`对比 ${r.turn_index} / 原第 ${r.source_turn} 轮`},
   {title:'AI 结论',width:100,render:(_,r)=>{const conclusion=itemConclusion(r);return <Tag color={conclusion==='A'||conclusion==='左边'?'blue':conclusion==='B'||conclusion==='右边'?'purple':conclusion==='平局'?'default':undefined}>{r.status==='skipped'?'跳过':r.status==='completed'?(conclusion||'已评估'):({pending:'待评',running:'评估中',failed:'失败'}[r.status]??r.status)}</Tag>;}},
   {title:'原因摘要',width:360,render:(_,r)=><Typography.Paragraph ellipsis={{rows:2}} style={{marginBottom:0}}>{itemReason(r)||'—'}</Typography.Paragraph>},
   {title:'状态说明',render:(_,r)=>r.skip_reason||r.error||'—'},
   {title:'操作',width:onInspect?210:100,render:(_,r)=><Space><Button size="small" disabled={!r.review} onClick={()=>expandedRows.includes(r.id)?setExpandedRows([]):openReview(r.id)}>{expandedRows.includes(r.id)?'收起对比':'直接对比'}</Button>{onInspect?<Button size="small" loading={inspectLoading&&inspectId===r.id} onClick={()=>onInspect(r.id)}>完整 Prompt</Button>:null}</Space>},
 ]}/>
 </>;
}
function EvaluationItemDrawer({item,detail,onClose}:{item?:Record<string,any>;detail?:Detail;onClose:()=>void}){
 return <Drawer title="自动评估详情" open={!!item} onClose={onClose} width={900}>
  {item&&Object.prototype.hasOwnProperty.call(item,'result')?<JsonEvaluationView value={item.result}/>:null}
  {item?.skip_reason?<Alert type="info" message={item.skip_reason}/>:null}
  {item?.error?<Alert type="error" message={item.error}/>:null}
  {item?.request_messages?<Card title={item.request_sent?'完整送评 Prompt · 已提交请求内容':'完整送评 Prompt · 执行前预览'} size="small" className="section-gap">
   <Typography.Paragraph type="secondary">评估材料在前，评估标准和固定 JSON 输出要求位于最后。System 和 User 保持与实际请求一致。</Typography.Paragraph>
   <Typography.Paragraph copyable={{text:item.request_messages.map((m:{role:string;content:string})=>`【${m.role.toUpperCase()}】\n${m.content}`).join('\n\n')}}>复制完整 Prompt</Typography.Paragraph>
   {item.request_messages.map((m:{role:string;content:string},i:number)=><section key={i}><Typography.Title level={5}>{m.role.toUpperCase()}</Typography.Title><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{m.content}</pre></section>)}
  </Card>:null}
  <Collapse className="section-gap" items={[{key:'input',label:'实际送评输入和清洗提示',children:<><Typography.Paragraph>{item?.warnings?.join('；')}</Typography.Paragraph><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{item?.prompt??'数据不完整，未发起模型评估'}</pre></>},{key:'output',label:'本次固定输出格式 JSON',children:<pre style={{whiteSpace:'pre-wrap'}}>{detail?.job.output_format}</pre>},{key:'criteria',label:'本次冻结的评估标准',children:<pre style={{whiteSpace:'pre-wrap'}}>{detail?.job.templates.criteria.content}</pre>}]}/>
 </Drawer>;
}

export function AutomaticEvaluation({experiment}:{experiment:BatchLabExperimentSummary}){
 const experimentId=experiment.id,status=experiment.status;
 const client=useQueryClient();const [open,setOpen]=useState(false);const [selected,setSelected]=useState<string>();const [item,setItem]=useState<Record<string,any>>();
 const [apiKey,setApiKey]=useState('');

 const [form]=Form.useForm();const stop=useRef(false);useEffect(()=>()=>{stop.current=true;},[]);
 const templates=useQuery({queryKey:['evaluationTemplates'],queryFn:()=>rpc<EvaluationTemplate[]>('evaluationTemplates')});
 const jobs=useQuery({queryKey:['evaluations',experimentId],queryFn:()=>rpc<EvaluationJob[]>('evaluationList',{experiment_id:experimentId})});
 const detail=useQuery({queryKey:['evaluation',selected],enabled:!!selected,queryFn:()=>rpc<Detail>('evaluationDetail',{job_id:selected}),refetchInterval:5000});
 const [templateId,setTemplateId]=useState<string>('builtin-criteria-v3');const [templateName,setTemplateName]=useState('正文评估标准');const [content,setContent]=useState('');const [editing,setEditing]=useState(false);
 const fail=(e:Error)=>message.error(e.message);
 const save=useMutation({mutationFn:()=>rpc<EvaluationTemplate>('evaluationSaveTemplate',{kind:'criteria',name:templateName,content}),onSuccess:t=>{void client.invalidateQueries({queryKey:['evaluationTemplates']});form.setFieldsValue({criteria_template_id:t.id,criteria_content:t.content});setTemplateId(t.id);setEditing(false);message.success('已保存为新的共享版本');},onError:fail});
 const create=useMutation({mutationFn:(v:Record<string,unknown>)=>rpc<EvaluationJob>('evaluationCreate',{...v,experiment_id:experimentId,idempotency_key:newIdempotencyKey()}),onSuccess:j=>{setSelected(j.id);setOpen(false);void jobs.refetch();message.success('评估已创建，输入已冻结；点击执行后才调用模型');},onError:fail});
 const refresh=async()=>{await Promise.all([detail.refetch(),jobs.refetch()]);};
 const run=useMutation({mutationFn:async(id:string)=>{const key=apiKey.trim();stop.current=false;await rpc('evaluationResume',{job_id:id});while(!stop.current){const r=await rpc<Detail&{claimed:number}>('evaluationRun',{job_id:id,api_key:key||undefined});client.setQueryData(['evaluation',id],r);if(!r.claimed||!r.summary.pending)break;}},onSuccess:()=>{void refresh();},onError:fail});
 const keyInput=<Input.Password aria-label="评估 API Key" value={apiKey} onChange={e=>setApiKey(e.target.value)} disabled={run.isPending} autoComplete="off" placeholder="填写评审模型的 API Key；留空使用服务端配置"/>;
 const action=useMutation({mutationFn:(op:string)=>rpc(op,{job_id:selected}),onSuccess:()=>{void refresh();},onError:fail});
 const inspect=useMutation({mutationFn:(id:string)=>rpc<Record<string,any>>('evaluationItem',{job_id:selected,item_id:id}),onSuccess:setItem,onError:fail});
 function edit(){
  const id=form.getFieldValue('criteria_template_id')??'builtin-criteria-v3';const t=templates.data?.find(t=>t.id===id);setTemplateId(id);setTemplateName(t?.name??'新标准');setContent(form.getFieldValue('criteria_content')??t?.content??CRITERIA_TEMPLATE);setEditing(true);
 }
 function openCreate(){if(!form.getFieldValue('criteria_content'))form.setFieldValue('criteria_content',CRITERIA_TEMPLATE);setOpen(true);}
 const ready=['completed','failed','cancelled'].includes(status);
 return <Card title="评估配置与记录" size="small" extra={<Button disabled={!ready} onClick={openCreate}>新建正文评估</Button>}>
  <Typography.Paragraph type="secondary">每个重跑轮次分别评估一次，同时比较该轮 A/B 回复；前序轮次仅作上下文，不包含未来轮次。AI 结论独立保存，不修改人工评价。输入格式统一固定，评估标准可编辑并保存为共享模板。</Typography.Paragraph>
  <div className="section-gap"><Typography.Text>评估 API Key</Typography.Text>{keyInput}<Typography.Paragraph type="secondary">仅在当前页面临时使用，不保存到共享记录或模板；刷新页面后需重新填写。</Typography.Paragraph></div>
  {!ready?<Alert type="info" message="完成或停止生成实验后，可以创建评估。数据不完整的轮次会跳过。"/>:null}
  <Select aria-label="选择自动评估记录" className="full-width" placeholder="选择评估记录" value={selected} onChange={setSelected} disabled={run.isPending}
   options={jobs.data?.map(j=>({value:j.id,label:`${j.name} · ${j.model} · ${new Date(j.created_at).toLocaleString()}`}))}/>
  {jobs.isError||detail.isError?<Alert type="error" message={(jobs.error??detail.error)?.message}/>:null}
  {detail.data?<Space direction="vertical" className="full-width section-gap">
   <Typography.Text>评审模型：{detail.data.job.model}　近场：{detail.data.job.near_turns} 轮　并发：{detail.data.job.concurrency}</Typography.Text>
   <Typography.Text type="secondary">输入格式：{detail.data.job.templates.input.name} · {detail.data.job.templates.input.version}<br/>标准模板：{detail.data.job.templates.criteria.name} · {detail.data.job.templates.criteria.version}</Typography.Text>
   {comparisonFrom(detail.data.job,experiment)?<ComparisonIdentity comparison={comparisonFrom(detail.data.job,experiment)!}/>:null}
   <Space wrap>
    <Button type="primary" loading={run.isPending} disabled={!detail.data.summary.pending} onClick={()=>run.mutate(selected!)}>执行剩余评估</Button>
    <Button disabled={!run.isPending&&!detail.data.summary.running} onClick={()=>{stop.current=true;action.mutate('evaluationPause');}}>暂停后续评估</Button>
    <Button disabled={run.isPending||(!detail.data.summary.failed&&!detail.data.summary.running)} loading={action.isPending} onClick={()=>action.mutate('evaluationRetry')}>重新排队失败或超时项</Button>
    <Typography.Text type="secondary">执行期间保留页面；暂停后已发出的请求仍可能完成。</Typography.Text>
   </Space>
   <EvaluationSummaryView detail={detail.data}/>
   <EvaluationItemsTable key={detail.data.job.id} detail={detail.data} comparison={comparisonFrom(detail.data.job,experiment)} onInspect={id=>inspect.mutate(id)} inspectLoading={inspect.isPending} inspectId={inspect.variables}/>

  </Space>:null}
  <Modal title="新建正文自动评估" open={open} onCancel={()=>setOpen(false)} width={850} confirmLoading={create.isPending} okText="保存评估计划" onOk={()=>form.submit()}>
   <Form form={form} layout="vertical" initialValues={{name:'正文质量评估',model:'',base_url:'https://openrouter.ai/api/v1',near_turns:4,concurrency:4,criteria_template_id:'builtin-criteria-v3',criteria_content:CRITERIA_TEMPLATE}} onFinish={v=>create.mutate(v)}>
    <Alert type="info" message="先保存计划并核对实际送评输入，再执行。原始生成结果不会被清洗覆盖。"/>
    <Form.Item label="评估名称" name="name" rules={[{required:true}]}><Input maxLength={120}/></Form.Item>
    <div className="two-column"><Form.Item label="评审模型" name="model" rules={[{required:true}]}><Input placeholder="填写完整模型 ID"/></Form.Item><Form.Item label="模型接口 URL" name="base_url" rules={[{required:true}]}><Input/></Form.Item></div>
    <Form.Item label="评估 API Key" extra="仅在当前页面临时使用；留空使用服务端配置。">{keyInput}</Form.Item>
    <div className="two-column"><Form.Item label="近场完整历史轮数" name="near_turns"><InputNumber min={0} max={20}/></Form.Item><Form.Item label="评估并发请求数" name="concurrency"><InputNumber min={1} max={100}/></Form.Item></div>
    <Alert type="info" message="输入格式固定：历史对话、当前用户输入和 A/B 回复。"/>
    <Form.Item label="评估标准模板" name="criteria_template_id" rules={[{required:true}]}><Select onChange={id=>form.setFieldValue('criteria_content',templates.data?.find(t=>t.id===id)?.content??CRITERIA_TEMPLATE)} options={templates.data?.map(t=>({value:t.id,label:`${t.name} · ${t.version}`}))}/></Form.Item>
    <Form.Item label="评估标准 Prompt" name="criteria_content" extra="可以直接修改。本次保存后会冻结在评估计划中，不影响原模板。" rules={[{required:true,message:'请填写评估标准'}]}><Input.TextArea rows={18} maxLength={40000} showCount/></Form.Item>
    <Button onClick={edit}>将当前评估标准另存为共享模板</Button>
    <Card size="small" title="固定输出格式 JSON" className="section-gap"><Typography.Paragraph type="secondary">模型先解释原因，再给出结论。结论只允许“A”“B”或“平局”，用于自动汇总比分。</Typography.Paragraph><pre style={{whiteSpace:'pre-wrap'}}>{DEFAULT_OUTPUT_FORMAT}</pre></Card>
    <Typography.Paragraph type="secondary" className="section-gap">远场保留全部用户原话，省略角色回复；近场默认保留前 4 轮。清洗只去除明确的状态栏及 HTML 展示标签，保留正文和选项；特殊自定义格式请先核对预览。</Typography.Paragraph>
   </Form>
  </Modal>
  <Modal title="共享评估标准模板" open={editing} onCancel={()=>setEditing(false)} width={950} okText="另存为新版本并使用" confirmLoading={save.isPending} onOk={()=>save.mutate()}>
   <Typography.Paragraph>为当前调整后的评估标准命名并保存，其他同事即可直接复用。输出格式保持固定。</Typography.Paragraph>
   <Typography.Text type="secondary">当前版本：{templateId}</Typography.Text>
   <Input aria-label="模板名称" value={templateName} onChange={e=>setTemplateName(e.target.value)} maxLength={120}/>
   <Typography.Paragraph>在这里定义比较标准。模型会先充分解释 A、B 的关键差异，再给出“A / B / 平局”的结论。</Typography.Paragraph>
   <Input.TextArea aria-label="模板正文" rows={18} value={content} onChange={e=>setContent(e.target.value)} maxLength={40000}/>
  </Modal>
  <EvaluationItemDrawer item={item} detail={detail.data} onClose={()=>setItem(undefined)}/>
 </Card>;
}

export function EvaluationPage({experiments,loading}:{experiments:BatchLabExperimentSummary[];loading:boolean}){
 const [experimentId,setExperimentId]=useState<string>();
 const source=experiments.find(e=>e.id===experimentId);
 return <section className="section-gap">
  <div className="page-head"><div><Typography.Title level={2}>大模型评估</Typography.Title><Typography.Paragraph type="secondary">选择实验结果，配置评审模型和评估标准，独立运行与查看评估。</Typography.Paragraph></div></div>
  <Card title="1 选择待评估的实验结果" className="section-gap">
   <Select aria-label="待评估的实验" showSearch optionFilterProp="label" className="full-width" placeholder="选择一个已完成或已停止的实验" value={experimentId} onChange={setExperimentId} loading={loading}
    options={experiments.map(e=>({value:e.id,label:`${e.name} · ${{completed:'已完成',failed:'有失败任务',cancelled:'已停止',running:'运行中',queued:'待执行',draft:'草稿'}[e.status]??e.status}`,disabled:!['completed','failed','cancelled'].includes(e.status)}))}/>
   {!loading&&!experiments.length?<Typography.Paragraph type="secondary" className="section-gap">暂无实验记录。先在“新建实验”生成 A/B 结果，再回到这里评估。</Typography.Paragraph>:null}
  </Card>
  <Collapse className="section-gap" items={[{key:'format',label:'统一输入格式 只读',children:<><Typography.Paragraph>对话历史和待评内容使用标签明确分区；实际送评时，评估标准和固定输出要求追加在所有材料之后。远场保留用户原话，近场保留完整对话。</Typography.Paragraph><pre style={{whiteSpace:'pre-wrap'}}>{INPUT_TEMPLATE}</pre></>}]}/>
  {source?<div className="section-gap"><AutomaticEvaluation key={source.id} experiment={source}/></div>:null}
 </section>;
}

export function EvaluationResultsPage({experiments}:{experiments:BatchLabExperimentSummary[]}){
 const [selected,setSelected]=useState<string>();
 const [item,setItem]=useState<Record<string,any>>();
 const sets=useQuery({queryKey:['evaluationResultSets'],queryFn:()=>rpc<ResultSet[]>('evaluationResultList')});
 const detail=useQuery({queryKey:['evaluation',selected],enabled:!!selected,queryFn:()=>rpc<Detail>('evaluationDetail',{job_id:selected})});
 const inspect=useMutation({mutationFn:(id:string)=>rpc<Record<string,any>>('evaluationItem',{job_id:selected,item_id:id}),onSuccess:setItem,onError:(error:Error)=>message.error(error.message)});
 const experimentName=(id:string)=>experiments.find(item=>item.id===id)?.name??id.slice(0,8);
 const sourceExperiment=detail.data?experiments.find(item=>item.id===detail.data.job.experiment_id):undefined;
 const comparison=detail.data?comparisonFrom(detail.data.job,sourceExperiment):undefined;
 return <section className="section-gap">
  <div className="page-head"><div><Typography.Title level={2}>评估结果</Typography.Title><Typography.Paragraph type="secondary">每次大模型评估都是一个独立保存的结果集，可随时打开复盘和同步。</Typography.Paragraph></div></div>
  {sets.isError?<Alert type="error" message={sets.error.message}/>:null}
  <Card title="已保存的评估结果集">
   <Table size="small" rowKey="id" loading={sets.isPending} dataSource={sets.data??[]} pagination={{pageSize:10}} scroll={{x:900}} columns={[
    {title:'评估名称',dataIndex:'name'},{title:'来源实验',render:(_,r)=>experimentName(r.experiment_id)},{title:'两组身份',render:(_,r)=>{const c=comparisonFrom(r,experiments.find(item=>item.id===r.experiment_id));return c?`${c.variants[0]?.name??'A'} / ${c.variants[1]?.name??'B'}`:'A / B';}},{title:'评审模型',dataIndex:'model'},
    {title:'A:B',render:(_,r)=><strong>{r.summary.A}:{r.summary.B}</strong>},{title:'平局',render:(_,r)=>r.summary.tie},{title:'已评估',render:(_,r)=>r.summary.A+r.summary.B+r.summary.tie+r.summary.unclassified},
    {title:'创建时间',dataIndex:'created_at',render:value=>new Date(value).toLocaleString('zh-CN')},{title:'操作',render:(_,r)=><Button type={selected===r.id?'primary':'default'} size="small" onClick={()=>setSelected(r.id)}>查看结果</Button>},
   ]}/>
  </Card>
  {detail.isError?<Alert type="error" message={detail.error.message}/>:null}
  {detail.data?<Card className="section-gap" title={`${detail.data.job.name} · ${experimentName(detail.data.job.experiment_id)}`} extra={<Tag>{detail.data.job.model}</Tag>}>
   <Space direction="vertical" className="full-width">
    {comparison?<ComparisonIdentity comparison={comparison}/>:null}
    <EvaluationSummaryView detail={detail.data}/>
    <EvaluationItemsTable key={detail.data.job.id} detail={detail.data} comparison={comparison} onInspect={id=>inspect.mutate(id)} inspectLoading={inspect.isPending} inspectId={inspect.variables}/>
   </Space>
  </Card>:null}
  <EvaluationItemDrawer item={item} detail={detail.data} onClose={()=>setItem(undefined)}/>
 </section>;
}
