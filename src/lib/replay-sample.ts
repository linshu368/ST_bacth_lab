import type { BatchLabPreviewItem } from './batch-lab-contracts.js';
import { pureUserInput } from './instruction-prompt.js';

/** Derive an experiment view without changing the immutable source snapshot. */
export function excludeLastTurn<T extends { history: Array<{ role: string; content: string }>; user_input: string; turn_index?: number; original_assistant_reply?: string | null; original_model?: string; turn_models?: BatchLabPreviewItem['turn_models'] }>(sample: T): T {
  const history = sample.history.map(message => ({ ...message }));
  const last = history.at(-1);
  if (last?.role !== 'user' || pureUserInput(last.content).trim() !== pureUserInput(sample.user_input).trim()) {
    history.push({ role: 'user', content: sample.user_input });
  }
  const users = history.flatMap((message, index) => message.role === 'user' ? [index] : []);
  if (users.length < 2) throw new Error('排除最后一轮后没有可用的用户对话');
  const previous = users[users.length - 2];
  const reply = history.slice(previous + 1, users[users.length - 1])
    .filter(message => message.role === 'assistant').map(message => message.content).join('\n\n');
  const turn_models = sample.turn_models?.filter(turn => turn.user_message_index <= previous);
  const model = turn_models?.at(-1);
  return { ...sample, ...(turn_models ? { turn_models, original_model: model?.model ?? sample.original_model } : {}), history: history.slice(0, previous + 1), user_input: pureUserInput(history[previous].content),
    original_assistant_reply: reply || null, turn_index: model?.turn_index ?? Math.max(1, (sample.turn_index ?? users.length) - 1) };
}
