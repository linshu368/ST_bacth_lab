import { pureUserInput } from '../src/lib/instruction-prompt.js';
import type { BatchLabPreviewItem } from '../src/lib/batch-lab-contracts.js';

type Row = Record<string, any>;
const key = (row: Row, input: string, reply: string) => JSON.stringify([
  row.session_id ?? row.source_session_id, row.user_id ?? row.source_user_id,
  row.character_id ?? row.source_character_id, pureUserInput(input).trim(), reply,
]);

export function turnModelIndex(rows: Row[]) {
  const index = new Map<string, Row[]>();
  for (const row of rows) {
    if (!row.model || row.model === 'unknown' || typeof row.user_input !== 'string' || (row.assistant_reply != null && typeof row.assistant_reply !== 'string')) continue;
    const identity = key(row, row.user_input, row.assistant_reply ?? '');
    index.set(identity, [...(index.get(identity) ?? []), row]);
  }
  return index;
}

export function attachTurnModels(sample: BatchLabPreviewItem, index: ReturnType<typeof turnModelIndex>): BatchLabPreviewItem {
  const users = sample.history.flatMap((message, i) => message.role === 'user' ? [i] : []);
  if (!users.length || pureUserInput(sample.history[users.at(-1)!].content).trim() !== pureUserInput(sample.user_input).trim()) {
    throw new Error('样本历史未包含当前用户输入，不能完整关联轮次');
  }
  const turn_models = users.map((userIndex, position) => {
    const assistantIndices = sample.history.flatMap((message, i) => i > userIndex && i < (users[position + 1] ?? sample.history.length) && message.role === 'assistant' ? [i] : []);
    const reply = position === users.length - 1 ? sample.original_assistant_reply : assistantIndices.map(i => sample.history[i].content).join('\n\n');
    if (position < users.length - 1 && !assistantIndices.length) throw new Error('历史轮次缺少角色回复');
    const expectedTurn = sample.turn_index - users.length + position + 1;
    const candidates = (index.get(key(sample, sample.history[userIndex].content, reply ?? '')) ?? [])
      .filter(row => Number(row.turn_index) === expectedTurn && (position !== users.length - 1 || row.id === sample.source_history_id));
    if (!candidates.length || new Set(candidates.map(row => row.model)).size !== 1) {
      throw new Error(`第 ${expectedTurn} 轮缺少唯一可核实的模型记录`);
    }
    const row = candidates.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
    return { turn_index: Number(row.turn_index), user_message_index: userIndex, assistant_message_indices: assistantIndices,
      source_history_id: row.id, model: row.model, llm_model: row.llm_model || null };
  });
  return { ...sample, turn_models };
}
