import {Card,Collapse,Table,Tag,Typography} from 'antd';
import {firstLevelComparison} from '../lib/evaluation';
const renderLeaf=(value:unknown)=>value===undefined?'—':typeof value==='number'?<strong style={{fontSize:24}}>{value}</strong>:<div style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{typeof value==='string'?value:JSON.stringify(value,null,2)}</div>;
const renderValue=(value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)?<div>{Object.entries(value).map(([key,v])=><div key={key} style={{marginBottom:12}}><span style={{color:'#666'}}>{key}</span>{renderLeaf(v)}</div>)}</div>:renderLeaf(value);

export function JsonEvaluationView({value}:{value:unknown}){
 if(value&&typeof value==='object'&&!Array.isArray(value)){
  const result=value as Record<string,unknown>;
  if(typeof result.解释原因==='string'&&typeof result.结论==='string'){
   return <>
    <Card size="small" title="解释原因"><Typography.Paragraph style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',marginBottom:0}}>{result.解释原因}</Typography.Paragraph></Card>
    <Card size="small" title="结论" className="section-gap"><Tag color={result.结论==='A'||result.结论==='左边'?'blue':result.结论==='B'||result.结论==='右边'?'purple':'default'} style={{fontSize:16,padding:'4px 12px'}}>{result.结论}</Tag></Card>
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
