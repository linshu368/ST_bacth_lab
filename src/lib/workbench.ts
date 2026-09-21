import {
  BATCH_LAB_MAX_PROCESSOR_PATTERN_LENGTH,
  BATCH_LAB_MAX_PROCESSOR_REPLACEMENT_LENGTH,
  BATCH_LAB_MAX_PROCESSOR_RULES,
  BATCH_LAB_PROCESSOR_TIMEOUT_MS,
  type BatchLabDisplayResultStatus,
  type BatchLabExperimentStatus,
  type BatchLabExperimentSummary,
  type BatchLabExperimentVariant,
  type BatchLabProcessorConfig,
  type BatchLabProcessorVersion,
  type BatchLabRegexRule,
  type BatchLabSqlParameterValue,
} from './batch-lab-contracts';

export function newIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? '00000000-0000-4000-8000-000000000000';
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} 必须是有效 JSON 对象`);
  }
  if (!isJsonRecord(parsed)) throw new Error(`${label} 必须是 JSON 对象`);
  return parsed;
}

function parseSqlParameterValue(value: unknown): BatchLabSqlParameterValue {
  if (typeof value === 'string' && value.length <= 1_000) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean' || value === null) return value;
  throw new Error('SQL 参数仅支持字符串、数字、布尔值或 null');
}

export function parseSqlParameters(text: string): Record<string, BatchLabSqlParameterValue> {
  const parsed = parseJsonRecord(text, 'SQL 参数');
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, parseSqlParameterValue(value)])
  );
}

export function parseSampling(text: string): Record<string, number> {
  const parsed = parseJsonRecord(text, '采样参数');
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error('采样参数值必须是有限数字');
      }
      return [key, value];
    })
  );
}

export function parseRegexRules(text: string): BatchLabRegexRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('规则必须是有效 JSON 数组');
  }
  if (!Array.isArray(parsed)) throw new Error('规则必须是 JSON 数组');
  if (parsed.length > BATCH_LAB_MAX_PROCESSOR_RULES) {
    throw new Error(`最多支持 ${BATCH_LAB_MAX_PROCESSOR_RULES} 条规则`);
  }

  return parsed.map((value, index) => {
    if (!isJsonRecord(value)) throw new Error(`第 ${index + 1} 条规则必须是对象`);
    const pattern = value.pattern;
    const flags = value.flags ?? 'g';
    const replacement = value.replacement ?? '';
    if (typeof pattern !== 'string' || pattern.length < 1) {
      throw new Error(`第 ${index + 1} 条规则缺少 pattern`);
    }
    if (pattern.length > BATCH_LAB_MAX_PROCESSOR_PATTERN_LENGTH) {
      throw new Error(`第 ${index + 1} 条规则 pattern 过长`);
    }
    if (typeof flags !== 'string' || !/^[dgimsuy]*$/.test(flags)) {
      throw new Error(`第 ${index + 1} 条规则 flags 无效`);
    }
    if (new Set(flags).size !== flags.length) {
      throw new Error(`第 ${index + 1} 条规则 flags 不能重复`);
    }
    if (typeof replacement !== 'string') {
      throw new Error(`第 ${index + 1} 条规则 replacement 必须是字符串`);
    }
    if (replacement.length > BATCH_LAB_MAX_PROCESSOR_REPLACEMENT_LENGTH) {
      throw new Error(`第 ${index + 1} 条规则 replacement 过长`);
    }
    try {
      new RegExp(pattern, flags);
    } catch {
      throw new Error(`第 ${index + 1} 条规则不是有效正则`);
    }
    return { pattern, flags, replacement };
  });
}

export function buildProcessorConfig(protocol: 'none_v1' | 'regex_json_v1', rulesJson: string) {
  return protocol === 'none_v1'
    ? ({ protocol: 'none_v1' } satisfies BatchLabProcessorConfig)
    : ({
        protocol: 'regex_json_v1',
        rules: parseRegexRules(rulesJson),
        timeout_ms: BATCH_LAB_PROCESSOR_TIMEOUT_MS,
      } satisfies BatchLabProcessorConfig);
}

export function processorConfigToRulesJson(config: BatchLabProcessorConfig): string {
  return config.protocol === 'regex_json_v1' ? JSON.stringify(config.rules, null, 2) : '[]';
}

export function experimentProgress(experiment: BatchLabExperimentSummary): number {
  if (experiment.total_attempts === 0) return 0;
  return Math.round(
    ((experiment.completed_attempts + experiment.failed_attempts) / experiment.total_attempts) * 100
  );
}

export function experimentStatusText(status: BatchLabExperimentStatus): string {
  const labels: Record<BatchLabExperimentStatus, string> = {
    draft: '草稿',
    queued: '等待中',
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  return labels[status];
}

export function displayStatusText(status: BatchLabDisplayResultStatus): string {
  const labels: Record<BatchLabDisplayResultStatus, string> = {
    success: '成功',
    failed: '失败',
    timeout: '超时',
    limit_exceeded: '超出限制',
    validation_error: '校验失败',
  };
  return labels[status];
}

export function processorOptionLabel(processor: BatchLabProcessorVersion): string {
  return `${processor.name} · ${processor.protocol} · ${processor.digest.slice(0, 18)}`;
}

export function variantDiffRows(a: BatchLabExperimentVariant, b: BatchLabExperimentVariant) {
  return [
    {
      key: 'provider_base_url',
      label: 'OpenRouter URL',
      baseline: a.provider_config?.base_url ?? '未设置',
      candidate: b.provider_config?.base_url ?? '未设置',
    },
    {
      key: 'openrouter_model_id',
      label: '模型名称',
      baseline: a.openrouter_model_id,
      candidate: b.openrouter_model_id,
    },
    {
      key: 'output_preset',
      label: '输出预设',
      baseline: a.output_preset?.content ?? '未设置',
      candidate: b.output_preset?.content ?? '未设置',
    },
    {
      key: 'processor',
      label: '对应后处理',
      baseline: a.processor_version_id ?? '不处理',
      candidate: b.processor_version_id ?? '不处理',
    },
    {
      key: 'max_turns',
      label: '重跑轮数',
      baseline: String(a.max_turns),
      candidate: String(b.max_turns),
    },
  ];
}
