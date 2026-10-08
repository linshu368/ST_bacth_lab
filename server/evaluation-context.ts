import {pureUserInput} from '../src/lib/instruction-prompt.js';
import {excludeLastTurn} from '../src/lib/replay-sample.js';
type Row=Record<string,any>;
export const CLEANER_VERSION='body-v1';
export function cleanBody(raw:string){
 const warnings:string[]=[];
 let text=raw.replace(/<(status_bar|statusbar|status|状态栏)\b[^>]*>[\s\S]*?<\/\1>/gi,()=>{warnings.push('已移除明确标记的状态栏');return '';})
 .replace(/<details\b[^>]*>\s*<summary[^>]*>\s*(?:状态栏|人物状态|Status)[\s\S]*?<\/summary>[\s\S]*?<\/details>/gi,()=>{warnings.push('已移除状态栏折叠块');return '';});
 if(/<(script|style)\b/i.test(text)){warnings.push('存在脚本或样式块，请核对清洗结果');text=text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'');}
 text=text.replace(/<br\s*\/?\s*>|<\/(?:p|div|li|section)>/gi,'\n').replace(/<\/?[a-z][^>]*>/gi,'');
 text=text.replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
 if(!text.trim())warnings.push('清洗后正文为空');
 return {text:text.trim(),warnings};
}
export function renderInput(template:string,values:Record<string,string>){
 const required=['user_input','reply_a','reply_b'];for(const key of required)if(!template.includes(`{${key}}`))throw new Error(`输入模板缺少 {${key}}`);
 return template.replace(/\{([a-z_]+)\}/g,(_,key)=>{if(!(key in values))throw new Error(`未知输入变量 {${key}}`);return values[key];});
}
export function evaluationContext(stored:Row,experiment:Row,attempts:Row[],turn:number,near:number){
 const sample=experiment.exclude_last_turn?excludeLastTurn(stored as any):stored;
 const history=[...sample.history];const last=history.at(-1);
 if(last?.role!=='user'||pureUserInput(last.content).trim()!==pureUserInput(sample.user_input).trim())history.push({role:'user',content:sample.user_input});
 const users=history.flatMap((m:Row,i:number)=>m.role==='user'?[i]:[]);
 const count=experiment.run_mode==='multi_turn'?experiment.variants[0].max_turns:1;
 const targetPosition=users.length-count+turn-1;if(targetPosition<0||targetPosition>=users.length)throw new Error('待评轮次超出样本范围');
 const target=users[targetPosition];const sourceTurn=sample.turn_models?.find((m:Row)=>m.user_message_index===target)?.turn_index??sample.turn_index-count+turn;
 const far:string[]=[],close:string[]=[],warnings:string[]=[];
 for(let pos=0;pos<targetPosition;pos++){
  const i=users[pos];const source=sample.turn_models?.find((m:Row)=>m.user_message_index===i)?.turn_index??sourceTurn-targetPosition+pos;
  const prefix=`第 ${source} 轮\n用户：${pureUserInput(history[i].content)}`;
  if(pos<targetPosition-near){far.push(prefix+'\n[角色回复已省略，不作为评估依据]');continue;}
  const replayTurn=pos-(users.length-count)+1;
  if(replayTurn>0){
   const replies=experiment.variants.slice(0,2).map((v:Row)=>attempts.find(a=>a.variant_key===v.key&&a.turn_index===replayTurn));
   if(replies.some((a:Row)=>!a||a.status!=='succeeded'))throw new Error('近场重跑上下文缺失');
   close.push(prefix+'\nA 路径角色：'+cleanBody(replies[0].data.raw_output).text+'\nB 路径角色：'+cleanBody(replies[1].data.raw_output).text);
  }else close.push(prefix+'\n角色：'+cleanBody(history.slice(i+1,users[pos+1]).filter((m:Row)=>m.role==='assistant').map((m:Row)=>m.content).join('\n\n')).text);
 }
 const pair=experiment.variants.slice(0,2).map((v:Row)=>attempts.find(a=>a.variant_key===v.key&&a.turn_index===turn));
 if(pair.some((a:Row)=>!a||a.status!=='succeeded'||!a.data.raw_output?.trim()))throw new Error('两组尚无完整生成结果');
 if(pair.some((a:Row)=>['length','content_filter'].includes(a.data.finish_reason)))throw new Error('回复因长度限制或过滤而不完整');
 const cleaned=pair.map((a:Row)=>cleanBody(a.data.raw_output));cleaned.forEach((c:any,i:number)=>warnings.push(...c.warnings.map((w:string)=>`${i?'B':'A'}：${w}`)));
 if(cleaned.some((c:any)=>!c.text))throw new Error('清洗后正文为空');
 const input=pureUserInput(history[target].content);
 if(pair.some((a:Row)=>a.data.replay_user_input&&pureUserInput(a.data.replay_user_input).trim()!==input.trim()))throw new Error('A/B 用户输入与样本不一致');
 return {source_turn:sourceTurn,warnings,source_attempts:pair.map((a:Row)=>({id:a.id,attempt_count:a.attempt_count})),values:{
 far_history:far.join('\n\n')||'无',near_history:close.join('\n\n')||'无',
 evaluation_criteria:'',user_input:input,reply_a:cleaned[0].text,reply_b:cleaned[1].text}};
}
