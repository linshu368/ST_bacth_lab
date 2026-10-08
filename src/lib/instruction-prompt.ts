/** Separate the online instruction wrapper from the user's actual words. */
export function pureUserInput(content: string): string {
  if (!/^\s*\\?##\s*系统指令[：:]/u.test(content)) return content;
  const markers = [...content.matchAll(/(?:^|\r?\n)[ \t]*\\?##[ \t]*用户指令[：:](?:\r?\n)?/gu)];
  const marker = markers.at(-1);
  return marker ? content.slice(marker.index! + marker[0].length).replace(/\r?\n$/u, '') : content;
}

export function withInstructionPrompt(input: string, instruction?: string): string {
  const prompt = instruction?.trimEnd();
  if (!prompt) return input;
  const separator = /\\?##\s*用户指令[：:]\s*$/u.test(prompt) ? '\n' : '\n\n##用户指令:\n';
  return `${prompt}${separator}${input}`;
}
