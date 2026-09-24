import { createHash, randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import {
  batchLabCreateProcessorVersionRequestSchema,
  batchLabProcessorPreviewRequestSchema,
  BATCH_LAB_MAX_PROCESSOR_INPUT_CHARS,
  BATCH_LAB_MAX_PROCESSOR_OUTPUT_CHARS,
  type BatchLabProcessorConfig,
  type BatchLabProcessorVersion,
  type BatchLabDisplayResult,
} from '../src/lib/batch-lab-contracts.js';
import { query } from './db.js';

export function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => (value as any)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stableJson((value as any)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function operationId(operation: string, key?: string): string {
  if (!key) return randomUUID();
  const hex = createHash('sha256').update(`${operation}:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function serviceError(code: string, message: string, status = 400): Error {
  return Object.assign(new Error(message), { code, status });
}

const DEFAULT_PROCESSORS: Array<{ id: string; name: string; config: BatchLabProcessorConfig }> = [
  { id: '9d8abfa1-4e64-5bb1-a001-000000000001', name: '保留原文', config: { protocol: 'none_v1' } },
  { id: '9d8abfa1-4e64-5bb1-a001-000000000002', name: '状态栏与记忆块', config: { protocol: 'regex_json_v1', rules: [], timeout_ms: 250 } },
];

export async function ensureDefaultProcessors(): Promise<void> {
  for (const item of DEFAULT_PROCESSORS) {
    const data = { ...item, protocol: item.config.protocol, digest: digest(item.config), created_at: new Date().toISOString() };
    await query(`INSERT INTO lab_records(kind,id,data) VALUES ('processor',$1,$2::jsonb) ON CONFLICT DO NOTHING`, [item.id, JSON.stringify(data)]);
  }
}

export async function getProcessor(id: string): Promise<BatchLabProcessorVersion> {
  const rows = await query<{ data: BatchLabProcessorVersion }>(`SELECT data FROM lab_records WHERE kind='processor' AND id=$1`, [id]);
  if (!rows[0]) throw serviceError('BATCH_LAB_PROCESSOR_NOT_FOUND', '后处理版本不存在', 404);
  return rows[0].data;
}

export async function processorOperation(op: string, input: any = {}): Promise<unknown> {
  if (op === 'listBatchLabProcessors') {
    return (await query<{ data: BatchLabProcessorVersion }>(`SELECT data FROM lab_records WHERE kind='processor' ORDER BY created_at DESC,id`)).map(row => row.data);
  }
  if (op === 'createBatchLabProcessor') {
    const parsed = batchLabCreateProcessorVersionRequestSchema.strip().parse(input);
    if (parsed.config.protocol === 'regex_json_v1') {
      for (const rule of parsed.config.rules) {
        try { new RegExp(rule.pattern, rule.flags); } catch {
          throw serviceError('BATCH_LAB_PROCESSOR_VALIDATION_ERROR', '后处理规则包含无效正则');
        }
      }
    }
    const requestDigest = digest({ name: parsed.name, config: parsed.config });
    const data = {
      id: operationId(op, parsed.idempotency_key), name: parsed.name, protocol: parsed.config.protocol,
      config: parsed.config, digest: digest(parsed.config), created_at: new Date().toISOString(),
      request_digest: requestDigest,
    };
    const rows = await query<{ data: typeof data }>(
      `INSERT INTO lab_records(kind,id,data) VALUES ('processor',$1,$2::jsonb)
       ON CONFLICT(kind,id) DO UPDATE SET id=lab_records.id RETURNING data`,
      [data.id, JSON.stringify(data)],
    );
    if (rows[0].data.request_digest !== requestDigest) throw serviceError('BATCH_LAB_IDEMPOTENCY_CONFLICT', '相同请求标识已用于不同内容', 409);
    return rows[0].data;
  }
  if (op === 'previewBatchLabProcessor') {
    // Preserve the schema's exactly-one-of validation while allowing future RPC fields.
    const parsed = batchLabProcessorPreviewRequestSchema.parse({
      ...(input.processor_version_id === undefined ? {} : { processor_version_id: input.processor_version_id }),
      ...(input.config === undefined ? {} : { config: input.config }), input_text: input.input_text,
    });
    const processor = parsed.processor_version_id
      ? await getProcessor(parsed.processor_version_id)
      : { id: randomUUID(), config: parsed.config!, digest: digest(parsed.config) };
    return runPostprocessor(processor, parsed.input_text);
  }
  throw serviceError('BATCH_LAB_OPERATION_NOT_FOUND', '未知后处理操作', 404);
}

type ProcessorInput = Pick<BatchLabProcessorVersion, 'id' | 'digest' | 'config'>;

export async function runPostprocessor(processor: ProcessorInput, inputText: string): Promise<BatchLabDisplayResult> {
  if (inputText.length > BATCH_LAB_MAX_PROCESSOR_INPUT_CHARS) {
    return processorFailure(processor, inputText, 'limit_exceeded', 'BATCH_LAB_PROCESSOR_LIMIT_EXCEEDED');
  }
  let output = inputText;
  let matchCount = 0;
  try {
    if (processor.config.protocol === 'regex_json_v1' && processor.config.rules.length) {
      // Only the fixed program below executes; rule strings are data. The VM deadline
      // also interrupts catastrophic regex backtracking, unlike a Promise timeout.
      const result = runInNewContext(`
        let output = input;
        let matches = 0;
        for (const rule of rules) {
          const flags = rule.flags || 'g';
          const counter = new RegExp(rule.pattern, flags.includes('g') ? flags : flags + 'g');
          for (const unused of output.matchAll(counter)) matches++;
          output = output.replace(new RegExp(rule.pattern, flags), rule.replacement);
          if (output.length > maxOutput) throw new Error('OUTPUT_LIMIT');
        }
        ({ output, matches });
      `, { input: inputText, rules: processor.config.rules, maxOutput: BATCH_LAB_MAX_PROCESSOR_OUTPUT_CHARS },
      { timeout: processor.config.timeout_ms, contextCodeGeneration: { strings: false, wasm: false } });
      output = result.output;
      matchCount = result.matches;
    }
  } catch (error: any) {
    const timeout = error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
    const limit = error?.message === 'OUTPUT_LIMIT';
    return processorFailure(processor, inputText, timeout ? 'timeout' : limit ? 'limit_exceeded' : 'failed',
      timeout ? 'BATCH_LAB_PROCESSOR_TIMEOUT' : limit ? 'BATCH_LAB_PROCESSOR_LIMIT_EXCEEDED' : 'BATCH_LAB_PROCESSOR_RUNTIME_ERROR');
  }
  return {
    id: randomUUID(), processor_version_id: processor.id, processor_digest: processor.digest,
    status: 'success', match_count: matchCount, input_text: inputText, output_text: output,
    sanitized_html: renderSafeHtml(output), error_code: null,
    renderer: { protocol: 'batch_lab_html_v1', version: 1 }, created_at: new Date().toISOString(),
  };
}

function processorFailure(processor: ProcessorInput, input: string, status: BatchLabDisplayResult['status'], code: BatchLabDisplayResult['error_code']): BatchLabDisplayResult {
  const text = input.slice(0, BATCH_LAB_MAX_PROCESSOR_INPUT_CHARS);
  return {
    id: randomUUID(), processor_version_id: processor.id, processor_digest: processor.digest,
    status, match_count: 0, input_text: text, output_text: text, sanitized_html: renderSafeHtml(text), error_code: code,
    renderer: { protocol: 'batch_lab_html_v1', version: 1 }, created_at: new Date().toISOString(),
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function renderLines(text: string): string { return escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>'); }
function renderParagraphs(text: string): string {
  return text.split(/\n{2,}/).map(part => part.trim()).filter(Boolean).map(part => `<p>${renderLines(part)}</p>`).join('');
}
export function renderSafeHtml(text: string): string {
  const statuses: string[] = [], memories: string[] = [];
  const body = text.replace(/\[status\]([\s\S]*?)\[\/status\]/gi, (_, content: string) => { statuses.push(content.trim()); return '\n'; })
    .replace(/\[memory\]([\s\S]*?)\[\/memory\]/gi, (_, content: string) => { memories.push(content.trim()); return '\n'; }).trim();
  return `<div class="batch-lab-message-render">${body ? `<div class="batch-lab-message-text">${renderParagraphs(body)}</div>` : ''}${
    statuses.filter(Boolean).map(value => `<section class="batch-lab-status-block"><strong>当前状态</strong>${renderLines(value)}</section>`).join('')
  }${memories.filter(Boolean).map(value => `<details class="batch-lab-memory-block"><summary>记忆</summary><div>${renderParagraphs(value)}</div></details>`).join('')}</div>`;
}
