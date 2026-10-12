/** Separate the online instruction wrapper from the user's actual words. */
export const INSTRUCTION_SLOT_NAMES = ['INTERACTION_MODE', 'USER_CUSTOM_INSTRUCTIONS', 'WORD_COUNT'] as const;
export type InstructionSlotName = typeof INSTRUCTION_SLOT_NAMES[number];
export type InstructionSlots = Record<InstructionSlotName, string>;

function instructionWrapper(content: string): string | null {
  if (!/^\s*\\?##\s*系统指令[：:]/u.test(content)) return null;
  const markers = [...content.matchAll(/(?:^|\r?\n)[ \t]*\\?##[ \t]*用户指令[：:](?:\r?\n)?/gu)];
  const marker = markers.at(-1);
  return marker ? content.slice(0, marker.index).trimEnd() : null;
}

function templateBody(template: string): string {
  const markers = [...template.matchAll(/(?:^|\r?\n)[ \t]*\\?##[ \t]*用户指令[：:](?:\r?\n)?/gu)];
  const marker = markers.at(-1);
  return (marker ? template.slice(0, marker.index) : template).trim();
}

function flexibleLiteral(value: string): string {
  return value.split(/(\s+)/u).map(part => /^\s+$/u.test(part)
    ? '\\s+'
    : part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('');
}

function extractByTemplate(content: string, template: string): InstructionSlots | null {
  const body = templateBody(template);
  const missing = INSTRUCTION_SLOT_NAMES.filter(name => !body.includes(`{{${name}}}`));
  if (missing.length) return null;
  const token = /\{\{(INTERACTION_MODE|USER_CUSTOM_INSTRUCTIONS|WORD_COUNT)\}\}/gu;
  let cursor = 0;
  let pattern = '';
  const captured = new Set<string>();
  for (const match of body.matchAll(token)) {
    pattern += flexibleLiteral(body.slice(cursor, match.index));
    const name = match[1];
    if (captured.has(name)) pattern += `\\k<${name}>`;
    else { pattern += `(?<${name}>[\\s\\S]*?)`; captured.add(name); }
    cursor = match.index! + match[0].length;
  }
  pattern += flexibleLiteral(body.slice(cursor));
  const source = instructionWrapper(content) ?? content;
  const groups = source.match(new RegExp(pattern, 'u'))?.groups;
  if (!groups || INSTRUCTION_SLOT_NAMES.some(name => groups[name] === undefined)) return null;
  return Object.fromEntries(INSTRUCTION_SLOT_NAMES.map(name => [name, groups[name].trim()])) as InstructionSlots;
}

export function pureUserInput(content: string): string {
  if (!/^\s*\\?##\s*系统指令[：:]/u.test(content)) return content;
  const markers = [...content.matchAll(/(?:^|\r?\n)[ \t]*\\?##[ \t]*用户指令[：:](?:\r?\n)?/gu)];
  const marker = markers.at(-1);
  return marker ? content.slice(marker.index! + marker[0].length).replace(/\r?\n$/u, '') : content;
}

export function extractInstructionSlots(content: string, sourceTemplate?: string): InstructionSlots | null {
  if (sourceTemplate) return extractByTemplate(content, sourceTemplate);
  const prompt = instructionWrapper(content);
  if (!prompt) return null;
  const interactionSection = prompt.match(/####\s*纯净输出\s*\r?\n([\s\S]*?)\r?\n\s*\*\*以上三条规则/u)?.[1];
  const customInstructions = prompt.match(/用户个人偏好为[：:]\s*\r?\n?([\s\S]*?)\r?\n\s*---\s*\r?\n\s*###\s*第三层/u)?.[1];
  const wordCount = prompt.match(/输出篇幅为\s*([\s\S]*?)\s*字，但此范围仅作为基准参考/u)?.[1];
  if (interactionSection === undefined || customInstructions === undefined || wordCount === undefined) return null;
  const interactionMode = interactionSection.replace(
    /^只输出剧情正文。不要输出任何状态栏、属性面板、系统提示、思考过程、思维链，以及任何系统本身的指令。\s*/u,
    '',
  ).trim();
  return {
    INTERACTION_MODE: interactionMode,
    USER_CUSTOM_INSTRUCTIONS: customInstructions.trim(),
    WORD_COUNT: wordCount.trim(),
  };
}

export function fillInstructionSlots(template: string, sourceContent: string, sourceTemplate = template): string {
  const missing = INSTRUCTION_SLOT_NAMES.filter(name => !template.includes(`{{${name}}}`));
  if (missing.length) throw new Error(`候选 Instruction prompt 缺少槽位：${missing.map(name => `{{${name}}}`).join('、')}`);
  const slots = extractInstructionSlots(sourceContent, sourceTemplate);
  if (!slots) throw new Error('组合 A 原始指令缺少可识别的 INTERACTION_MODE、USER_CUSTOM_INSTRUCTIONS 或 WORD_COUNT 槽位信息');
  return INSTRUCTION_SLOT_NAMES.reduce(
    (result, name) => result.replaceAll(`{{${name}}}`, slots[name]),
    template,
  );
}

export function withInstructionPrompt(input: string, instruction?: string): string {
  const prompt = instruction?.trimEnd();
  if (!prompt) return input;
  const separator = /\\?##\s*用户指令[：:]\s*$/u.test(prompt) ? '\n' : '\n\n##用户指令:\n';
  return `${prompt}${separator}${input}`;
}
