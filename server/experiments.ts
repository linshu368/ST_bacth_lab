import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  batchLabCreateExperimentRequestSchema,
  batchLabCopyExperimentRequestSchema,
  batchLabReuseDisplayExperimentRequestSchema,
  batchLabStartExperimentRequestSchema,
  batchLabStopExperimentRequestSchema,
  batchLabDeleteExperimentRequestSchema,
  batchLabRunWorkerRequestSchema,
  batchLabRunExperimentWorkerRequestSchema,
  batchLabUpsertAnnotationRequestSchema,
  BATCH_LAB_JSONL_SCHEMA_VERSION,
  type BatchLabExperimentVariant,
  type BatchLabOutputPreset,
} from '../src/lib/batch-lab-contracts.js';
import { query, transaction } from './db.js';
import { digest, operationId, runPostprocessor, renderSafeHtml, serviceError } from './processors.js';

type Row = Record<string, any>;
type Message = { role: 'system' | 'user' | 'assistant'; content: string };
export type ExperimentDependencies = {
  query: typeof query;
  transaction?: typeof transaction;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
};
const uuid = z.string().uuid();
const MAX_BATCH = 4;
const PAGE_SIZE = 5;
const RESULT_BYTE_BUDGET = 3 * 1024 * 1024;

function byteLength(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // Never leave a partial surrogate pair at the truncation boundary.
  if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low--;
  return text.slice(0, low) + '\n…（页面预览已截断，完整内容保留在导出数据中）';
}

function visibleAttempt(row: Row): Row {
  const data = attemptData(row);
  delete data.input_messages;
  delete data.request_sampling;
  delete data.response_metadata;
  let truncated = false;
  const shorten = (text: string) => {
    const result = truncateUtf8(text, 16 * 1024); truncated ||= result !== text; return result;
  };
  if (typeof data.raw_output === 'string') data.raw_output = shorten(data.raw_output);
  if (data.display_result) {
    const display = { ...data.display_result };
    display.input_text = shorten(display.input_text ?? '');
    display.output_text = shorten(display.output_text ?? '');
    if (byteLength(display.sanitized_html ?? '') > 100 * 1024 || truncated) display.sanitized_html = renderSafeHtml(display.output_text);
    data.display_result = display;
  }
  return { ...data, attempt_id: row.id, display_result: data.display_result ?? null, preview_truncated: truncated };
}

function visibleSample(sample: Row): Row {
  if (byteLength(sample) <= 384 * 1024) return sample;
  let remaining = 128 * 1024;
  const history: Message[] = [];
  for (const message of sample.history ?? []) {
    if (remaining <= 256) break;
    const content = truncateUtf8(message.content, remaining - 256);
    const visible = { role: message.role, content };
    history.push(visible); remaining -= byteLength(visible);
  }
  return { ...sample, history, user_input: truncateUtf8(sample.user_input ?? '', 32 * 1024),
    original_assistant_reply: sample.original_assistant_reply ? truncateUtf8(sample.original_assistant_reply, 32 * 1024) : null,
    character_snapshot: byteLength(sample.character_snapshot ?? {}) > 32 * 1024 ? { preview_truncated: true } : sample.character_snapshot,
    dynamic_input_snapshot: byteLength(sample.dynamic_input_snapshot ?? {}) > 32 * 1024 ? { preview_truncated: true } : sample.dynamic_input_snapshot,
    preview_truncated: true };
}

// A transaction locks the owning experiment as well as each task, making stop and
// claim mutually exclusive. A previous turn must be committed before the next one
// can be claimed; two callers may cooperate without running the same turn twice.
export const CLAIM_SQL = `
WITH eligible AS (
  SELECT a.id FROM lab_attempts a
  JOIN lab_records e ON e.kind='experiment' AND e.id=a.experiment_id
  WHERE a.status='pending' AND e.data->>'status' IN ('queued','running')
    AND NULLIF(e.data->>'deleted_at','') IS NULL
    AND ($1::uuid IS NULL OR a.experiment_id=$1::uuid)
    AND NOT EXISTS (
      SELECT 1 FROM lab_attempts previous
      WHERE previous.experiment_id=a.experiment_id AND previous.sample_ordinal=a.sample_ordinal
        AND previous.variant_key=a.variant_key AND previous.turn_index<a.turn_index
        AND previous.status<>'succeeded'
    )
  ORDER BY a.experiment_id,a.sample_ordinal,a.variant_key,a.turn_index
  LIMIT $3 FOR UPDATE OF a,e SKIP LOCKED
), claimed AS (
  UPDATE lab_attempts a SET status='running',lease_owner=$2,
    lease_expires_at=now()+interval '5 minutes',attempt_count=a.attempt_count+1,
    data=a.data || jsonb_build_object('status','running','lease_owner',$2::text,
      'started_at',now(),'completed_at',NULL,'error_code',NULL,'error_message',NULL,
      'attempt_count',a.attempt_count+1,'lease_expires_at',now()+interval '5 minutes')
  FROM eligible WHERE a.id=eligible.id RETURNING a.*
), events AS (
  INSERT INTO lab_attempt_events(attempt_id,experiment_id,event_type,data)
  SELECT id,experiment_id,'claimed',jsonb_build_object('attempt_count',attempt_count,'worker_id',lease_owner,
    'sample_ordinal',sample_ordinal,'variant_key',variant_key,'turn_index',turn_index)
  FROM claimed RETURNING id
), running AS (
  UPDATE lab_records e SET data=e.data || jsonb_build_object('status','running')
  WHERE e.kind='experiment' AND e.id IN (SELECT experiment_id FROM claimed) RETURNING id
)
SELECT * FROM claimed`;

export const COMPLETE_SQL = `
WITH saved AS (
  UPDATE lab_attempts SET status=$5,lease_owner=NULL,lease_expires_at=NULL,
    data=data || $6::jsonb || jsonb_build_object('status',$5::text,'completed_at',now(),
      'lease_owner',NULL,'lease_expires_at',NULL)
  WHERE id=$1::uuid AND experiment_id=$2::uuid AND status='running'
    AND lease_owner=$3 AND attempt_count=$4 AND lease_expires_at>now()
  RETURNING *
), events AS (
  INSERT INTO lab_attempt_events(attempt_id,experiment_id,event_type,data)
  SELECT id,experiment_id,$5,data || jsonb_build_object('attempt_count',attempt_count) FROM saved RETURNING id
)
SELECT * FROM saved`;

export const EXPIRE_SQL = `
WITH expired AS (
  UPDATE lab_attempts SET status='unknown',lease_owner=NULL,lease_expires_at=NULL,
    data=data || jsonb_build_object('status','unknown','completed_at',now(),'lease_owner',NULL,'lease_expires_at',NULL,
      'error_code','EXECUTION_INTERRUPTED','error_message','执行已中断或超时；结果可能已由模型生成，请确认后手动重试')
  WHERE status='running' AND lease_expires_at<=now()
    AND ($1::uuid IS NULL OR experiment_id=$1::uuid) RETURNING *
), events AS (
  INSERT INTO lab_attempt_events(attempt_id,experiment_id,event_type,data)
  SELECT id,experiment_id,'interrupted',data FROM expired RETURNING id
)
SELECT DISTINCT experiment_id FROM expired`;

export function buildAttemptMessages(history: Message[], previous: string[], input: string, preset?: Partial<BatchLabOutputPreset> | null): Message[] {
  const instructions = [preset?.content?.trim() ? `内容要求：${preset.content.trim()}` : '', preset?.format?.trim() ? `格式要求：${preset.format.trim()}` : ''].filter(Boolean);
  return [
    ...(instructions.length ? [{ role: 'system' as const, content: `请严格遵循本次 Batch Lab 输出预设。\n${instructions.join('\n')}` }] : []),
    ...history.map(message => ({ role: message.role, content: message.content })),
    ...previous.map(content => ({ role: 'assistant' as const, content })),
    { role: 'user', content: input },
  ];
}

function detail(experiment: Row): Row {
  return { ...experiment, lineage: {
    kind: experiment.kind ?? 'generation', source_experiment_id: experiment.source_experiment_id ?? null,
    generation_source_experiment_id: experiment.generation_source_experiment_id ?? null,
  } };
}

function attemptData(row: Row): Row {
  return { ...row.data, id: row.id, experiment_id: row.experiment_id, sample_set_id: row.sample_set_id,
    sample_ordinal: row.sample_ordinal, variant_key: row.variant_key, turn_index: row.turn_index,
    status: row.status, attempt_count: row.attempt_count, lease_owner: row.lease_owner,
    lease_expires_at: row.lease_expires_at };
}

export function createExperimentService(dependencies: ExperimentDependencies) {
  const q = dependencies.query;
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const env = dependencies.env ?? process.env;

  async function record(kind: string, id: string): Promise<Row> {
    uuid.parse(id);
    const rows = await q(`SELECT data FROM lab_records WHERE kind=$1 AND id=$2::uuid`, [kind, id]);
    if (!rows[0]) throw serviceError(kind === 'experiment' ? 'BATCH_LAB_EXPERIMENT_NOT_FOUND' : 'BATCH_LAB_SAMPLE_SET_NOT_FOUND', `${kind === 'experiment' ? '实验' : '样本集'}不存在`, 404);
    return rows[0].data;
  }

  async function refresh(experimentId: string): Promise<void> {
    const update = `WITH counts AS (
      SELECT count(*)::int AS total,count(*) FILTER (WHERE status='succeeded')::int AS completed,
        count(*) FILTER (WHERE status IN ('failed','unknown','blocked'))::int AS failed,
        count(*) FILTER (WHERE status='running')::int AS running,count(*) FILTER (WHERE status='pending')::int AS pending
      FROM lab_attempts WHERE experiment_id=$1::uuid
    ) UPDATE lab_records e SET data=e.data || jsonb_build_object(
      'total_attempts',c.total,'completed_attempts',c.completed,'failed_attempts',c.failed,
      'status',CASE WHEN e.data->>'status'='cancelled' THEN 'cancelled' WHEN c.running>0 THEN 'running'
        WHEN c.pending>0 THEN 'queued' WHEN c.total=0 THEN e.data->>'status' WHEN c.failed>0 THEN 'failed' ELSE 'completed' END,
      'completed_at',CASE WHEN e.data->>'status'='cancelled' THEN e.data->'completed_at'
        WHEN c.total>0 AND c.running=0 AND c.pending=0 THEN COALESCE(NULLIF(e.data->'completed_at','null'::jsonb),to_jsonb(now()))
        ELSE NULL END)
      FROM counts c WHERE e.kind='experiment' AND e.id=$1::uuid`;
    if (dependencies.transaction) {
      // The count statement receives a fresh READ COMMITTED snapshot only after
      // the experiment lock is acquired; concurrent completions cannot write a
      // stale aggregate over a newer one.
      await dependencies.transaction([
        { text: `SELECT id FROM lab_records WHERE kind='experiment' AND id=$1::uuid FOR UPDATE`, values: [experimentId] },
        { text: update, values: [experimentId] },
      ]);
    } else await q(update, [experimentId]);
  }

  async function blockDependents(experimentId: string): Promise<void> {
    await q(`WITH blocked AS (
      UPDATE lab_attempts a SET status='blocked',data=a.data || jsonb_build_object('status','blocked',
        'completed_at',now(),'error_code','PREVIOUS_TURN_FAILED','error_message','前一轮没有成功，后续轮次已暂停')
      WHERE a.experiment_id=$1::uuid AND a.status='pending' AND EXISTS (
        SELECT 1 FROM lab_attempts p WHERE p.experiment_id=a.experiment_id AND p.sample_ordinal=a.sample_ordinal
          AND p.variant_key=a.variant_key AND p.turn_index<a.turn_index AND p.status IN ('failed','unknown','blocked')
      ) RETURNING a.*
    ) INSERT INTO lab_attempt_events(attempt_id,experiment_id,event_type,data)
      SELECT id,experiment_id,'blocked',jsonb_build_object('attempt_count',attempt_count,'error_code','PREVIOUS_TURN_FAILED',
        'sample_ordinal',sample_ordinal,'variant_key',variant_key,'turn_index',turn_index) FROM blocked`, [experimentId]);
  }

  async function expire(experimentId: string | null): Promise<void> {
    const rows = await q(EXPIRE_SQL, [experimentId]);
    for (const row of rows) { await blockDependents(row.experiment_id); await refresh(row.experiment_id); }
  }

  async function create(input: any, operation = 'createBatchLabExperiment', lineage: Row = {}): Promise<Row> {
    const parsed = batchLabCreateExperimentRequestSchema.strip().parse(input);
    const requestDigest = digest({ ...parsed, ...lineage });
    const id = operationId(operation, parsed.idempotency_key);
    const existing = await q(`SELECT data FROM lab_records WHERE kind='experiment' AND id=$1::uuid`, [id]);
    if (existing[0]) {
      if (existing[0].data.request_digest !== requestDigest) throw serviceError('BATCH_LAB_IDEMPOTENCY_CONFLICT', '请求标识已用于不同实验配置', 409);
      return existing[0].data;
    }
    const sampleSet = await record('sample_set', parsed.sample_set_id);
    if (sampleSet.deleted_at) throw serviceError('BATCH_LAB_SAMPLE_SET_NOT_FOUND', '样本集已归档', 409);
    for (const variant of parsed.variants) {
      if (variant.processor_version_id) {
        const processors = await q(`SELECT id FROM lab_records WHERE kind='processor' AND id=$1::uuid`, [variant.processor_version_id]);
        if (!processors[0]) throw serviceError('BATCH_LAB_PROCESSOR_NOT_FOUND', '后处理版本不存在', 404);
      }
    }
    const data: Row = { id, name: parsed.name, sample_set_id: parsed.sample_set_id,
      source_environment: sampleSet.source_environment ?? 'test', status: 'draft', purpose: parsed.purpose ?? null,
      run_mode: parsed.run_mode ?? 'single', output_preset: parsed.output_preset, provider_config: parsed.provider_config,
      variants: parsed.variants, total_attempts: 0, completed_attempts: 0, failed_attempts: 0,
      created_at: new Date().toISOString(), started_at: null, completed_at: null,
      dataset_version_id: sampleSet.dataset_version_id ?? undefined, sample_set_version: sampleSet.version ?? undefined,
      ...lineage, request_digest: requestDigest };
    const rows = await q(`INSERT INTO lab_records(kind,id,data)
      SELECT 'experiment',$1::uuid,$2::jsonb FROM lab_records s
      WHERE s.kind='sample_set' AND s.id=$3::uuid AND NULLIF(s.data->>'deleted_at','') IS NULL
      ON CONFLICT(kind,id) DO UPDATE SET id=lab_records.id RETURNING data`, [id, JSON.stringify(data), sampleSet.id]);
    if (!rows[0]) throw serviceError('BATCH_LAB_SAMPLE_SET_NOT_FOUND', '样本集已归档', 409);
    if (rows[0].data.request_digest !== requestDigest) throw serviceError('BATCH_LAB_IDEMPOTENCY_CONFLICT', '请求标识已用于不同实验配置', 409);
    return rows[0].data;
  }

  async function start(input: any): Promise<Row> {
    const parsed = batchLabStartExperimentRequestSchema.strip().parse(input);
    const experiment = await record('experiment', parsed.experiment_id);
    if (experiment.deleted_at) throw serviceError('BATCH_LAB_EXPERIMENT_STATE_CONFLICT', '已归档实验不能执行', 409);
    if (!['draft', 'queued', 'running'].includes(experiment.status)) return experiment;
    await q(`WITH experiment AS MATERIALIZED (
      SELECT id,data FROM lab_records WHERE kind='experiment' AND id=$1::uuid
        AND data->>'status' IN ('draft','queued','running') AND NULLIF(data->>'deleted_at','') IS NULL FOR UPDATE
    ), planned AS MATERIALIZED (
      SELECT gen_random_uuid() AS id,e.id AS experiment_id,s.sample_set_id,s.ordinal AS sample_ordinal,
        v.value->>'key' AS variant_key,t.turn_index
      FROM experiment e JOIN lab_snapshots s ON s.sample_set_id=(e.data->>'sample_set_id')::uuid
      CROSS JOIN LATERAL jsonb_array_elements(e.data->'variants') v
      CROSS JOIN LATERAL generate_series(1,LEAST(5,(v.value->>'max_turns')::int)) t(turn_index)
    ), inserted AS (
      INSERT INTO lab_attempts(id,experiment_id,sample_set_id,sample_ordinal,variant_key,turn_index,status,attempt_count,data)
      SELECT id,experiment_id,sample_set_id,sample_ordinal,variant_key,turn_index,'pending',0,
        jsonb_build_object('id',id,'experiment_id',experiment_id,'sample_set_id',sample_set_id,
          'sample_ordinal',sample_ordinal,'variant_key',variant_key,'turn_index',turn_index,'status','pending',
          'attempt_count',0,'generation_id',NULL,'finish_reason',NULL,'raw_output',NULL,'display_result_id',NULL,
          'display_result',NULL,'error_code',NULL,'error_message',NULL,'started_at',NULL,'completed_at',NULL,'created_at',now())
      FROM planned ON CONFLICT(experiment_id,sample_ordinal,variant_key,turn_index) DO NOTHING RETURNING *
    ), events AS (
      INSERT INTO lab_attempt_events(attempt_id,experiment_id,event_type,data)
      SELECT id,experiment_id,'created',jsonb_build_object('sample_ordinal',sample_ordinal,'variant_key',variant_key,'turn_index',turn_index) FROM inserted RETURNING id
    ) UPDATE lab_records e SET data=e.data || jsonb_build_object('status','queued',
      'started_at',COALESCE(NULLIF(e.data->'started_at','null'::jsonb),to_jsonb(now())),
      'start_idempotency_key',$2::text)
      WHERE e.kind='experiment' AND e.id IN (SELECT id FROM experiment) AND e.data->>'status'='draft'`,
    [parsed.experiment_id, parsed.idempotency_key]);
    await refresh(parsed.experiment_id);
    return record('experiment', parsed.experiment_id);
  }

  async function stop(input: any): Promise<Row> {
    const parsed = batchLabStopExperimentRequestSchema.strip().parse(input);
    await record('experiment', parsed.experiment_id);
    await q(`WITH stopped AS (
      UPDATE lab_records SET data=data || jsonb_build_object('status','cancelled','completed_at',now())
      WHERE kind='experiment' AND id=$1::uuid AND data->>'status' IN ('queued','running') RETURNING id
    ) INSERT INTO lab_attempt_events(attempt_id,experiment_id,event_type,data)
      SELECT a.id,a.experiment_id,'stop_requested',jsonb_build_object('attempt_count',a.attempt_count,
        'sample_ordinal',a.sample_ordinal,'variant_key',a.variant_key,'turn_index',a.turn_index,'status',a.status)
      FROM lab_attempts a JOIN stopped e ON e.id=a.experiment_id WHERE a.status IN ('pending','running')`, [parsed.experiment_id]);
    return record('experiment', parsed.experiment_id);
  }

  async function retry(input: any): Promise<Row> {
    const id = uuid.parse(input.experiment_id ?? input.experimentId);
    await expire(id);
    await record('experiment', id);
    const rows = await q(`WITH locked AS MATERIALIZED (
      SELECT id,data FROM lab_records e WHERE kind='experiment' AND id=$1::uuid
        AND NULLIF(data->>'deleted_at','') IS NULL
        AND NOT EXISTS(SELECT 1 FROM lab_attempts a WHERE a.experiment_id=e.id AND a.status='running') FOR UPDATE
    ), retried AS (
      UPDATE lab_attempts a SET status='pending',lease_owner=NULL,lease_expires_at=NULL,
        data=a.data || jsonb_build_object('status','pending','error_code',NULL,'error_message',NULL,
          'started_at',NULL,'completed_at',NULL,'lease_owner',NULL,'lease_expires_at',NULL,
          'raw_output',NULL,'generation_id',NULL,'finish_reason',NULL,'display_result',NULL,'display_result_id',NULL,'input_messages',NULL)
      FROM locked WHERE a.experiment_id=locked.id AND a.status IN ('failed','unknown','blocked','pending') RETURNING a.*
    ), events AS (
      INSERT INTO lab_attempt_events(attempt_id,experiment_id,event_type,data)
      SELECT id,experiment_id,'retry_requested',jsonb_build_object('attempt_count',attempt_count,'sample_ordinal',sample_ordinal,'variant_key',variant_key,'turn_index',turn_index) FROM retried RETURNING id
    ) UPDATE lab_records e SET data=e.data || jsonb_build_object('status','queued','completed_at',NULL)
      WHERE e.kind='experiment' AND e.id IN (SELECT experiment_id FROM retried) RETURNING e.data`, [id]);
    if (!rows[0]) throw serviceError('BATCH_LAB_EXPERIMENT_STATE_CONFLICT', '没有可重试任务，或仍有任务正在执行', 409);
    await refresh(id);
    return record('experiment', id);
  }

  async function finish(attempt: Row, status: string, patch: Row): Promise<boolean> {
    const rows = await q(COMPLETE_SQL, [attempt.id, attempt.experiment_id, attempt.lease_owner, attempt.attempt_count, status, JSON.stringify(patch)]);
    if (!rows[0]) return false;
    if (status !== 'succeeded') await blockDependents(attempt.experiment_id);
    await refresh(attempt.experiment_id);
    return true;
  }

  async function requestLog(attempt: Row, data: Row): Promise<boolean> {
    const rows = await q(`WITH updated AS (
      UPDATE lab_attempts SET data=data || $5::jsonb WHERE id=$1::uuid AND experiment_id=$2::uuid
        AND lease_owner=$3 AND attempt_count=$4 AND status='running' AND lease_expires_at>now() RETURNING *
    ), events AS (
      INSERT INTO lab_attempt_events(attempt_id,experiment_id,event_type,data)
      SELECT id,experiment_id,'request_started',$5::jsonb || jsonb_build_object('attempt_count',attempt_count) FROM updated RETURNING id
    ) SELECT id FROM updated`, [attempt.id, attempt.experiment_id, attempt.lease_owner, attempt.attempt_count, JSON.stringify(data)]);
    return !!rows[0];
  }

  async function modelRequest(variant: BatchLabExperimentVariant, experiment: Row, messages: Message[]): Promise<Row> {
    const provider = variant.provider_config ?? experiment.provider_config;
    const url = modelUrl(provider?.base_url || env.BATCH_LAB_MODEL_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions', env);
    const reference = provider?.key_ref?.trim();
    if (reference && !['BATCH_LAB_MODEL_KEY', 'VITE_BATCH_LAB_MODEL_KEY'].includes(reference) && !/^BATCH_LAB_MODEL_KEY_[A-Z0-9_]+$/.test(reference)) {
      throw serviceError('BATCH_LAB_CONFIGURATION_ERROR', '模型密钥引用必须指向服务端 BATCH_LAB_MODEL_KEY 配置');
    }
    const key = !reference || ['BATCH_LAB_MODEL_KEY', 'VITE_BATCH_LAB_MODEL_KEY'].includes(reference)
      ? env.BATCH_LAB_MODEL_KEY || env.VITE_BATCH_LAB_MODEL_KEY : env[reference];
    if (!key) throw serviceError('BATCH_LAB_CONFIGURATION_ERROR', '尚未配置服务端模型密钥');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const response = await fetcher(url, {
        method: 'POST', signal: controller.signal, redirect: 'error',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'ST Batch Lab' },
        body: JSON.stringify({ ...variant.sampling, model: provider?.module_name || variant.openrouter_model_id, messages, stream: false }),
      });
      const payload: any = await response.json().catch(() => null);
      if (!response.ok) throw serviceError('MODEL_HTTP_ERROR', `模型请求失败（${response.status}）：${String(payload?.error?.message || response.statusText).slice(0, 1000)}`, 502);
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw serviceError('MODEL_RESPONSE_INVALID', '模型响应缺少 choices[0].message.content', 502);
      return { raw_output: content, generation_id: payload.id ?? null, finish_reason: payload.choices[0].finish_reason ?? null,
        response_metadata: { model: payload.model ?? null, usage: payload.usage ?? null } };
    } catch (error: any) {
      if (controller.signal.aborted) throw serviceError('MODEL_REQUEST_TIMEOUT', '模型调用超过90秒，结果未知；请确认后手动重试', 504);
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function runAttempt(attempt: Row): Promise<boolean> {
    let output: Row = {};
    try {
      const experiment = await record('experiment', attempt.experiment_id);
      const variant = experiment.variants.find((item: Row) => item.key === attempt.variant_key) as BatchLabExperimentVariant | undefined;
      const snapshots = await q(`SELECT data FROM lab_snapshots WHERE sample_set_id=$1::uuid AND ordinal=$2`, [attempt.sample_set_id, attempt.sample_ordinal]);
      const sample = snapshots[0]?.data;
      if (!variant || !sample) throw serviceError('BATCH_LAB_EXPERIMENT_VALIDATION_ERROR', '实验快照或变体不存在');
      if (experiment.kind === 'reuse_display') {
        const sourceId = experiment.generation_source_experiment_id || experiment.source_experiment_id;
        const source = await q(`SELECT id,data FROM lab_attempts WHERE experiment_id=$1::uuid AND sample_ordinal=$2 AND variant_key=$3 AND turn_index=$4 AND status='succeeded'`,
          [sourceId, attempt.sample_ordinal, attempt.variant_key, attempt.turn_index]);
        if (!source[0] || typeof source[0].data.raw_output !== 'string') throw serviceError('BATCH_LAB_EXPERIMENT_VALIDATION_ERROR', '源实验对应轮次没有可复用的成功输出');
        output = { raw_output: source[0].data.raw_output, generation_id: source[0].data.generation_id ?? null,
          finish_reason: source[0].data.finish_reason ?? null, reused_from_attempt_id: source[0].id,
          input_messages: source[0].data.input_messages ?? [], request_model: source[0].data.request_model ?? null };
        if (!(await requestLog(attempt, { ...output, reuse_only: true }))) return false;
      } else {
        const previous = await q(`SELECT data->>'raw_output' AS output FROM lab_attempts
          WHERE experiment_id=$1::uuid AND sample_ordinal=$2 AND variant_key=$3 AND turn_index<$4 AND status='succeeded' ORDER BY turn_index`,
        [attempt.experiment_id, attempt.sample_ordinal, attempt.variant_key, attempt.turn_index]);
        const messages = buildAttemptMessages(sample.history ?? [], previous.map(row => row.output), sample.user_input, variant.output_preset ?? experiment.output_preset);
        const log = { input_messages: messages, request_model: variant.provider_config?.module_name || experiment.provider_config?.module_name || variant.openrouter_model_id,
          request_sampling: variant.sampling, request_base_url: variant.provider_config?.base_url || experiment.provider_config?.base_url || env.BATCH_LAB_MODEL_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions' };
        if (!(await requestLog(attempt, log))) return false;
        output = { ...log, ...await modelRequest(variant, experiment, messages) };
      }
      let displayResult: any = null;
      if (variant.processor_version_id) {
        const processors = await q(`SELECT data FROM lab_records WHERE kind='processor' AND id=$1::uuid`, [variant.processor_version_id]);
        if (!processors[0]) throw serviceError('BATCH_LAB_PROCESSOR_NOT_FOUND', '后处理版本不存在');
        displayResult = await runPostprocessor(processors[0].data, output.raw_output);
      }
      output = { ...output, display_result: displayResult, display_result_id: displayResult?.id ?? null, error_code: null, error_message: null };
    } catch (error: any) {
      const uncertain = error?.code === 'MODEL_REQUEST_TIMEOUT' || error?.name === 'TypeError';
      await finish(attempt, uncertain ? 'unknown' : 'failed', { ...output, error_code: error?.code ?? 'EXECUTION_FAILED', error_message: String(error?.message ?? '执行失败').slice(0, 2000) });
      return false;
    }
    // If persistence fails after generation, do not rewrite it as a model failure
    // or automatically call the provider again. Lease expiry exposes uncertainty.
    return finish(attempt, 'succeeded', output);
  }

  async function run(input: any, scoped: boolean): Promise<Row> {
    const parsed = scoped ? batchLabRunExperimentWorkerRequestSchema.strip().parse(input) : batchLabRunWorkerRequestSchema.strip().parse(input);
    const id = 'experiment_id' in parsed ? String(parsed.experiment_id) : null;
    await expire(id);
    const attempts = await q(CLAIM_SQL, [id, parsed.worker_id, Math.min(MAX_BATCH, parsed.claim_limit)]);
    const settled = await Promise.allSettled(attempts.map(runAttempt));
    const rejected = settled.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    return { claimed_count: attempts.length, completed_count: settled.filter(result => result.status === 'fulfilled' && result.value).length,
      failed_count: settled.filter(result => result.status === 'fulfilled' && !result.value).length };
  }

  async function results(input: any, all = false): Promise<Row> {
    const id = uuid.parse(input.experimentId ?? input.experiment_id);
    await expire(id);
    const experiment = await record('experiment', id);
    const sampleSet = await record('sample_set', experiment.sample_set_id);
    const paging = input.input ?? {};
    const offset = z.coerce.number().int().min(0).parse(paging.cursor ?? 0);
    const limit = all ? 500 : Math.min(PAGE_SIZE, z.coerce.number().int().min(1).max(500).parse(paging.limit ?? PAGE_SIZE));
    const snapshots = await q(`SELECT ordinal,data FROM lab_snapshots WHERE sample_set_id=$1::uuid ORDER BY ordinal LIMIT $2 OFFSET $3`, [sampleSet.id, limit + 1, offset]);
    const samples = snapshots.slice(0, limit).map(row => ({ ...row.data, ordinal: row.ordinal }));
    const ordinals = samples.map(sample => sample.ordinal);
    const attemptProjection = all ? '*' : `id,experiment_id,sample_set_id,sample_ordinal,variant_key,turn_index,status,
      lease_owner,lease_expires_at,attempt_count,data - 'input_messages' - 'request_sampling' - 'response_metadata' AS data`;
    const [attempts, annotations, counts] = await Promise.all([
      q(`SELECT ${attemptProjection} FROM lab_attempts WHERE experiment_id=$1::uuid AND sample_ordinal=ANY($2::int[]) ORDER BY sample_ordinal,variant_key,turn_index`, [id, ordinals]),
      q(`SELECT data FROM lab_annotations WHERE experiment_id=$1::uuid AND (sample_ordinal=-1 OR sample_ordinal=ANY($2::int[])) ORDER BY sample_ordinal,turn_index`, [id, ordinals]),
      q(`SELECT status,count(*)::int AS count FROM lab_attempts WHERE experiment_id=$1::uuid GROUP BY status`, [id]),
    ]);
    const byStatus = Object.fromEntries(counts.map(row => [row.status, Number(row.count)]));
    const visibleSamples: Row[] = [];
    const visibleAttempts: Row[] = [];
    let pageBytes = byteLength({ experiment, sampleSet, annotations });
    for (const sample of samples) {
      const selectedSample = all ? sample : visibleSample(sample);
      const selectedAttempts = attempts.filter(row => row.sample_ordinal === sample.ordinal).map(row => all
        ? { ...attemptData(row), attempt_id: row.id, display_result: row.data.display_result ?? null }
        : visibleAttempt(row));
      const bytes = byteLength(selectedSample) + byteLength(selectedAttempts);
      if (!all && visibleSamples.length && pageBytes + bytes > RESULT_BYTE_BUDGET) break;
      visibleSamples.push(selectedSample); visibleAttempts.push(...selectedAttempts); pageBytes += bytes;
    }
    return { experiment: detail(experiment), sample_set: sampleSet, samples: visibleSamples,
      attempts: visibleAttempts,
      annotations: annotations.map(row => row.data), progress: {
        total_attempts: counts.reduce((total, row) => total + Number(row.count), 0), completed_attempts: byStatus.succeeded ?? 0,
        failed_attempts: (byStatus.failed ?? 0) + (byStatus.unknown ?? 0) + (byStatus.blocked ?? 0),
        pending_attempts: byStatus.pending ?? 0, running_attempts: byStatus.running ?? 0,
      }, next_sample_cursor: snapshots.length > visibleSamples.length ? String(offset + visibleSamples.length) : null };
  }

  return async function operation(op: string, input: any = {}): Promise<unknown> {
    switch (op) {
      case 'listBatchLabExperiments': {
        await expire(null);
        return (await q(`SELECT data FROM lab_records WHERE kind='experiment' AND NULLIF(data->>'deleted_at','') IS NULL ORDER BY created_at DESC,id`)).map(row => row.data);
      }
      case 'createBatchLabExperiment': return create(input);
      case 'getBatchLabExperiment': {
        const id = uuid.parse(input.experimentId ?? input.experiment_id); await expire(id); return detail(await record('experiment', id));
      }
      case 'getBatchLabExperimentResults': return results(input);
      case 'startBatchLabExperiment': return start(input);
      case 'stopBatchLabExperiment': return stop(input);
      case 'retryBatchLabExperiment': return retry(input);
      case 'runBatchLabWorkerOnce': return run(input, false);
      case 'runBatchLabExperimentWorkerOnce': return run(input, true);
      case 'deleteBatchLabExperiment': {
        const parsed = batchLabDeleteExperimentRequestSchema.strip().parse(input);
        await expire(parsed.experiment_id);
        await record('experiment', parsed.experiment_id);
        const rows = await q(`UPDATE lab_records e SET data=data || jsonb_build_object('deleted_at',now()) WHERE kind='experiment' AND id=$1::uuid
          AND data->>'status' NOT IN ('queued','running')
          AND NOT EXISTS(SELECT 1 FROM lab_attempts a WHERE a.experiment_id=e.id AND a.status='running') RETURNING data`, [parsed.experiment_id]);
        if (!rows[0]) throw serviceError('BATCH_LAB_EXPERIMENT_STATE_CONFLICT', '请先停止实验并等待已领取任务结束，再归档', 409);
        return { id: parsed.experiment_id, deleted_at: rows[0].data.deleted_at };
      }
      case 'copyBatchLabExperiment':
      case 'createBatchLabReuseDisplayExperiment': {
        const reuse = op === 'createBatchLabReuseDisplayExperiment';
        const parsed = reuse ? batchLabReuseDisplayExperimentRequestSchema.strip().parse(input) : batchLabCopyExperimentRequestSchema.strip().parse(input);
        const source = await record('experiment', parsed.source_experiment_id);
        const variants = reuse ? (parsed as any).variants : source.variants;
        if (reuse && variants.some((variant: Row) => !source.variants.some((original: Row) => original.key === variant.key && original.max_turns >= variant.max_turns))) {
          throw serviceError('BATCH_LAB_EXPERIMENT_VALIDATION_ERROR', '复用实验的变体标识和轮数必须与源输出对应');
        }
        return create({ ...parsed, variants, sample_set_id: source.sample_set_id, run_mode: source.run_mode,
          output_preset: reuse ? (parsed as any).output_preset : source.output_preset,
          provider_config: reuse ? (parsed as any).provider_config : source.provider_config }, op,
        { kind: reuse ? 'reuse_display' : 'generation', source_experiment_id: source.id,
          generation_source_experiment_id: reuse ? source.generation_source_experiment_id || source.id : null });
      }
      case 'upsertBatchLabAnnotation': {
        const parsed = batchLabUpsertAnnotationRequestSchema.strip().parse(input);
        const experiment = await record('experiment', parsed.experiment_id);
        if (parsed.sample_ordinal !== null) {
          const rows = await q(`SELECT ordinal FROM lab_snapshots WHERE sample_set_id=$1::uuid AND ordinal=$2`, [experiment.sample_set_id, parsed.sample_ordinal]);
          if (!rows[0]) throw serviceError('BATCH_LAB_EXPERIMENT_VALIDATION_ERROR', '标注样本不存在');
        }
        const { source_environment: _sourceEnvironment, ...target } = parsed;
        const data = { ...target, updated_at: new Date().toISOString() };
        const rows = await q(`INSERT INTO lab_annotations(experiment_id,sample_ordinal,turn_index,data) VALUES ($1::uuid,$2,$3,$4::jsonb)
          ON CONFLICT(experiment_id,sample_ordinal,turn_index) DO UPDATE SET data=excluded.data RETURNING data`,
        [parsed.experiment_id, parsed.sample_ordinal ?? -1, parsed.turn_index ?? -1, JSON.stringify(data)]);
        return rows[0].data;
      }
      case 'listBatchLabAttemptEvents': {
        const id = uuid.parse(input.experimentId ?? input.experiment_id); await record('experiment', id);
        return q(`SELECT * FROM (SELECT id,attempt_id,experiment_id,event_type,created_at,
          data - 'input_messages' - 'raw_output' - 'display_result' - 'response_metadata' AS data
          FROM lab_attempt_events WHERE experiment_id=$1::uuid ORDER BY id DESC LIMIT 100) events ORDER BY id`, [id]);
      }
      case 'getBatchLabAttemptContent': {
        const parsed = z.object({ attemptId: uuid,
          field: z.enum(['raw_output', 'input_messages', 'display_result', 'response_metadata']),
          cursor: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(20_000).default(20_000),
        }).parse(input);
        const rows = await q(`SELECT id,substring(COALESCE(data->>$2,''),$3::int+1,$4::int) AS text,
          length(COALESCE(data->>$2,'')) AS total_characters FROM lab_attempts WHERE id=$1::uuid`,
        [parsed.attemptId, parsed.field, parsed.cursor, parsed.limit]);
        if (!rows[0]) throw serviceError('BATCH_LAB_EXPERIMENT_NOT_FOUND', '执行记录不存在', 404);
        return { attempt_id: rows[0].id, field: parsed.field, text: rows[0].text, total_characters: rows[0].total_characters,
          next_cursor: parsed.cursor + parsed.limit < rows[0].total_characters ? String(parsed.cursor + parsed.limit) : null };
      }
      case 'getBatchLabExperimentEvents': {
        const id = uuid.parse(input.experimentId ?? input.experiment_id); await record('experiment', id);
        const limit = z.coerce.number().int().min(1).max(100).parse(input.limit ?? 50);
        const after = z.coerce.number().int().min(0).parse(input.afterId ?? 0);
        return q(`SELECT id,attempt_id,experiment_id,event_type,created_at,
          data - 'input_messages' - 'raw_output' - 'display_result' - 'response_metadata' AS data
          FROM lab_attempt_events WHERE experiment_id=$1::uuid AND id>$2 ORDER BY id LIMIT $3`, [id, after, limit]);
      }
      case 'downloadBatchLabExperimentJsonl': {
        const result = await results(input, true);
        return result.samples.map((sample: Row) => JSON.stringify({ schema_version: BATCH_LAB_JSONL_SCHEMA_VERSION,
          experiment: result.experiment, sample, attempts: result.attempts.filter((attempt: Row) => attempt.sample_ordinal === sample.ordinal),
          annotations: result.annotations.filter((annotation: Row) => annotation.sample_ordinal === null || annotation.sample_ordinal === sample.ordinal),
        })).join('\n') + '\n';
      }
      default: throw serviceError('BATCH_LAB_OPERATION_NOT_FOUND', '未知实验操作', 404);
    }
  };
}

export function modelUrl(base: string, env: Record<string, string | undefined>): string {
  let url: URL;
  try { url = new URL(base); } catch { throw serviceError('BATCH_LAB_CONFIGURATION_ERROR', '模型接口地址无效'); }
  const configured = env.BATCH_LAB_MODEL_BASE_URL ? new URL(env.BATCH_LAB_MODEL_BASE_URL).hostname : '';
  const allowed = new Set(['openrouter.ai', configured, ...(env.BATCH_LAB_ALLOWED_MODEL_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean)]);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !allowed.has(url.hostname)) {
    throw serviceError('BATCH_LAB_CONFIGURATION_ERROR', '模型接口域名未在服务端允许列表中配置');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  return url.toString();
}

const defaultService = createExperimentService({ query, transaction });
export async function experimentOperation(op: string, input: any = {}): Promise<unknown> {
  return defaultService(op, input);
}
