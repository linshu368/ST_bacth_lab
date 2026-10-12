import {Card,Collapse,Table,Tag,Typography} from 'antd';
import {EVALUATION_DIMENSIONS,firstLevelComparison} from '../lib/evaluation';
const renderLeaf=(value:unknown)=>value===undefined?'—':typeof value==='number'?<strong style={{fontSize:24}}>{value}</strong>:<div style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{typeof value==='string'?value:JSON.stringify(value,null,2)}</div>;
const renderValue=(value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)?<div>{Object.entries(value).map(([key,v])=><div key={key} style={{marginBottom:12}}><span style={{color:'#666'}}>{key}</span>{renderLeaf(v)}</div>)}</div>:renderLeaf(value);
const isRecord=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

export function JsonEvaluationView({value}:{value:unknown}){
 if(isRecord(value)&&typeof value.结论==='string'){
  const reason=value.解释原因;
  if(typeof reason==='string'){
   return <>
    <Card size="small" title="解释原因"><Typography.Paragraph style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',marginBottom:0}}>{reason}</Typography.Paragraph></Card>
    <Card size="small" title="结论" className="section-gap"><Tag color={value.结论==='A'||value.结论==='左边'?'blue':value.结论==='B'||value.结论==='右边'?'purple':'default'} style={{fontSize:16,padding:'4px 12px'}}>{value.结论}</Tag></Card>
    <Collapse className="section-gap" items={[{key:'raw',label:'完整原始 JSON',children:<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(value,null,2)}</pre>}]}/>
   </>;
  }
  if(isRecord(reason)){
   const scoreRows=EVALUATION_DIMENSIONS.map(name=>{const score=isRecord(reason[name])?reason[name] as Record<string,unknown>:{};return {key:name,name,A:score.A,B:score.B,说明:score.说明};});
   const issues=Array.isArray(reason.硬性问题)?reason.硬性问题.map(String):[];
   return <>
    <Card size="small" title="六维评分与理由">
     <Table size="small" rowKey="key" pagination={false} dataSource={scoreRows} scroll={{x:720}} columns={[
      {title:'维度',dataIndex:'name',width:150},
      {title:'A',dataIndex:'A',width:70,render:renderLeaf},
      {title:'B',dataIndex:'B',width:70,render:renderLeaf},
      {title:'评分理由',dataIndex:'说明',render:renderLeaf},
     ]}/>
    </Card>
    <Card size="small" title="硬性问题" className="section-gap"><Typography.Paragraph style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',marginBottom:0}}>{issues.length?issues.join('\n'):'无'}</Typography.Paragraph></Card>
    <Card size="small" title="综合判断" className="section-gap"><Typography.Paragraph style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',marginBottom:0}}>{String(reason.综合判断??'—')}</Typography.Paragraph></Card>
    <Card size="small" title="结论" className="section-gap"><Tag color={value.结论==='A'?'blue':value.结论==='B'?'purple':'default'} style={{fontSize:16,padding:'4px 12px'}}>{value.结论}</Tag></Card>
    <Collapse className="section-gap" items={[{key:'raw',label:'完整原始 JSON',children:<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(value,null,2)}</pre>}]}/>
   </>;
  }
 }
 const rows=firstLevelComparison(value);
 return <>
  <Table size="small" rowKey="key" pagination={false} dataSource={rows} scroll={{x:650}} columns={[
   {title:'评估项',dataIndex:'key',width:150},
   {title:'A',dataIndex:'A',render:renderValue},
   {title:'B',dataIndex:'B',render:renderValue},
   ...(rows.some(r=>r.shared!==undefined)?[{title:'共同结论 / 其他字段',dataIndex:'shared',render:renderValue}]:[]),
  ]}/>
  <Collapse items={[{key:'raw',label:'完整原始 JSON',children:<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(value,null,2)}</pre>}]}/>
 </>;
}
