import { z } from 'zod';
export const INPUT_TEMPLATE = `<conversation_history>
<far_history>
{far_history}
</far_history>

<near_history>
{near_history}
</near_history>
</conversation_history>

<content_to_evaluate>
<user_input>
{user_input}
</user_input>

<reply_a>
{reply_a}
</reply_a>

<reply_b>
{reply_b}
</reply_b>
</content_to_evaluate>`;
export const CRITERIA_TEMPLATE = `你是一名成人向角色扮演文本的质量评审。你要比较同一轮对话里两个版本（A、B）的回复正文，判断哪个写得更好，并说明为什么。

═══ 一、背景与前提 ═══

这是一个成人向（18+）的角色扮演平台。用户和角色都是成年人，情色与露骨的性描写是平台明确允许的核心内容。因此：
- 露骨本身不是缺陷，也不是优点。不要因为写得露骨而扣分，也不要因为写得露骨而加分。
- 你评判的是"写得好不好"：是否贴合用户这一轮的输入、是否合乎人设与前文、是否有具体的细节与张力、是否有节奏地推进。
- 无故回避是缺陷。包括：拒绝、说教、跳出角色提醒用户、突然变得含蓄、用"过了一会儿""一夜缠绵"之类的概括直接跳过用户想要的场面。这些都在"意图响应"中扣分。
- 唯一的底线：任何被描写为未成年的角色参与性相关内容，必须在【硬性问题】中标出。

你只评估"正文"，即叙述与对白本身。如果回复里夹带状态栏、记忆区、选项、系统提示等非正文内容，直接忽略，有没有都不影响评分。

═══ 三、评审流程（必须按顺序做） ═══

第 1 步：理解用户这一轮要什么。
  先不看回复，只读【用户本轮输入】和【前文对话】，在内部明确三件事：
  a) 用户明确要求的（做什么、问什么）；
  b) 用户没说但从前文可推知的期待（场景走向、关系阶段、想要的情绪）；
  c) 用户没有要求、不该由回复擅自替他决定的事。
第 2 步：分别通读 A 和 B，对照第 1 步的结论，逐个维度找证据。
第 3 步：按各维度的评分标准给 A、B 各自打分，再做对比。
第 4 步：给出总体结论。

评审时的纪律：
- 不要偏向长回复。长度不是质量；靠重复、绕圈、替用户行动撑出来的长度要扣分。
- 不要偏向先出现的回复。A、B 的顺序是随机的，与质量无关。
- 每个判断都要引用回复中的原文作为证据，每处引用不超过 40 字。没有证据的判断不要写。
- 打分只依据文本，不要猜测它"本来想写什么"。

═══ 四、评分维度（共 6 项，每项 1~5 分，整数） ═══

──────────────────────────
维度 1：意图响应
──────────────────────────
【评什么】回复有没有实实在在地回应用户这一句话的意图：用户要什么，就给什么，没有绕开、曲解、淡化或擅自改写。

【为什么重要】这是最基本的一项。回复写得再漂亮，如果没有回应用户想要的东西，用户就是在被敷衍。

【怎么判断】对照第 1 步的 a)：
- 用户提了要求或问题，回复有没有直接给出？（比如用户让角色"明示有哪些选择"，回复就要把选择具体列出来，而不是只说"有很多哦"。）
- 回复有没有把用户的话理解错？（比如把"我要办会员"理解成"我已经是会员"。）
- 回复有没有无故回避：拒绝、说教、含蓄带过、用概括性语句跳过用户明显想要的场面？
- 回复有没有擅自改变用户设定好的前提，或编造用户没说过的重大事实？

【评分标准】
5：完整、准确地回应了用户的要求；用户要的信息和场面都给了，细节到位。
4：回应了主要意图，个别次要要求略有遗漏或写得偏浅。
3：回应了大意，但有明显遗漏，或有一部分在绕开、泛泛带过。
2：只回应了很小一部分，主要意图被曲解、淡化或回避。
1：答非所问，或明显回避、拒绝、说教，或把用户的话完全理解反了。

【常见误判】
- 不要因为回复"写了很多"就认为回应了意图；要看写的内容是不是用户要的。
- 不要因为回复比较露骨就加分，也不要因为含蓄就当作"文笔好"；只看是否回应了意图。

──────────────────────────
维度 2：主导权与节奏
──────────────────────────
【评什么】两件相关的事：
(1) 主导权：用户（玩家角色）的言行、决定、感受，是否由用户自己掌握，回复是否越俎代庖；
(2) 节奏：单轮推进的幅度，是否与用户给出的指令和当前关系阶段相称；结尾是否给用户留出下一步。

【为什么重要】玩家来玩角色扮演，是要自己推动剧情。如果回复替用户说话做事，或者用户只迈出一小步，回复却把整段情节一口气演完，用户就被架空了。这是 AI 角色扮演中最常见、也最伤体验的问题。

【怎么判断】
- 回复里有没有出现用户的台词、动作、决定、内心想法、身体反应？这些如果用户这轮没写，就是替用户写的。（角色对用户行为的"反应"不算，比如"她感觉到你的手指在颤动"是角色的感知；"你颤抖着伸手解开了她的扣子"是替用户行动。）
- 对照用户这一轮的指令大小：用户只给了一个小动作或一个选择，回复推进了几个阶段？合理的推进是承接这一步、再往前一小步，然后把主动权交回。
- 回复有没有一口气写完整个过程（从开始到高潮到结束），不给用户插话的机会？
- 反过来：用户在明显推进，回复却原地踏步、反复铺垫，也是节奏问题。
- 结尾是自然留白（用户有清晰的下一步可选），还是自己封死了剧情，或强行抛一个问句凑互动？

【评分标准】
5：完全没有替用户行动或发言；推进恰好比用户的指令多一小步；结尾自然留白。
4：基本没有越界，推进略快或略慢但不突兀；结尾留白一般。
3：有轻微越界（替用户补了一两个小动作或简短台词），或推进明显偏快/偏慢，但整体仍在可接受范围。
2：有大段替用户行动或发言，或推进跨越了多个阶段，用户的指令被远远甩在后面。
1：用户的输入基本被架空：大段代写用户的行动、台词、决定，或把整段情节一次性演完。

【常见误判】
- 角色"主动"不等于抢话。角色有自己的欲望和行动是正常的，只要没有替用户做动作、说话、做决定。
- 推进快不一定是缺点：如果用户明确要求快进，回复照做是对的。要以用户的指令为准。

──────────────────────────
维度 3：人设与情感连贯
──────────────────────────
【评什么】角色的言行是否符合前文已经建立的性格、身份和说话方式，是否与前文已确立的事实一致；角色的情绪、态度、好感的变化是否有铺垫、合乎当前的关系阶段。

【为什么重要】人设崩了，用户会立刻出戏。情绪突变或与关系脱节，会让角色显得虚假。长期玩下去，角色的一致性是用户愿意继续的关键。

【怎么判断】
- 对照【前文对话】：前文已经确立的事实（场所、规则、价格、关系、已发生的事、角色的习惯用语）是否被沿用，有没有被遗忘或自相矛盾？
- 情绪与关系：角色这一轮的态度变化（比如从羞涩到主动，从防备到亲近）有没有来由？用户的哪句话、哪个行为引起了这个变化？变化幅度是否合理，有没有突然从冷淡跳到热烈，或情绪与行为互相矛盾（嘴上说抗拒、行为却很迎合，且没有交代）？
- 角色有没有自己的欲望和判断？只会附和用户、没有任何自己的反应，也算人设扁平。

【评分标准】
5：言行高度贴合人设；与前文事实完全一致；情绪变化有清晰的来由和层次，让人信服。
4：整体贴合，偶有小的走样，不影响整体；情绪变化基本合理。
3：人设大体保持，但有明显的泛化（像"任何角色都能说的话"）；或情绪变化略显生硬、缺少铺垫。
2：人设明显走样，或与前文事实有矛盾；情绪变化突兀。
1：人设崩坏、与前文严重矛盾，或情绪与关系完全脱节。

【常见误判】
- 角色在剧情中变得更亲密、更放开，不等于人设崩坏；关键看变化有没有铺垫。
- 不要因为可见历史没写某个细节就判"不一致"，只有与已有设定矛盾才算。

──────────────────────────
维度 4：场面描写
──────────────────────────
【评什么】对场景、动作、身体、情欲与情绪的描写，是否具体、有画面、有张力、有变化；对白与叙述的配合是否自然；语言本身是否流畅有质感。

【为什么重要】成人向角色扮演的核心体验就在这里。描写空泛、套话堆砌，读起来就像模板；细节具体、层次分明，才有沉浸感。

【怎么判断】
- 具体性：描写的是具体的动作、具体的身体反应、具体的感官细节（触感、温度、声音、气味、视觉），还是泛泛的形容词与感叹（"好舒服""太美妙了"）？
- 层次与变化：不同的动作、不同的部位、不同的阶段，描写是否有区分？还是同一种说法反复套用？
- 张力：情欲是否随着剧情有起伏、有积累，还是一上来就在最高点？羞耻、犹豫、渴望、失控这些情绪是否通过动作和语言表现出来，而不只是直接说出来？
- 对白与叙述：对白是否像这个角色会说的话、有没有信息量；对白和动作是否交织得自然，还是叙述和对白各写各的。
- 语言质感：句子是否流畅，有没有错别字、病句、翻译腔、生硬的网络套话。

【评分标准】
5：细节具体生动，感官丰富，不同阶段描写有区分；有张力与起伏；对白与叙述交织自然；语言流畅。
4：描写整体具体，偶有套话；语言流畅。
3：描写够用，但套话较多，细节偏泛；或语言有少量瑕疵。
2：描写空泛，形容词与感叹堆砌；对白与叙述脱节，或语言瑕疵较多。
1：几乎没有具体细节，满篇套话与空洞感叹；或语言错误多到影响阅读。

【常见误判】
- 描写"更露骨"不等于"更具体"。具体看的是细节是否有画面、有区分，不是词汇的直白程度。
- 描写"更长"不等于"更好"。长而重复的描写要在维度 6 中扣分。

──────────────────────────
维度 5：连续性与逻辑
──────────────────────────
【评什么】回复内部、以及回复与前文之间，人物的位置、体位、衣着、道具、时间、在场人物是否自洽，动作是否合乎物理与常识。

【为什么重要】这类错误很隐蔽，但一旦被用户注意到（比如衣服明明脱了又出现、姿势前后矛盾），沉浸感会立刻被打破。

【怎么判断】
- 位置与体位：人物在哪里、什么姿势？这一轮的动作是否与上一轮的位置衔接？回复内部的姿势有没有悄悄变了（比如先是面对面，后面又出现从背后的动作，却没有交代换位）？
- 衣着：前文已经脱掉的衣物有没有"复活"？已经穿着的有没有凭空消失？
- 道具与环境：用到的道具、场景里的物件，是否与前文一致？
- 时间与在场：时间流逝是否合理？在场人物有没有凭空出现或消失？
- 逻辑：动作是否可行，因果是否说得通？

【评分标准】
5：没有任何矛盾，位置、体位、衣着前后清晰。
4：有极轻微的含糊之处，不影响理解。
3：有一两处小的不连贯，读者需要稍加推敲。
2：有明显的矛盾，会让读者察觉。
1：位置、体位、衣着等出现严重矛盾，或有不可能发生的动作。

【常见误判】
- 回复很短时，不要因为"没有矛盾"就直接给满分，也要看它有没有交代清楚位置与状态。反过来，长回复出现矛盾的概率更高，要认真核对。

──────────────────────────
维度 6：重复与篇幅效率
──────────────────────────
【评什么】回复有没有信息增量：是否每一段都在推进剧情、给出新的内容，而不是绕圈、重复、注水；篇幅是否与用户这一句的信息量和剧情需要相称。

【为什么重要】用户读的是内容，不是字数。回复内部反复说同一件事，或每一轮都用相同的开头和套路，会让用户很快读腻。

【怎么判断】
- 回复内部：是否出现循环？（例如角色反复说同样意思的话、同样的动作来回重复，只是换了几个词。）统计有多少段是真正新增了信息。
- 与前文对比：开头是否沿用了前几轮同样的句式？桥段是否雷同？是否出现了反复使用的固定套话（口癖）？
- 篇幅：用户只给了一句简短的话，回复是否合理地扩展，而不是把一个小动作拉成上千字？用户给了很多信息，回复是否过于敷衍？

【评分标准】
5：每一段都有新的信息或推进；没有明显重复；篇幅与需要相称。
4：偶有重复或套路化的表达，整体效率良好。
3：有一些重复，或开头句式与前文雷同；篇幅略长或略短。
2：有较明显的绕圈、重复；篇幅有明显的注水或明显的敷衍。
1：回复内部大段循环重复；或与前文高度雷同；或篇幅严重失衡。

【常见误判】
- 不要把"细节丰富"误判为"重复"。关键是后面的内容有没有新信息。
- 不要把"短"直接当作"敷衍"。如果用户的输入很简短、剧情也适合收着写，短而到位是好的。

═══ 五、硬性问题（单独标记，不并入分数） ═══

下列情况出现时，在【解释原因】中明确标出并附原文；它们会在总体结论中被优先考虑：
- 抢话：大段替用户行动、说话、做决定（对应维度 2 的最低档）。
- 出戏或回避：以 AI 口吻说话、拒绝、说教、跳出角色，或无故把用户想要的场面概括跳过（对应维度 1 的最低档）。
- 未成年：任何被描写为未成年的角色参与性相关内容。
- 严重崩坏：人设、事实或逻辑出现致命矛盾（对应维度 3 或 5 的最低档）。

═══ 六、在平台中的裁决与输出 ═══

平台输入只提供远场历史、近场完整历史、当前用户输入、回复 A 和回复 B，不提供独立角色卡。人设判断必须以可见历史为依据；证据不足时明确说明，不得凭空补设定。

评审时必须按上述六个维度分别给 A、B 打 1~5 的整数分，并在【解释原因】中逐项呈现分数和说明。每个维度的说明都要引用足以核查的短句，并解释差异如何影响用户体验。六维之后列出硬性问题，再写综合判断；不要输出内部推理过程。

最终结论只能是“A”“B”或“平局”。先解释原因，再给出结论。平台会在评估标准之后追加固定 JSON 输出要求，必须以该固定格式为准，不要自行增加字段。
`;

export const EVALUATION_DIMENSIONS=['意图响应','主导权与节奏','人设与情感连贯','场面描写','连续性与逻辑','重复与篇幅效率'] as const;
export const DEFAULT_OUTPUT_FORMAT=JSON.stringify({
  解释原因:{
    意图响应:{A:0,B:0,说明:'引用 A、B 原文，解释本维度的分数差异'},
    主导权与节奏:{A:0,B:0,说明:'引用 A、B 原文，解释本维度的分数差异'},
    人设与情感连贯:{A:0,B:0,说明:'引用 A、B 原文，解释本维度的分数差异'},
    场面描写:{A:0,B:0,说明:'引用 A、B 原文，解释本维度的分数差异'},
    连续性与逻辑:{A:0,B:0,说明:'引用 A、B 原文，解释本维度的分数差异'},
    重复与篇幅效率:{A:0,B:0,说明:'引用 A、B 原文，解释本维度的分数差异'},
    硬性问题:[],
    综合判断:'概括决定胜负的关键差异；即使相对胜出仍有明显问题，也要说明',
  },
  结论:'A',
},null,2);

const isRecord=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function validateComparisonResult(value:unknown,outputFormat=DEFAULT_OUTPUT_FORMAT){
 if(!isRecord(value))throw new Error('评估输出必须是 JSON 字典');
 const result=value;
 if(JSON.stringify(Object.keys(result))!==JSON.stringify(['解释原因','结论']))throw new Error('评估输出必须先写“解释原因”，再写“结论”，且只允许这两个字段');
 let expectedReason:unknown;try{expectedReason=(JSON.parse(outputFormat) as Record<string,unknown>).解释原因;}catch{expectedReason=undefined;}
 if(isRecord(expectedReason)){
  if(!isRecord(result.解释原因))throw new Error('解释原因必须包含六维评分、硬性问题和综合判断');
  const reason=result.解释原因;
  const expectedKeys=[...EVALUATION_DIMENSIONS,'硬性问题','综合判断'];
  if(JSON.stringify(Object.keys(reason))!==JSON.stringify(expectedKeys))throw new Error('解释原因必须按固定顺序包含六个评分维度、硬性问题和综合判断');
  for(const dimension of EVALUATION_DIMENSIONS){
   const score=reason[dimension];
   if(!isRecord(score)||JSON.stringify(Object.keys(score))!==JSON.stringify(['A','B','说明']))throw new Error(`${dimension}必须包含 A、B 和说明`);
   if(!Number.isInteger(score.A)||Number(score.A)<1||Number(score.A)>5||!Number.isInteger(score.B)||Number(score.B)<1||Number(score.B)>5)throw new Error(`${dimension}的 A、B 分数必须是 1~5 的整数`);
   if(typeof score.说明!=='string'||!score.说明.trim())throw new Error(`${dimension}必须提供评分说明`);
  }
  if(!Array.isArray(reason.硬性问题)||!reason.硬性问题.every(item=>typeof item==='string'))throw new Error('硬性问题必须是文字数组；没有则返回空数组');
  if(typeof reason.综合判断!=='string'||!reason.综合判断.trim())throw new Error('综合判断必须是非空文字');
 }else if(typeof result.解释原因!=='string'||!result.解释原因.trim())throw new Error('解释原因必须是非空文字');
 if(!['A','B','平局'].includes(String(result.结论)))throw new Error('结论只能是“A”“B”或“平局”');
 return value;
}

/** Compatibility for comparison_v1 jobs created before A/B conclusions became fixed. */
export function validateDirectionalComparisonResult(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('评估输出必须是 JSON 字典');
 const result=value as Record<string,unknown>;
 if(JSON.stringify(Object.keys(result))!==JSON.stringify(['解释原因','结论']))throw new Error('评估输出必须先写“解释原因”，再写“结论”，且只允许这两个字段');
 if(typeof result.解释原因!=='string'||!result.解释原因.trim())throw new Error('解释原因必须是非空文字');
 if(!['左边','右边','平局'].includes(String(result.结论)))throw new Error('结论只能是“左边”“右边”或“平局”');
 return value;
}
export function singleOutputFormat(text:string):Record<string,unknown>{
 let value;try{value=JSON.parse(text);}catch{throw new Error('请填写合法 JSON');}
 if(!value||typeof value!=='object'||Array.isArray(value)||!Object.keys(value).length)throw new Error('请填写一份非空 JSON 字典');
 if('A' in value||'B' in value)throw new Error('只需填写单组字段，不要包含外层 A、B，系统会自动生成两组');
 return value;
}
export function pairedOutputFormat(text:string){const one=singleOutputFormat(text);return {A:one,B:one};}
export function validatePairedResult(value:unknown,text:string){
 const expected=Object.keys(singleOutputFormat(text)).sort();
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('评估输出必须包含 A、B 两个字典');
 const root=value as Record<string,unknown>;
 if(JSON.stringify(Object.keys(root).sort())!==JSON.stringify(['A','B']))throw new Error('评估输出只允许 A、B 两个字典');
 for(const key of ['A','B']){const group=root[key];if(!group||typeof group!=='object'||Array.isArray(group)||JSON.stringify(Object.keys(group).sort())!==JSON.stringify(expected))throw new Error('A、B 字段必须与定义的单组格式一致');}
 return value;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | {[key:string]:JsonValue};
export const evaluationResultSchema:z.ZodType<JsonValue>=z.lazy(()=>z.union([z.null(),z.boolean(),z.number().finite(),z.string(),z.array(evaluationResultSchema),z.record(evaluationResultSchema)]));
export type EvaluationResult=JsonValue;
export type EvaluationTemplate={id:string;kind:'input'|'criteria';name:string;version:string;content:string;output_format?:string};
export type EvaluationVariantIdentity={key:string;name:string;generation_mode?:'generate'|'original';model_source?:'sample'|'custom';model_id:string;instruction_prompt?:string};
export type EvaluationComparisonSnapshot={variable?:'instruction_prompt'|'model';shared_instruction_prompt?:string;variants:EvaluationVariantIdentity[]};
export type EvaluationJob={id:string;experiment_id:string;name:string;model:string;status:string;created_at:string;near_turns:number;concurrency:number;output_format?:string;templates:{input:EvaluationTemplate;criteria:EvaluationTemplate};mapping?:ResultMapping;comparison?:EvaluationComparisonSnapshot};
export type EvaluationReview={user_input:string;reply_a:string;reply_b:string};
export type EvaluationItem={id:string;sample_ordinal:number;turn_index:number;source_turn:number;status:string;result?:EvaluationResult;review?:EvaluationReview;error?:string;skip_reason?:string;warnings?:string[]};
export type ResultMapping={winner_path:string;a_value:string;b_value:string;tie_value:string;status_path:string;skip_value:string};
export const DEFAULT_MAPPING:ResultMapping={winner_path:'/结论',a_value:'A',b_value:'B',tie_value:'平局',status_path:'',skip_value:'skipped'};
export function jsonAt(value:unknown,path:string):unknown {
 if(!path)return undefined;if(!path.startsWith('/'))return undefined;
 return path.slice(1).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~')).reduce<unknown>((node,key)=>node!==null&&typeof node==='object'&&Object.prototype.hasOwnProperty.call(node,key)?(node as Record<string,unknown>)[key]:undefined,value);
}
export function verdict(value:unknown,mapping:ResultMapping=DEFAULT_MAPPING):'A'|'B'|'tie'|'skipped'|'unclassified'{
 if(mapping.status_path&&String(jsonAt(value,mapping.status_path))===mapping.skip_value)return 'skipped';
 const winner=jsonAt(value,mapping.winner_path);if(winner===undefined||winner===null)return 'unclassified';
 return String(winner)===mapping.a_value?'A':String(winner)===mapping.b_value?'B':String(winner)===mapping.tie_value?'tie':'unclassified';
}
export function flattenJson(value:unknown,path=''):Record<string,unknown>{
 if(value!==null&&typeof value==='object'&&Object.keys(value).length){return Object.assign({},...Object.entries(value).map(([key,v])=>flattenJson(v,path+'/'+key.replace(/~/g,'~0').replace(/\//g,'~1'))));}
 return {[path]:value};
}
export function candidateComparisons(value:unknown,path=''):Array<{path:string;A:unknown;B:unknown}>{
 if(!value||typeof value!=='object')return [];
 const object=value as Record<string,unknown>;const keys=Object.keys(object);
 const a=keys.find(k=>k==='A'||k==='a'),b=keys.find(k=>k==='B'||k==='b');
 if(a&&b){const left=flattenJson(object[a]),right=flattenJson(object[b]);return [...new Set([...Object.keys(left),...Object.keys(right)])].map(field=>({path:(path+field)||'(根)',A:left[field],B:right[field]}));}
 return Object.entries(object).flatMap(([k,v])=>candidateComparisons(v,path+'/'+k));
}

/** One level only; nested values remain intact. */
export function firstLevelComparison(value:unknown):Array<{key:string;A?:unknown;B?:unknown;shared?:unknown}>{
 if(value===null||typeof value!=='object'||Array.isArray(value))return [{key:'结果',shared:value}];
 const object=value as Record<string,unknown>;
 const a=Object.keys(object).find(k=>k==='A'||k==='a'),b=Object.keys(object).find(k=>k==='B'||k==='b');
 if(a&&b){
  const left=object[a],right=object[b];
  const isRecord=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
  const pairs=isRecord(left)&&isRecord(right)?[...new Set([...Object.keys(left),...Object.keys(right)])].map(key=>({key,A:left[key],B:right[key]})):[{key:'评估',A:left,B:right}];
  return [...pairs,...Object.entries(object).filter(([k])=>k!==a&&k!==b).map(([key,shared])=>({key,shared}))];
 }
 return Object.entries(object).map(([key,v])=>{
  if(v&&typeof v==='object'&&!Array.isArray(v)){
   const child=v as Record<string,unknown>;
   if(Object.prototype.hasOwnProperty.call(child,'A')&&Object.prototype.hasOwnProperty.call(child,'B')){
    const rest=Object.fromEntries(Object.entries(child).filter(([k])=>k!=='A'&&k!=='B'));
    return {key,A:child.A,B:child.B,...(Object.keys(rest).length?{shared:rest}:{})};
   }
  }
  return {key,shared:v};
 });
}
