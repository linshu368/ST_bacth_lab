import { z } from 'zod';

// 默认样本限制
export const BATCH_LAB_DEFAULT_SAMPLE_LIMIT = 50;
// 最大样本限制
export const BATCH_LAB_MAX_SAMPLE_LIMIT = 500;
// 最大 SQL 长度
export const BATCH_LAB_MAX_SQL_LENGTH = 20_000;
// 最大名称长度
export const BATCH_LAB_MAX_NAME_LENGTH = 120;
// 最大预览字节数
export const BATCH_LAB_MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
// 预览 TTL 秒
export const BATCH_LAB_PREVIEW_TTL_SECONDS = 15 * 60;
export const BATCH_LAB_MAX_PROCESSOR_INPUT_CHARS = 200_000;
export const BATCH_LAB_MAX_PROCESSOR_OUTPUT_CHARS = 200_000;
export const BATCH_LAB_MAX_PROCESSOR_RULES = 50;
export const BATCH_LAB_MAX_PROCESSOR_PATTERN_LENGTH = 2_000;
export const BATCH_LAB_MAX_PROCESSOR_REPLACEMENT_LENGTH = 20_000;
export const BATCH_LAB_PROCESSOR_TIMEOUT_MS = 250;
export const BATCH_LAB_MAX_PURPOSE_LENGTH = 2_000;
export const BATCH_LAB_MAX_OUTPUT_PRESET_TEXT_LENGTH = 10_000;
export const BATCH_LAB_MAX_PROVIDER_CONFIG_LENGTH = 500;

// 后端环境
export const batchLabBackendEnvironmentSchema = z.enum(['development', 'test', 'production']);
// 来源环境
export const batchLabSourceEnvironmentSchema = z.enum(['test', 'production']);
export type BatchLabSourceEnvironment = z.infer<typeof batchLabSourceEnvironmentSchema>;

// 上下文
export const batchLabContextSchema = z
  .object({
    backend_environment: batchLabBackendEnvironmentSchema,
    source_environment: batchLabSourceEnvironmentSchema,
    capabilities: z
      .object({
        sample_preview: z.boolean(),
        experiment_execution: z.boolean(),
      })
      .strict(),
  })
  .strict();

// 上下文类型
export type BatchLabContext = z.infer<typeof batchLabContextSchema>;

// 上下文响应
export const batchLabContextResponseSchema = z
  .object({
    success: z.literal(true),
    data: batchLabContextSchema,
  })
  .strict();

// 错误码
export const batchLabErrorCodeSchema = z.enum([
  'BATCH_LAB_DISABLED',
  'BATCH_LAB_CONFIGURATION_ERROR',
  'BATCH_LAB_TIMEOUT',
  'BATCH_LAB_REQUEST_CANCELLED',
  'BATCH_LAB_NETWORK_ERROR',
  'BATCH_LAB_PROTOCOL_ERROR',
  'BATCH_LAB_INVALID_SQL',
  'BATCH_LAB_CAPACITY_EXCEEDED',
  'BATCH_LAB_SOURCE_UNAVAILABLE',
  'BATCH_LAB_ENVIRONMENT_MISMATCH',
  'BATCH_LAB_PREVIEW_NOT_FOUND',
  'BATCH_LAB_PREVIEW_EXPIRED',
  'BATCH_LAB_PREVIEW_MISMATCH',
  'BATCH_LAB_EMPTY_PREVIEW',
  'BATCH_LAB_IDEMPOTENCY_CONFLICT',
  'BATCH_LAB_PROCESSOR_NOT_FOUND',
  'BATCH_LAB_PROCESSOR_VALIDATION_ERROR',
  'BATCH_LAB_PROCESSOR_TIMEOUT',
  'BATCH_LAB_PROCESSOR_LIMIT_EXCEEDED',
  'BATCH_LAB_PROCESSOR_RUNTIME_ERROR',
  'BATCH_LAB_EXPERIMENT_NOT_FOUND',
  'BATCH_LAB_EXPERIMENT_STATE_CONFLICT',
  'BATCH_LAB_EXPERIMENT_VALIDATION_ERROR',
  'BATCH_LAB_EXPERIMENT_NO_WORK',
  'BATCH_LAB_SAMPLE_SET_NOT_FOUND',
  'BATCH_LAB_SAMPLE_SET_IN_USE',
]);

// 错误响应
export const batchLabErrorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z
      .object({
        code: batchLabErrorCodeSchema,
        message: z.string().min(1),
      })
      .strict(),
  })
  .strict();

// 错误码类型
export type BatchLabErrorCode = z.infer<typeof batchLabErrorCodeSchema>;

// 错误响应类型
export type BatchLabErrorResponse = z.infer<typeof batchLabErrorResponseSchema>;

// UUID 模式
const uuidSchema = z.string().uuid();
// ISO 日期时间模式
const isoDateTimeSchema = z.string().datetime({ offset: true });
// 摘要模式
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
// 计数模式
const countSchema = z.number().int().nonnegative();

// SQL 参数值模式
export const batchLabSqlParameterValueSchema = z.union([
  z.string().max(1_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type BatchLabSqlParameterValue = z.infer<typeof batchLabSqlParameterValueSchema>;

// SQL 模板模式
export const batchLabSqlTemplateSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/),
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(BATCH_LAB_MAX_NAME_LENGTH),
    description: z.string().max(2_000),
    sql: z.string().min(1).max(BATCH_LAB_MAX_SQL_LENGTH),
    default_parameters: z.record(batchLabSqlParameterValueSchema),
    enabled: z.boolean(),
  })
  .strict();

// SQL 模板类型
export type BatchLabSqlTemplate = z.infer<typeof batchLabSqlTemplateSchema>;

// SQL 模板列表响应模式
export const batchLabSqlTemplateListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ items: z.array(batchLabSqlTemplateSchema) }).strict(),
  })
  .strict();

// 预览请求模式
export const batchLabPreviewRequestSchema = z
  .object({
    source_environment: batchLabSourceEnvironmentSchema,
    dataset_version_id: uuidSchema.optional(),
    template_key: batchLabSqlTemplateSchema.shape.key.nullable(),
    template_version: z.number().int().positive().nullable(),
    sql: z.string().trim().min(1).max(BATCH_LAB_MAX_SQL_LENGTH),
    parameters: z.record(batchLabSqlParameterValueSchema),
    sample_limit: z
      .number()
      .int()
      .min(1)
      .max(BATCH_LAB_MAX_SAMPLE_LIMIT)
      .default(BATCH_LAB_DEFAULT_SAMPLE_LIMIT),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.template_key === null) !== (value.template_version === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'template_key and template_version must both be present or both be null',
      });
    }
  });

// 预览请求类型
export type BatchLabPreviewRequest = z.infer<typeof batchLabPreviewRequestSchema>;

// 预览排除原因模式
export const batchLabPreviewExclusionReasonSchema = z.enum([
  'duplicate_anchor',
  'missing_session',
  'missing_history',
  'missing_character',
  'invalid_anchor',
  'snapshot_too_large',
]);
export type BatchLabPreviewExclusionReason = z.infer<typeof batchLabPreviewExclusionReasonSchema>;

// 预览统计模式
export const batchLabPreviewStatisticsSchema = z
  .object({
    requested_count: z.number().int().positive(),
    candidate_count: countSchema,
    valid_count: countSchema,
    user_count: countSchema,
    session_count: countSchema,
    character_count: countSchema,
    excluded_by_reason: z.record(batchLabPreviewExclusionReasonSchema, countSchema),
    truncated: z.boolean(),
    snapshot_bytes: z.number().int().min(0),
  })
  .strict();
export type BatchLabPreviewStatistics = z.infer<typeof batchLabPreviewStatisticsSchema>;

// 快照消息模式
export const batchLabSnapshotMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
  })
  .strict();
export type BatchLabSnapshotMessage = z.infer<typeof batchLabSnapshotMessageSchema>;

// 预览项模式
export const batchLabPreviewItemSchema = z
  .object({
    ordinal: countSchema,
    source_history_id: uuidSchema,
    source_session_id: uuidSchema,
    source_user_id: uuidSchema,
    source_character_id: uuidSchema,
    turn_index: z.number().int().positive(),
    revision: countSchema,
    user_input: z.string(),
    original_assistant_reply: z.string().nullable(),
    original_model: z.string().min(1),
    history: z.array(batchLabSnapshotMessageSchema),
    character_snapshot: z.record(z.unknown()),
    dynamic_input_snapshot: z.record(z.unknown()),
    restoration_strategy: z.enum(['exact_prompt_snapshot', 'fixed_start']),
  })
  .strict();

// 预览项类型
export type BatchLabPreviewItem = z.infer<typeof batchLabPreviewItemSchema>;

// 预览模式
export const batchLabPreviewSchema = z
  .object({
    id: uuidSchema,
    dataset_version_id: uuidSchema.optional(),
    dataset_version_name: z.string().optional(),
    dataset_version_number: z.number().int().positive().optional(),
    digest: digestSchema,
    source_environment: batchLabSourceEnvironmentSchema,
    final_sql: z.string().min(1).max(BATCH_LAB_MAX_SQL_LENGTH),
    parameters: z.record(batchLabSqlParameterValueSchema),
    sample_limit: z.number().int().min(1).max(BATCH_LAB_MAX_SAMPLE_LIMIT),
    statistics: batchLabPreviewStatisticsSchema,
    items: z.array(batchLabPreviewItemSchema).max(BATCH_LAB_MAX_SAMPLE_LIMIT),
    created_at: isoDateTimeSchema,
    expires_at: isoDateTimeSchema,
  })
  .strict();

// 预览类型
export type BatchLabPreview = z.infer<typeof batchLabPreviewSchema>;

// 预览响应模式
export const batchLabPreviewResponseSchema = z
  .object({ success: z.literal(true), data: batchLabPreviewSchema })
  .strict();

// 创建样本集请求模式
export const batchLabCreateSampleSetRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(BATCH_LAB_MAX_NAME_LENGTH),
    preview_id: uuidSchema,
    preview_digest: digestSchema,
    source_environment: batchLabSourceEnvironmentSchema,
    idempotency_key: uuidSchema,
  })
  .strict();

// 创建样本集请求类型
export type BatchLabCreateSampleSetRequest = z.infer<typeof batchLabCreateSampleSetRequestSchema>;

// 样本集模式
export const batchLabSampleSetSchema = z
  .object({
    id: uuidSchema,
    version: z.number().int().positive().optional(),
    dataset_version_id: uuidSchema.optional(),
    dataset_version_name: z.string().optional(),
    dataset_version_number: z.number().int().positive().optional(),
    name: z.string().min(1).max(BATCH_LAB_MAX_NAME_LENGTH),
    source_environment: batchLabSourceEnvironmentSchema,
    source_preview_id: uuidSchema,
    source_digest: digestSchema,
    sample_count: z.number().int().positive().max(BATCH_LAB_MAX_SAMPLE_LIMIT),
    statistics: batchLabPreviewStatisticsSchema,
    created_at: isoDateTimeSchema,
    deleted_at: isoDateTimeSchema.nullable().optional(),
  })
  .strict();

// 样本集类型
export type BatchLabSampleSet = z.infer<typeof batchLabSampleSetSchema>;

// 样本集响应模式
export const batchLabSampleSetResponseSchema = z
  .object({ success: z.literal(true), data: batchLabSampleSetSchema })
  .strict();

// 样本集列表响应模式
export const batchLabSampleSetListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        items: z.array(batchLabSampleSetSchema),
        next_cursor: z.string().min(1).nullable(),
      })
      .strict(),
  })
  .strict();

export const batchLabSampleSetDetailSchema = batchLabSampleSetSchema
  .extend({
    frozen_sql: z.string().min(1).max(BATCH_LAB_MAX_SQL_LENGTH),
    frozen_parameters: z.record(batchLabSqlParameterValueSchema),
  })
  .strict();
export type BatchLabSampleSetDetail = z.infer<typeof batchLabSampleSetDetailSchema>;

export const batchLabSampleSetDetailResponseSchema = z
  .object({ success: z.literal(true), data: batchLabSampleSetDetailSchema })
  .strict();

export const batchLabSampleSnapshotSchema = batchLabPreviewItemSchema.extend({
  preview_truncated: z.boolean().optional(),
});
export type BatchLabSampleSnapshot = z.infer<typeof batchLabSampleSnapshotSchema>;

export const batchLabSampleSnapshotPageSchema = z
  .object({
    sample_set_id: uuidSchema,
    items: z.array(batchLabSampleSnapshotSchema).max(BATCH_LAB_MAX_SAMPLE_LIMIT),
    next_cursor: z.string().min(1).nullable(),
  })
  .strict();
export type BatchLabSampleSnapshotPage = z.infer<typeof batchLabSampleSnapshotPageSchema>;

export const batchLabSampleSnapshotPageResponseSchema = z
  .object({ success: z.literal(true), data: batchLabSampleSnapshotPageSchema })
  .strict();

export const batchLabDeleteSampleSetRequestSchema = z
  .object({
    sample_set_id: uuidSchema,
    source_environment: batchLabSourceEnvironmentSchema,
  })
  .strict();
export type BatchLabDeleteSampleSetRequest = z.infer<typeof batchLabDeleteSampleSetRequestSchema>;

export const batchLabDeleteSampleSetResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ id: uuidSchema, deleted_at: isoDateTimeSchema }).strict(),
  })
  .strict();

export const batchLabProcessorProtocolSchema = z.enum(['none_v1', 'regex_json_v1']);
export type BatchLabProcessorProtocol = z.infer<typeof batchLabProcessorProtocolSchema>;

export const batchLabRegexRuleSchema = z
  .object({
    pattern: z.string().min(1).max(BATCH_LAB_MAX_PROCESSOR_PATTERN_LENGTH),
    flags: z
      .string()
      .regex(/^[dgimsuy]*$/)
      .max(7)
      .refine((value) => new Set(value).size === value.length, 'regex flags must be unique'),
    replacement: z.string().max(BATCH_LAB_MAX_PROCESSOR_REPLACEMENT_LENGTH),
  })
  .strict();
export type BatchLabRegexRule = z.infer<typeof batchLabRegexRuleSchema>;

export const batchLabProcessorConfigSchema = z.discriminatedUnion('protocol', [
  z.object({ protocol: z.literal('none_v1') }).strict(),
  z
    .object({
      protocol: z.literal('regex_json_v1'),
      rules: z.array(batchLabRegexRuleSchema).max(BATCH_LAB_MAX_PROCESSOR_RULES),
      timeout_ms: z.number().int().min(1).max(BATCH_LAB_PROCESSOR_TIMEOUT_MS),
    })
    .strict(),
]);
export type BatchLabProcessorConfig = z.infer<typeof batchLabProcessorConfigSchema>;

export const batchLabCreateProcessorVersionRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(BATCH_LAB_MAX_NAME_LENGTH),
    config: batchLabProcessorConfigSchema,
    idempotency_key: uuidSchema.optional(),
  })
  .strict();
export type BatchLabCreateProcessorVersionRequest = z.infer<
  typeof batchLabCreateProcessorVersionRequestSchema
>;

export const batchLabProcessorVersionSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(BATCH_LAB_MAX_NAME_LENGTH),
    protocol: batchLabProcessorProtocolSchema,
    config: batchLabProcessorConfigSchema,
    digest: digestSchema,
    created_at: isoDateTimeSchema,
  })
  .strict();
export type BatchLabProcessorVersion = z.infer<typeof batchLabProcessorVersionSchema>;

export const batchLabProcessorVersionListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ items: z.array(batchLabProcessorVersionSchema) }).strict(),
  })
  .strict();

export const batchLabProcessorVersionResponseSchema = z
  .object({ success: z.literal(true), data: batchLabProcessorVersionSchema })
  .strict();

export const batchLabDisplayRendererSchema = z
  .object({
    protocol: z.literal('batch_lab_html_v1'),
    version: z.literal(1),
  })
  .strict();
export type BatchLabDisplayRenderer = z.infer<typeof batchLabDisplayRendererSchema>;

export const batchLabDisplayResultStatusSchema = z.enum([
  'success',
  'failed',
  'timeout',
  'limit_exceeded',
  'validation_error',
]);
export type BatchLabDisplayResultStatus = z.infer<typeof batchLabDisplayResultStatusSchema>;

export const batchLabDisplayResultSchema = z
  .object({
    id: uuidSchema.optional(),
    processor_version_id: uuidSchema,
    processor_digest: digestSchema,
    status: batchLabDisplayResultStatusSchema,
    match_count: countSchema,
    input_text: z.string().max(BATCH_LAB_MAX_PROCESSOR_INPUT_CHARS),
    output_text: z.string().max(BATCH_LAB_MAX_PROCESSOR_OUTPUT_CHARS),
    sanitized_html: z.string().max(BATCH_LAB_MAX_PROCESSOR_OUTPUT_CHARS * 6),
    error_code: batchLabErrorCodeSchema.nullable(),
    renderer: batchLabDisplayRendererSchema,
    created_at: isoDateTimeSchema.optional(),
  })
  .strict();
export type BatchLabDisplayResult = z.infer<typeof batchLabDisplayResultSchema>;

export const batchLabProcessorPreviewRequestSchema = z
  .object({
    processor_version_id: uuidSchema.optional(),
    config: batchLabProcessorConfigSchema.optional(),
    input_text: z.string().max(BATCH_LAB_MAX_PROCESSOR_INPUT_CHARS),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.processor_version_id === undefined) === (value.config === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'provide exactly one of processor_version_id or config',
      });
    }
  });
export type BatchLabProcessorPreviewRequest = z.infer<typeof batchLabProcessorPreviewRequestSchema>;

export const batchLabProcessorPreviewResponseSchema = z
  .object({ success: z.literal(true), data: batchLabDisplayResultSchema })
  .strict();

export const BATCH_LAB_MAX_EXPERIMENT_VARIANTS = 2;
export const BATCH_LAB_MAX_EXPERIMENT_TURNS = 5;
export const BATCH_LAB_MAX_WORKER_CLAIM_LIMIT = 20;

export const batchLabExperimentRunModeSchema = z.enum(['single', 'multi_turn']);
export type BatchLabExperimentRunMode = z.infer<typeof batchLabExperimentRunModeSchema>;

export const batchLabExperimentStatusSchema = z.enum([
  'draft',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export type BatchLabExperimentStatus = z.infer<typeof batchLabExperimentStatusSchema>;

export const batchLabOutputPresetSchema = z
  .object({
    name: z.string().trim().max(BATCH_LAB_MAX_NAME_LENGTH),
    content: z.string().max(BATCH_LAB_MAX_OUTPUT_PRESET_TEXT_LENGTH),
    format: z.string().max(BATCH_LAB_MAX_OUTPUT_PRESET_TEXT_LENGTH),
  })
  .strict();
export type BatchLabOutputPreset = z.infer<typeof batchLabOutputPresetSchema>;

export const batchLabProviderConfigSchema = z
  .object({
    base_url: z.string().trim().max(BATCH_LAB_MAX_PROVIDER_CONFIG_LENGTH),
    key_ref: z.string().trim().max(BATCH_LAB_MAX_PROVIDER_CONFIG_LENGTH),
    module_name: z.string().trim().max(BATCH_LAB_MAX_PROVIDER_CONFIG_LENGTH),
  })
  .strict();
export type BatchLabProviderConfig = z.infer<typeof batchLabProviderConfigSchema>;

export const batchLabExperimentVariantSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    name: z.string().trim().min(1).max(BATCH_LAB_MAX_NAME_LENGTH),
    model_id: z.string().trim().min(1).max(200),
    openrouter_model_id: z.string().trim().min(1).max(200),
    tier: z.enum(['light', 'standard', 'premium']).nullable(),
    is_free: z.boolean(),
    sampling: z.record(z.number().finite()),
    processor_version_id: uuidSchema.nullable(),
    max_turns: z.number().int().min(1).max(BATCH_LAB_MAX_EXPERIMENT_TURNS),
    provider_config: batchLabProviderConfigSchema.optional(),
    output_preset: batchLabOutputPresetSchema.optional(),
  })
  .strict();
export type BatchLabExperimentVariant = z.infer<typeof batchLabExperimentVariantSchema>;

export const batchLabCreateExperimentRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(BATCH_LAB_MAX_NAME_LENGTH),
    sample_set_id: uuidSchema,
    source_environment: batchLabSourceEnvironmentSchema,
    purpose: z.string().trim().max(BATCH_LAB_MAX_PURPOSE_LENGTH).nullable().optional(),
    run_mode: batchLabExperimentRunModeSchema.optional(),
    output_preset: batchLabOutputPresetSchema.optional(),
    provider_config: batchLabProviderConfigSchema.optional(),
    variants: z
      .array(batchLabExperimentVariantSchema)
      .min(2)
      .max(BATCH_LAB_MAX_EXPERIMENT_VARIANTS)
      .refine(
        (variants) => new Set(variants.map((variant) => variant.key)).size === variants.length,
        {
          message: 'variant keys must be unique',
        }
      ),
    idempotency_key: uuidSchema,
  })
  .strict();
export type BatchLabCreateExperimentRequest = z.infer<typeof batchLabCreateExperimentRequestSchema>;

export const batchLabStartExperimentRequestSchema = z
  .object({
    experiment_id: uuidSchema,
    source_environment: batchLabSourceEnvironmentSchema,
    idempotency_key: uuidSchema,
  })
  .strict();
export type BatchLabStartExperimentRequest = z.infer<typeof batchLabStartExperimentRequestSchema>;

export const batchLabStopExperimentRequestSchema = z
  .object({
    experiment_id: uuidSchema,
    source_environment: batchLabSourceEnvironmentSchema,
  })
  .strict();
export type BatchLabStopExperimentRequest = z.infer<typeof batchLabStopExperimentRequestSchema>;

export const batchLabDeleteExperimentRequestSchema = z
  .object({
    experiment_id: uuidSchema,
    source_environment: batchLabSourceEnvironmentSchema,
  })
  .strict();
export type BatchLabDeleteExperimentRequest = z.infer<typeof batchLabDeleteExperimentRequestSchema>;

export const batchLabDeleteExperimentResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ id: uuidSchema, deleted_at: isoDateTimeSchema }).strict(),
  })
  .strict();

export const batchLabExperimentSummarySchema = z
  .object({
    id: uuidSchema,
    sample_set_version: z.number().int().positive().optional(),
    dataset_version_id: uuidSchema.optional(),
    name: z.string().min(1).max(BATCH_LAB_MAX_NAME_LENGTH),
    sample_set_id: uuidSchema,
    source_environment: batchLabSourceEnvironmentSchema,
    status: batchLabExperimentStatusSchema,
    purpose: z.string().max(BATCH_LAB_MAX_PURPOSE_LENGTH).nullable().optional(),
    run_mode: batchLabExperimentRunModeSchema.optional(),
    output_preset: batchLabOutputPresetSchema.optional(),
    provider_config: batchLabProviderConfigSchema.optional(),
    variants: z
      .array(batchLabExperimentVariantSchema)
      .min(2)
      .max(BATCH_LAB_MAX_EXPERIMENT_VARIANTS),
    total_attempts: countSchema,
    completed_attempts: countSchema,
    failed_attempts: countSchema,
    created_at: isoDateTimeSchema,
    started_at: isoDateTimeSchema.nullable(),
    completed_at: isoDateTimeSchema.nullable(),
  })
  .strict();
export type BatchLabExperimentSummary = z.infer<typeof batchLabExperimentSummarySchema>;

export const batchLabExperimentResponseSchema = z
  .object({ success: z.literal(true), data: batchLabExperimentSummarySchema })
  .strict();

export const batchLabExperimentListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        items: z.array(batchLabExperimentSummarySchema),
        next_cursor: z.string().min(1).nullable(),
      })
      .strict(),
  })
  .strict();

export const batchLabExperimentKindSchema = z.enum(['generation', 'reuse_display']);
export type BatchLabExperimentKind = z.infer<typeof batchLabExperimentKindSchema>;

export const batchLabExperimentLineageSchema = z
  .object({
    kind: batchLabExperimentKindSchema,
    source_experiment_id: uuidSchema.nullable(),
    generation_source_experiment_id: uuidSchema.nullable(),
  })
  .strict();
export type BatchLabExperimentLineage = z.infer<typeof batchLabExperimentLineageSchema>;

export const batchLabExperimentDetailSchema = batchLabExperimentSummarySchema
  .extend({
    lineage: batchLabExperimentLineageSchema,
  })
  .strict();
export type BatchLabExperimentDetail = z.infer<typeof batchLabExperimentDetailSchema>;

export const batchLabExperimentDetailResponseSchema = z
  .object({ success: z.literal(true), data: batchLabExperimentDetailSchema })
  .strict();

export const batchLabCopyExperimentRequestSchema = z
  .object({
    source_experiment_id: uuidSchema,
    name: z.string().trim().min(1).max(BATCH_LAB_MAX_NAME_LENGTH),
    purpose: z.string().trim().max(BATCH_LAB_MAX_PURPOSE_LENGTH).nullable().optional(),
    source_environment: batchLabSourceEnvironmentSchema,
    idempotency_key: uuidSchema,
  })
  .strict();
export type BatchLabCopyExperimentRequest = z.infer<typeof batchLabCopyExperimentRequestSchema>;

export const batchLabReuseDisplayExperimentRequestSchema = z
  .object({
    source_experiment_id: uuidSchema,
    name: z.string().trim().min(1).max(BATCH_LAB_MAX_NAME_LENGTH),
    purpose: z.string().trim().max(BATCH_LAB_MAX_PURPOSE_LENGTH).nullable().optional(),
    source_environment: batchLabSourceEnvironmentSchema,
    output_preset: batchLabOutputPresetSchema.optional(),
    provider_config: batchLabProviderConfigSchema.optional(),
    variants: z
      .array(batchLabExperimentVariantSchema)
      .min(2)
      .max(BATCH_LAB_MAX_EXPERIMENT_VARIANTS)
      .refine(
        (variants) => new Set(variants.map((variant) => variant.key)).size === variants.length,
        { message: 'variant keys must be unique' }
      ),
    idempotency_key: uuidSchema,
  })
  .strict();
export type BatchLabReuseDisplayExperimentRequest = z.infer<
  typeof batchLabReuseDisplayExperimentRequestSchema
>;

export const batchLabAnnotationTargetSchema = z
  .object({
    experiment_id: uuidSchema,
    sample_ordinal: z.number().int().nonnegative().nullable(),
    turn_index: z.number().int().min(1).max(BATCH_LAB_MAX_EXPERIMENT_TURNS).nullable(),
  })
  .strict();
export type BatchLabAnnotationTarget = z.infer<typeof batchLabAnnotationTargetSchema>;

export const batchLabAnnotationSchema = batchLabAnnotationTargetSchema
  .extend({
    tag: z.string().trim().max(80).nullable(),
    note: z.string().trim().max(4_000).nullable(),
    updated_at: isoDateTimeSchema,
  })
  .strict();
export type BatchLabAnnotation = z.infer<typeof batchLabAnnotationSchema>;

export const batchLabUpsertAnnotationRequestSchema = batchLabAnnotationTargetSchema
  .extend({
    tag: z.string().trim().max(80).nullable(),
    note: z.string().trim().max(4_000).nullable(),
    source_environment: batchLabSourceEnvironmentSchema,
  })
  .strict();
export type BatchLabUpsertAnnotationRequest = z.infer<typeof batchLabUpsertAnnotationRequestSchema>;

export const batchLabAnnotationResponseSchema = z
  .object({ success: z.literal(true), data: batchLabAnnotationSchema })
  .strict();

export const BATCH_LAB_JSONL_SCHEMA_VERSION = 'batch_lab_jsonl_v1';

export const batchLabExportAttemptSchema = z
  .object({
    attempt_id: uuidSchema,
    variant_key: batchLabExperimentVariantSchema.shape.key,
    turn_index: z.number().int().min(1).max(BATCH_LAB_MAX_EXPERIMENT_TURNS),
    status: z.enum(['pending', 'running', 'succeeded', 'failed', 'blocked', 'unknown']),
    generation_id: z.string().nullable(),
    finish_reason: z.string().nullable(),
    raw_output: z.string().nullable(),
    display_result_id: uuidSchema.nullable(),
    error_code: z.string().nullable(),
    error_message: z.string().nullable(),
  })
  .strict();
export type BatchLabExportAttempt = z.infer<typeof batchLabExportAttemptSchema>;

export const batchLabExportRowSchema = z
  .object({
    schema_version: z.literal(BATCH_LAB_JSONL_SCHEMA_VERSION),
    experiment: batchLabExperimentDetailSchema,
    sample: batchLabPreviewItemSchema.omit({ ordinal: true }).extend({
      ordinal: z.number().int().nonnegative(),
    }),
    attempts: z.array(batchLabExportAttemptSchema),
    annotations: z.array(batchLabAnnotationSchema),
  })
  .strict();
export type BatchLabExportRow = z.infer<typeof batchLabExportRowSchema>;

export const batchLabResultAttemptSchema = batchLabExportAttemptSchema
  .extend({
    sample_ordinal: z.number().int().nonnegative(),
    display_result: batchLabDisplayResultSchema.nullable(),
    preview_truncated: z.boolean().optional(),
  })
  .strict();
export type BatchLabResultAttempt = z.infer<typeof batchLabResultAttemptSchema>;

export const batchLabExperimentProgressSummarySchema = z
  .object({
    total_attempts: countSchema,
    completed_attempts: countSchema,
    failed_attempts: countSchema,
    pending_attempts: countSchema,
    running_attempts: countSchema,
  })
  .strict();
export type BatchLabExperimentProgressSummary = z.infer<
  typeof batchLabExperimentProgressSummarySchema
>;

export const batchLabExperimentResultDetailSchema = z
  .object({
    experiment: batchLabExperimentDetailSchema,
    sample_set: batchLabSampleSetDetailSchema,
    samples: z.array(batchLabSampleSnapshotSchema).max(BATCH_LAB_MAX_SAMPLE_LIMIT),
    attempts: z.array(batchLabResultAttemptSchema),
    annotations: z.array(batchLabAnnotationSchema),
    progress: batchLabExperimentProgressSummarySchema,
    next_sample_cursor: z.string().min(1).nullable(),
  })
  .strict();
export type BatchLabExperimentResultDetail = z.infer<typeof batchLabExperimentResultDetailSchema>;

export const batchLabExperimentResultDetailResponseSchema = z
  .object({ success: z.literal(true), data: batchLabExperimentResultDetailSchema })
  .strict();

export const batchLabRunWorkerRequestSchema = z
  .object({
    source_environment: batchLabSourceEnvironmentSchema,
    worker_id: z.string().trim().min(1).max(120),
    claim_limit: z.number().int().min(1).max(BATCH_LAB_MAX_WORKER_CLAIM_LIMIT),
  })
  .strict();
export type BatchLabRunWorkerRequest = z.infer<typeof batchLabRunWorkerRequestSchema>;

export const batchLabRunExperimentWorkerRequestSchema = batchLabRunWorkerRequestSchema
  .extend({
    experiment_id: uuidSchema,
  })
  .strict();
export type BatchLabRunExperimentWorkerRequest = z.infer<
  typeof batchLabRunExperimentWorkerRequestSchema
>;

export const batchLabRunWorkerResultSchema = z
  .object({
    claimed_count: countSchema,
    completed_count: countSchema,
    failed_count: countSchema,
  })
  .strict();
export type BatchLabRunWorkerResult = z.infer<typeof batchLabRunWorkerResultSchema>;

export const batchLabRunWorkerResponseSchema = z
  .object({ success: z.literal(true), data: batchLabRunWorkerResultSchema })
  .strict();
