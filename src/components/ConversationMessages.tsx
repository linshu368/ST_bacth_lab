import type { BatchLabPreviewItem } from '../lib/batch-lab-contracts';
import { pureUserInput } from '../lib/instruction-prompt';
import { Fragment } from 'react';

type Message = { role: string; content: string };

export function ConversationMessages({ messages, startTurn = 1, turnModels }: { messages: Message[]; startTurn?: number; turnModels?: BatchLabPreviewItem['turn_models'] }) {
  let turn = startTurn - 1;
  let hasDialogue = false;
  return <div className="conversation-messages" aria-label="按角色区分的对话">
    {messages.map((message, index) => {
      if (message.role === 'system') return <details className="conversation-system" key={index}>
        <summary>System prompt · 系统指令</summary>
        <div className="conversation-content">{message.content}</div>
      </details>;
      const isUser = message.role === 'user';
      const showHeading = isUser || !hasDialogue;
      hasDialogue = true;
      if (isUser) turn++;
      const model = turnModels?.find(item => item.user_message_index === index || item.assistant_message_indices.includes(index));
      const turnLabel = model ? `第 ${model.turn_index} 轮` : messages.length === 1 ? `第 ${startTurn} 轮` : turn >= startTurn ? `第 ${turn} 轮` : '角色开场';
      const content = isUser ? pureUserInput(message.content) : message.content;
      const wrapped = isUser && content !== message.content;
      const marker = wrapped ? [...message.content.matchAll(/(?:^|\r?\n)[ \t]*\\?##[ \t]*用户指令[：:]/gu)].at(-1) : undefined;
      const instruction = marker ? message.content.slice(0, marker.index! + marker[0].length) : null;
      return <Fragment key={index}>
        {showHeading ? <h4 className="conversation-turn-heading">{turnLabel}{model ? ` · ${model.model}` : ''}</h4> : null}
        <article className={`conversation-message ${isUser ? 'conversation-user' : 'conversation-character'}`}>
        <div className="conversation-label">
          <strong>{isUser ? 'USER · 用户' : message.role === 'assistant' ? 'ASSISTANT · 角色' : message.role}</strong>
          <span>{turnLabel}</span>
        </div>
        {instruction ? <details className="conversation-instruction">
          <summary>Instruction prompt · 本轮前置指令</summary>
          <div className="conversation-content">{instruction}</div>
        </details> : null}
        <div className="conversation-content">{content}</div>
      </article></Fragment>;
    })}
  </div>;
}
