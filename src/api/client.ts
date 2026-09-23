import Papa from 'papaparse';
import { BATCH_LAB_CONFIG } from '../../script/config.js';
import {
	BATCH_LAB_JSONL_SCHEMA_VERSION,
	BATCH_LAB_MAX_EXPERIMENT_TURNS,
	BATCH_LAB_MAX_PROCESSOR_INPUT_CHARS,
	BATCH_LAB_MAX_PROCESSOR_OUTPUT_CHARS,
	BATCH_LAB_MAX_SAMPLE_LIMIT,
	type BatchLabAnnotation,
	type BatchLabCopyExperimentRequest,
	type BatchLabCreateExperimentRequest,
	type BatchLabCreateProcessorVersionRequest,
	type BatchLabCreateSampleSetRequest,
	type BatchLabDeleteExperimentRequest,
	type BatchLabDeleteSampleSetRequest,
	type BatchLabDisplayResult,
	type BatchLabExperimentDetail,
	type BatchLabExperimentResultDetail,
	type BatchLabExperimentStatus,
	type BatchLabExperimentSummary,
	type BatchLabExportAttempt,
	type BatchLabExportRow,
	type BatchLabPreview,
	type BatchLabPreviewItem,
	type BatchLabPreviewRequest,
	type BatchLabPreviewStatistics,
	type BatchLabProcessorConfig,
	type BatchLabProcessorPreviewRequest,
	type BatchLabProcessorVersion,
	type BatchLabReuseDisplayExperimentRequest,
	type BatchLabRunExperimentWorkerRequest,
	type BatchLabRunWorkerRequest,
	type BatchLabRunWorkerResult,
	type BatchLabSampleSet,
	type BatchLabSampleSetDetail,
	type BatchLabSampleSnapshot,
	type BatchLabSampleSnapshotPage,
	type BatchLabSqlTemplate,
	type BatchLabStartExperimentRequest,
	type BatchLabStopExperimentRequest,
	type BatchLabUpsertAnnotationRequest,
	type BatchLabContext,
} from '../lib/batch-lab-contracts';

const LEGACY_STORAGE_KEY = 'st-bacth-lab:csv-state:v1';
const DB_NAME = 'st-bacth-lab';
const DB_VERSION = 1;
const DB_STORE = 'state';
const DB_STATE_KEY = 'csv-state-v2';
const LOCAL_SOURCE_ENVIRONMENT = 'test';
const DEFAULT_OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// 模型请求是主要耗时；有限并发可提高吞吐，同时避免瞬间压垮模型供应商。
const MAX_CONCURRENT_MODEL_REQUESTS = 6;

const DEFAULT_SAMPLE_SQL = `SELECT h.id AS source_history_id
FROM experience.chat_history AS h
JOIN experience.chat_sessions AS s ON s.id = h.session_id
JOIN app_core.characters AS c ON c.id = h.character_id
WHERE h.user_input IS NOT NULL
  AND h.model IS NOT NULL
  AND h.turn_index >= :min_turn
  AND h.revision >= 0
  AND s.deleted_at IS NULL
ORDER BY h.created_at DESC`;

const CSV_FILES = {
	annotations: '/data/bacth-lab/annotations.csv',
	displayResults: '/data/bacth-lab/display_results_rows.csv',
	experiments: '/data/bacth-lab/experiments_rows.csv',
	attempts: '/data/bacth-lab/experiment_attempts_rows.csv',
	processors: '/data/bacth-lab/processor_versions_rows.csv',
	previews: '/data/bacth-lab/sample_previews_rows.csv',
	previewItems: '/data/bacth-lab/sample_preview_items_rows.csv',
	sampleSets: '/data/bacth-lab/sample_sets_rows.csv',
	snapshots: '/data/bacth-lab/sample_snapshots_rows.csv',
	templates: '/data/bacth-lab/sql_templates.csv',
	sourceHistory: '/data/resouce/chat_history_rows.csv',
	sourceSessions: '/data/resouce/chat_sessions_rows.csv',
	sourceCharacters: '/data/resouce/characters_rows.csv',
} as const;

type CsvRow = Record<string, string>;
type Message = { role: 'system' | 'user' | 'assistant'; content: string };

export type BatchLabSourceCsvImportResult = {
	history_count: number;
	session_count: number;
	character_count: number;
	previewable_history_count: number;
};

type AttemptRow = {
	id: string;
	experiment_id: string;
	sample_set_id: string;
	sample_ordinal: number;
	variant_key: string;
	turn_index: number;
	status: 'pending' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'unknown';
	lease_owner: string | null;
	lease_expires_at: string | null;
	attempt_count: number;
	max_attempts: number;
	generation_id: string | null;
	finish_reason: string | null;
	raw_output: string | null;
	display_result_id: string | null;
	error_code: string | null;
	error_message: string | null;
	started_at: string | null;
	completed_at: string | null;
	created_at: string;
};

type DisplayResultRow = BatchLabDisplayResult & {
	id: string;
	source_kind?: string | null;
	source_id?: string | null;
	input_digest?: string | null;
	created_at: string;
};

type Tables = {
	annotations: BatchLabAnnotation[];
	displayResults: DisplayResultRow[];
	experiments: BatchLabExperimentSummary[];
	attempts: AttemptRow[];
	processors: BatchLabProcessorVersion[];
	previews: BatchLabPreview[];
	previewItems: Array<BatchLabPreviewItem & { preview_id: string }>;
	sampleSets: BatchLabSampleSetDetail[];
	snapshots: Array<BatchLabSampleSnapshot & { sample_set_id: string }>;
	templates: BatchLabSqlTemplate[];
	sourceHistory: CsvRow[];
	sourceSessions: CsvRow[];
	sourceCharacters: CsvRow[];
};

type PersistedTables = Omit<Tables, 'previews' | 'previewItems' | 'templates'>;

let tablesPromise: Promise<Tables> | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

export type BatchLabClientErrorKind =
	| 'configuration'
	| 'cancelled'
	| 'timeout'
	| 'network'
	| 'http'
	| 'protocol';

export class BatchLabClientError extends Error {
	constructor(
		readonly kind: BatchLabClientErrorKind,
		message: string,
		readonly code?: string,
		readonly status?: number
	) {
		super(message);
		this.name = 'BatchLabClientError';
	}
}

export function newIdempotencyKey(): string {
	return globalThis.crypto?.randomUUID?.() ?? `batch-lab-${Date.now()}-${Math.random()}`;
}

export async function getBatchLabContext(_signal?: AbortSignal): Promise<BatchLabContext> {
	return {
		backend_environment: 'development',
		source_environment: LOCAL_SOURCE_ENVIRONMENT,
		capabilities: {
			sample_preview: true,
			experiment_execution: true,
		},
	};
}

export async function listBatchLabSqlTemplates(
	_signal?: AbortSignal
): Promise<BatchLabSqlTemplate[]> {
	return (await loadTables()).templates;
}

export async function listBatchLabProcessors(
	_signal?: AbortSignal
): Promise<BatchLabProcessorVersion[]> {
	return (await loadTables()).processors;
}

export async function createBatchLabProcessor(
	input: BatchLabCreateProcessorVersionRequest,
	_signal?: AbortSignal
): Promise<BatchLabProcessorVersion> {
	const tables = await loadTables();
	const processor: BatchLabProcessorVersion = {
		id: newIdempotencyKey(),
		name: input.name,
		protocol: input.config.protocol,
		config: input.config,
		digest: await digestJson(input.config),
		created_at: now(),
	};
	tables.processors.unshift(processor);
	persistTables(tables);
	return processor;
}

export async function previewBatchLabProcessor(
	input: BatchLabProcessorPreviewRequest,
	_signal?: AbortSignal
): Promise<BatchLabDisplayResult> {
	const tables = await loadTables();
	const processor =
		input.processor_version_id === undefined
			? {
					id: newIdempotencyKey(),
					digest: await digestJson(input.config),
					config: requireConfig(input.config),
			  }
			: tables.processors.find(item => item.id === input.processor_version_id);
	if (!processor) throw clientError('BATCH_LAB_PROCESSOR_NOT_FOUND', '后处理版本不存在');
	return runPostprocessor(processor, input.input_text);
}

export async function createBatchLabPreview(
	input: BatchLabPreviewRequest,
	_signal?: AbortSignal
): Promise<BatchLabPreview> {
	const tables = await loadTables();
	const { items, statistics } = await buildPreviewItems(input.sample_limit, input.parameters);
	if (items.length === 0) {
		throw clientError(
			'BATCH_LAB_EMPTY_PREVIEW',
			`没有可用样本。请确认 ${CSV_FILES.sourceHistory} 已放入 data/resouce，或导入已有样本快照 CSV。`
		);
	}
	const digest = await digestJson({
		source_environment: LOCAL_SOURCE_ENVIRONMENT,
		sql: input.sql,
		parameters: input.parameters,
		sample_limit: input.sample_limit,
		ids: items.map(item => item.source_history_id),
	});
	const preview: BatchLabPreview = {
		id: newIdempotencyKey(),
		digest,
		source_environment: LOCAL_SOURCE_ENVIRONMENT,
		final_sql: input.sql,
		parameters: input.parameters,
		sample_limit: input.sample_limit,
		statistics,
		items,
		created_at: now(),
		expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
	};
	tables.previews.unshift(preview);
	tables.previewItems = [
		...items.map(item => ({ ...item, preview_id: preview.id })),
		...tables.previewItems.filter(item => item.preview_id !== preview.id),
	];
	return preview;
}

export async function createBatchLabSampleSet(
	input: BatchLabCreateSampleSetRequest,
	_signal?: AbortSignal
): Promise<BatchLabSampleSet> {
	const tables = await loadTables();
	const preview = tables.previews.find(item => item.id === input.preview_id);
	if (!preview || preview.digest !== input.preview_digest) {
		throw clientError('BATCH_LAB_PREVIEW_NOT_FOUND', '预览不存在或摘要不匹配');
	}
	const sampleSet: BatchLabSampleSetDetail = {
		id: newIdempotencyKey(),
		name: input.name,
		source_environment: LOCAL_SOURCE_ENVIRONMENT,
		source_preview_id: preview.id,
		source_digest: preview.digest,
		sample_count: preview.items.length,
		statistics: preview.statistics,
		frozen_sql: preview.final_sql,
		frozen_parameters: preview.parameters,
		created_at: now(),
		deleted_at: null,
	};
	tables.sampleSets.unshift(sampleSet);
	tables.snapshots = [
		...preview.items.map(item => ({ ...item, sample_set_id: sampleSet.id })),
		...tables.snapshots.filter(item => item.sample_set_id !== sampleSet.id),
	];
	persistTables(tables);
	return sampleSet;
}

export async function listBatchLabSampleSets(_signal?: AbortSignal): Promise<BatchLabSampleSet[]> {
	return (await loadTables()).sampleSets.filter(item => !item.deleted_at);
}

export async function getBatchLabSampleSet(
	sampleSetId: string,
	_signal?: AbortSignal
): Promise<BatchLabSampleSetDetail> {
	const sampleSet = (await loadTables()).sampleSets.find(item => item.id === sampleSetId);
	if (!sampleSet) throw clientError('BATCH_LAB_SAMPLE_SET_NOT_FOUND', '样本集不存在');
	return sampleSet;
}

export async function listBatchLabSampleSetSamples(
	sampleSetId: string,
	input: { cursor?: string | null; limit?: number } = {},
	_signal?: AbortSignal
): Promise<BatchLabSampleSnapshotPage> {
	const offset = input.cursor ? Number(input.cursor) : 0;
	const limit = input.limit ?? BATCH_LAB_MAX_SAMPLE_LIMIT;
	const all = (await loadTables()).snapshots
		.filter(item => item.sample_set_id === sampleSetId)
		.sort((a, b) => a.ordinal - b.ordinal);
	const items = all.slice(offset, offset + limit);
	const next = offset + limit < all.length ? String(offset + limit) : null;
	return { sample_set_id: sampleSetId, items, next_cursor: next };
}

export async function deleteBatchLabSampleSet(
	input: BatchLabDeleteSampleSetRequest,
	_signal?: AbortSignal
): Promise<{ id: string; deleted_at: string }> {
	const tables = await loadTables();
	const sampleSet = tables.sampleSets.find(item => item.id === input.sample_set_id);
	if (!sampleSet) throw clientError('BATCH_LAB_SAMPLE_SET_NOT_FOUND', '样本集不存在');
	if (tables.experiments.some(item => item.sample_set_id === sampleSet.id && !isDeleted(item))) {
		throw clientError('BATCH_LAB_SAMPLE_SET_IN_USE', '样本集已被实验使用，不能归档');
	}
	sampleSet.deleted_at = now();
	persistTables(tables);
	return { id: sampleSet.id, deleted_at: sampleSet.deleted_at };
}

export async function listBatchLabExperiments(
	_signal?: AbortSignal
): Promise<BatchLabExperimentSummary[]> {
	return (await loadTables()).experiments
		.filter(item => !isDeleted(item))
		.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function createBatchLabExperiment(
	input: BatchLabCreateExperimentRequest,
	_signal?: AbortSignal
): Promise<BatchLabExperimentSummary> {
	const tables = await loadTables();
	const sampleSet = tables.sampleSets.find(item => item.id === input.sample_set_id);
	if (!sampleSet) throw clientError('BATCH_LAB_SAMPLE_SET_NOT_FOUND', '样本集不存在');
	const experiment: BatchLabExperimentSummary = {
		id: newIdempotencyKey(),
		name: input.name,
		sample_set_id: input.sample_set_id,
		source_environment: LOCAL_SOURCE_ENVIRONMENT,
		status: 'draft',
		purpose: input.purpose ?? null,
		run_mode: input.run_mode ?? 'single',
		output_preset: input.output_preset,
		provider_config: input.provider_config,
		variants: input.variants,
		total_attempts: 0,
		completed_attempts: 0,
		failed_attempts: 0,
		created_at: now(),
		started_at: null,
		completed_at: null,
	};
	tables.experiments.unshift(experiment);
	persistTables(tables);
	return experiment;
}

export async function getBatchLabExperiment(
	experimentId: string,
	_signal?: AbortSignal
): Promise<BatchLabExperimentDetail> {
	return toExperimentDetail(await requireExperiment(experimentId));
}

export async function getBatchLabExperimentResults(
	experimentId: string,
	input: { cursor?: string | null; limit?: number } = {},
	_signal?: AbortSignal
): Promise<BatchLabExperimentResultDetail> {
	const tables = await loadTables();
	const experiment = await requireExperiment(experimentId);
	const sampleSet = tables.sampleSets.find(item => item.id === experiment.sample_set_id);
	if (!sampleSet) throw clientError('BATCH_LAB_SAMPLE_SET_NOT_FOUND', '样本集不存在');
	const samplePage = await listBatchLabSampleSetSamples(sampleSet.id, input);
	const sampleOrdinals = new Set(samplePage.items.map(item => item.ordinal));
	const displayById = new Map(tables.displayResults.map(item => [item.id, item]));
	const attempts = tables.attempts
		.filter(item => item.experiment_id === experiment.id && sampleOrdinals.has(item.sample_ordinal))
		.map(item => ({
			attempt_id: item.id,
			variant_key: item.variant_key,
			turn_index: item.turn_index,
			status: item.status,
			generation_id: item.generation_id,
			finish_reason: item.finish_reason,
			raw_output: item.raw_output,
			display_result_id: item.display_result_id,
			error_code: item.error_code,
			error_message: item.error_message,
			sample_ordinal: item.sample_ordinal,
			display_result: item.display_result_id
				? displayById.get(item.display_result_id) ?? null
				: null,
		}));
	const experimentAttempts = tables.attempts.filter(item => item.experiment_id === experiment.id);
	return {
		experiment: toExperimentDetail(experiment),
		sample_set: sampleSet,
		samples: samplePage.items,
		attempts,
		annotations: tables.annotations.filter(item => item.experiment_id === experiment.id),
		progress: {
			total_attempts: experimentAttempts.length,
			completed_attempts: experimentAttempts.filter(item => item.status === 'succeeded').length,
			failed_attempts: experimentAttempts.filter(item => item.status === 'failed').length,
			pending_attempts: experimentAttempts.filter(item => item.status === 'pending').length,
			running_attempts: experimentAttempts.filter(item => item.status === 'running').length,
		},
		next_sample_cursor: samplePage.next_cursor,
	};
}

export async function copyBatchLabExperiment(
	input: BatchLabCopyExperimentRequest,
	_signal?: AbortSignal
): Promise<BatchLabExperimentSummary> {
	const source = await requireExperiment(input.source_experiment_id);
	return createBatchLabExperiment({
		name: input.name,
		purpose: input.purpose ?? source.purpose ?? null,
		sample_set_id: source.sample_set_id,
		source_environment: LOCAL_SOURCE_ENVIRONMENT,
		run_mode: source.run_mode,
		output_preset: source.output_preset,
		provider_config: source.provider_config,
		variants: source.variants,
		idempotency_key: input.idempotency_key,
	});
}

export async function createBatchLabReuseDisplayExperiment(
	input: BatchLabReuseDisplayExperimentRequest,
	_signal?: AbortSignal
): Promise<BatchLabExperimentSummary> {
	const source = await requireExperiment(input.source_experiment_id);
	const created = await createBatchLabExperiment({
		name: input.name,
		purpose: input.purpose ?? source.purpose ?? null,
		sample_set_id: source.sample_set_id,
		source_environment: LOCAL_SOURCE_ENVIRONMENT,
		run_mode: source.run_mode,
		output_preset: input.output_preset,
		provider_config: input.provider_config,
		variants: input.variants,
		idempotency_key: input.idempotency_key,
	});
	(
		created as BatchLabExperimentSummary & {
			kind?: string;
			source_experiment_id?: string;
			generation_source_experiment_id?: string;
		}
	).kind = 'reuse_display';
	(created as BatchLabExperimentSummary & { source_experiment_id?: string }).source_experiment_id =
		source.id;
	(
		created as BatchLabExperimentSummary & { generation_source_experiment_id?: string }
	).generation_source_experiment_id = source.id;
	const tables = await loadTables();
	persistTables(tables);
	return created;
}

export async function upsertBatchLabAnnotation(
	input: BatchLabUpsertAnnotationRequest,
	_signal?: AbortSignal
): Promise<BatchLabAnnotation> {
	const tables = await loadTables();
	const existing = tables.annotations.find(
		item =>
			item.experiment_id === input.experiment_id &&
			item.sample_ordinal === input.sample_ordinal &&
			item.turn_index === input.turn_index
	);
	const annotation: BatchLabAnnotation = {
		experiment_id: input.experiment_id,
		sample_ordinal: input.sample_ordinal,
		turn_index: input.turn_index,
		tag: input.tag,
		note: input.note,
		updated_at: now(),
	};
	if (existing) Object.assign(existing, annotation);
	else tables.annotations.push(annotation);
	persistTables(tables);
	return annotation;
}

export async function downloadBatchLabExperimentJsonl(
	experimentId: string,
	_signal?: AbortSignal
): Promise<Blob> {
	const rows = await buildExportRows(experimentId);
	return new Blob([rows.map(row => JSON.stringify(row)).join('\n') + '\n'], {
		type: 'application/x-ndjson',
	});
}

export async function startBatchLabExperiment(
	input: BatchLabStartExperimentRequest,
	_signal?: AbortSignal
): Promise<BatchLabExperimentSummary> {
	const tables = await loadTables();
	const experiment = tables.experiments.find(item => item.id === input.experiment_id);
	if (!experiment) throw clientError('BATCH_LAB_EXPERIMENT_NOT_FOUND', '实验不存在');
	if (experiment.status !== 'draft' && experiment.status !== 'queued') return experiment;
	const samples = tables.snapshots.filter(item => item.sample_set_id === experiment.sample_set_id);
	const existing = tables.attempts.some(item => item.experiment_id === experiment.id);
	if (!existing) {
		for (const sample of samples) {
			for (const variant of experiment.variants) {
				const turns = Math.min(variant.max_turns, BATCH_LAB_MAX_EXPERIMENT_TURNS);
				for (let turnIndex = 1; turnIndex <= turns; turnIndex += 1) {
					tables.attempts.push({
						id: newIdempotencyKey(),
						experiment_id: experiment.id,
						sample_set_id: experiment.sample_set_id,
						sample_ordinal: sample.ordinal,
						variant_key: variant.key,
						turn_index: turnIndex,
						status: 'pending',
						lease_owner: null,
						lease_expires_at: null,
						attempt_count: 0,
						max_attempts: 2,
						generation_id: null,
						finish_reason: null,
						raw_output: null,
						display_result_id: null,
						error_code: null,
						error_message: null,
						started_at: null,
						completed_at: null,
						created_at: now(),
					});
				}
			}
		}
	}
	experiment.status = 'queued';
	experiment.started_at = experiment.started_at ?? now();
	refreshExperimentCounts(tables, experiment.id);
	persistTables(tables);
	return experiment;
}

export async function stopBatchLabExperiment(
	input: BatchLabStopExperimentRequest,
	_signal?: AbortSignal
): Promise<BatchLabExperimentSummary> {
	const tables = await loadTables();
	const experiment = tables.experiments.find(item => item.id === input.experiment_id);
	if (!experiment) throw clientError('BATCH_LAB_EXPERIMENT_NOT_FOUND', '实验不存在');
	if (experiment.status === 'queued' || experiment.status === 'running') {
		experiment.status = 'cancelled';
		experiment.completed_at = now();
		persistTables(tables);
	}
	return experiment;
}

export async function deleteBatchLabExperiment(
	input: BatchLabDeleteExperimentRequest,
	_signal?: AbortSignal
): Promise<{ id: string; deleted_at: string }> {
	const tables = await loadTables();
	const experiment = tables.experiments.find(item => item.id === input.experiment_id);
	if (!experiment) throw clientError('BATCH_LAB_EXPERIMENT_NOT_FOUND', '实验不存在');
	if (experiment.status === 'queued' || experiment.status === 'running') {
		throw clientError('BATCH_LAB_EXPERIMENT_STATE_CONFLICT', '运行中的实验需要先停止');
	}
	(experiment as BatchLabExperimentSummary & { deleted_at?: string }).deleted_at = now();
	const deletedAt = (experiment as BatchLabExperimentSummary & { deleted_at: string }).deleted_at;
	persistTables(tables);
	return { id: experiment.id, deleted_at: deletedAt };
}

export async function runBatchLabWorkerOnce(
	input: BatchLabRunWorkerRequest,
	_signal?: AbortSignal
): Promise<BatchLabRunWorkerResult> {
	return claimAndRun(input.worker_id, input.claim_limit);
}

export async function runBatchLabExperimentWorkerOnce(
	input: BatchLabRunExperimentWorkerRequest,
	_signal?: AbortSignal
): Promise<BatchLabRunWorkerResult> {
	return claimAndRun(input.worker_id, input.claim_limit, input.experiment_id);
}

export async function exportBatchLabCsvBundle(): Promise<void> {
	const tables = await loadTables();
	const files: Record<string, unknown[]> = {
		'annotations.csv': tables.annotations,
		'display_results_rows.csv': tables.displayResults,
		'experiments_rows.csv': tables.experiments,
		'experiment_attempts_rows.csv': tables.attempts,
		'processor_versions_rows.csv': tables.processors,
		'sample_previews_rows.csv': tables.previews,
		'sample_preview_items_rows.csv': tables.previewItems,
		'sample_sets_rows.csv': tables.sampleSets,
		'sample_snapshots_rows.csv': tables.snapshots,
		'sql_templates.csv': tables.templates,
	};
	for (const [name, rows] of Object.entries(files)) {
		downloadBlob(
			new Blob([Papa.unparse(rows.map(flattenRow))], { type: 'text/csv;charset=utf-8' }),
			name
		);
		await new Promise(resolve => setTimeout(resolve, 100));
	}
}

export async function importBatchLabSourceCsvFiles(input: {
	historyFile: File;
	sessionsFile: File;
	charactersFile: File;
}): Promise<BatchLabSourceCsvImportResult> {
	const [sourceHistory, sourceSessions, sourceCharacters] = await Promise.all([
		parseCsvFile(input.historyFile, 'chat_history_rows.csv'),
		parseCsvFile(input.sessionsFile, 'chat_sessions_rows.csv'),
		parseCsvFile(input.charactersFile, 'characters_rows.csv'),
	]);

	requireCsvColumns(sourceHistory, input.historyFile.name, [
		['id'],
		['session_id', 'source_session_id'],
		['character_id', 'source_character_id'],
		['user_input'],
		['model', 'original_model'],
	]);
	requireCsvColumns(sourceSessions, input.sessionsFile.name, [['id']]);
	requireCsvColumns(sourceCharacters, input.charactersFile.name, [['id']]);

	const tables = await loadTables();
	tables.sourceHistory = sourceHistory;
	tables.sourceSessions = sourceSessions;
	tables.sourceCharacters = sourceCharacters;
	tables.previews = [];
	tables.previewItems = [];
	persistTables(tables);

	return {
		history_count: sourceHistory.length,
		session_count: sourceSessions.length,
		character_count: sourceCharacters.length,
		previewable_history_count: countPreviewableSourceRows(
			sourceHistory,
			sourceSessions,
			sourceCharacters
		),
	};
}

async function claimAndRun(
	workerId: string,
	claimLimit: number,
	experimentId?: string
): Promise<BatchLabRunWorkerResult> {
	const tables = await loadTables();
	const candidates = selectRunnableAttempts(tables.attempts, claimLimit, experimentId);
	let completed = 0;
	let failed = 0;

	// 批量领取后统一持久化，避免每条任务重复写入完整 IndexedDB 快照。
	for (const attempt of candidates) {
		attempt.status = 'running';
		attempt.lease_owner = workerId;
		attempt.started_at = now();
		attempt.attempt_count += 1;
	}
	for (const claimedExperimentId of new Set(candidates.map(item => item.experiment_id))) {
		refreshExperimentCounts(tables, claimedExperimentId);
	}
	if (candidates.length > 0) persistTables(tables);

	await runWithConcurrency(candidates, MAX_CONCURRENT_MODEL_REQUESTS, async attempt => {
		try {
			await runAttempt(tables, attempt);
			completed += 1;
		} catch (error) {
			attempt.status = 'failed';
			attempt.error_code =
				error instanceof BatchLabClientError ? error.code ?? error.kind : 'error';
			attempt.error_message = error instanceof Error ? error.message : 'unknown error';
			attempt.completed_at = now();
			// 当前轮失败后，依赖其输出的后续轮次不再具备可执行条件。
			for (const dependent of tables.attempts) {
				if (
					dependent.status === 'pending' &&
					dependent.experiment_id === attempt.experiment_id &&
					dependent.sample_ordinal === attempt.sample_ordinal &&
					dependent.variant_key === attempt.variant_key &&
					dependent.turn_index > attempt.turn_index
				) {
					dependent.status = 'blocked';
					dependent.error_code = 'PREVIOUS_TURN_FAILED';
					dependent.error_message = '前一轮执行失败，后续轮次已跳过';
					dependent.completed_at = now();
				}
			}
			failed += 1;
		}
	});

	for (const claimedExperimentId of new Set(candidates.map(item => item.experiment_id))) {
		refreshExperimentCounts(tables, claimedExperimentId);
	}
	if (candidates.length > 0) persistTables(tables);
	return { claimed_count: candidates.length, completed_count: completed, failed_count: failed };
}

function selectRunnableAttempts(
	attempts: AttemptRow[],
	claimLimit: number,
	experimentId?: string
): AttemptRow[] {
	const selected: AttemptRow[] = [];
	const selectedChains = new Set<string>();

	for (const attempt of attempts) {
		if (attempt.status !== 'pending' || (experimentId && attempt.experiment_id !== experimentId)) {
			continue;
		}

		// 后续轮次依赖前一轮输出，同一样本和变体每批只执行一个轮次。
		const chainKey = `${attempt.experiment_id}:${attempt.sample_ordinal}:${attempt.variant_key}`;
		if (selectedChains.has(chainKey)) continue;
		const hasUnfinishedPreviousTurn = attempts.some(
			item =>
				item.experiment_id === attempt.experiment_id &&
				item.sample_ordinal === attempt.sample_ordinal &&
				item.variant_key === attempt.variant_key &&
				item.turn_index < attempt.turn_index &&
				item.status !== 'succeeded'
		);
		if (hasUnfinishedPreviousTurn) continue;

		selected.push(attempt);
		selectedChains.add(chainKey);
		if (selected.length >= claimLimit) break;
	}
	return selected;
}

async function runWithConcurrency<T>(
	items: T[],
	concurrency: number,
	run: (item: T) => Promise<void>
): Promise<void> {
	let nextIndex = 0;
	const workerCount = Math.min(concurrency, items.length);
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			for (;;) {
				const index = nextIndex;
				nextIndex += 1;
				if (index >= items.length) return;
				await run(items[index]);
			}
		})
	);
}

async function runAttempt(tables: Tables, attempt: AttemptRow): Promise<void> {
	const experiment = tables.experiments.find(item => item.id === attempt.experiment_id);
	if (!experiment) throw clientError('BATCH_LAB_EXPERIMENT_NOT_FOUND', '实验不存在');
	const variant = experiment.variants.find(item => item.key === attempt.variant_key);
	const sample = tables.snapshots.find(
		item => item.sample_set_id === attempt.sample_set_id && item.ordinal === attempt.sample_ordinal
	);
	if (!variant || !sample)
		throw clientError('BATCH_LAB_EXPERIMENT_VALIDATION_ERROR', '实验上下文不完整');
	const previousOutputs = tables.attempts
		.filter(
			item =>
				item.experiment_id === experiment.id &&
				item.sample_ordinal === sample.ordinal &&
				item.variant_key === variant.key &&
				item.turn_index < attempt.turn_index &&
				item.status === 'succeeded' &&
				item.raw_output
		)
		.sort((a, b) => a.turn_index - b.turn_index)
		.map(item => item.raw_output as string);
	const messages = buildAttemptMessages(
		sample.history,
		previousOutputs,
		sample.user_input,
		variant.output_preset
	);
	const content = await executeModelRequest({
		baseUrl: variant.provider_config?.base_url || DEFAULT_OPENROUTER_URL,
		model: variant.provider_config?.module_name || variant.openrouter_model_id,
		messages,
	});
	const displayResultId = await createDisplayResult(
		tables,
		variant.processor_version_id,
		attempt.id,
		content
	);
	attempt.status = 'succeeded';
	attempt.generation_id = newIdempotencyKey();
	attempt.finish_reason = 'stop';
	attempt.raw_output = content;
	attempt.display_result_id = displayResultId;
	attempt.error_code = null;
	attempt.error_message = null;
	attempt.completed_at = now();
}

async function createDisplayResult(
	tables: Tables,
	processorVersionId: string | null,
	attemptId: string,
	rawOutput: string
): Promise<string | null> {
	if (!processorVersionId) return null;
	const processor = tables.processors.find(item => item.id === processorVersionId);
	if (!processor) return null;
	const result = await runPostprocessor(processor, rawOutput);
	const stored: DisplayResultRow = {
		...result,
		id: newIdempotencyKey(),
		source_kind: 'experiment_attempt',
		source_id: attemptId,
		input_digest: await digestText(rawOutput),
		created_at: now(),
	};
	tables.displayResults.push(stored);
	return stored.id;
}

async function executeModelRequest(input: {
	baseUrl: string;
	model: string;
	messages: Message[];
}): Promise<string> {
	const apiKey = readModelApiKey();
	const response = await fetch(normalizeChatCompletionsUrl(input.baseUrl), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
			'HTTP-Referer': globalThis.location?.origin ?? 'https://st-bacth-lab.local',
			'X-Title': 'ST Batch Lab',
		},
		body: JSON.stringify({
			model: input.model,
			messages: input.messages,
			stream: false,
		}),
	});
	const payload: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const message =
			isRecord(payload) && typeof payload.error === 'object'
				? JSON.stringify(payload.error)
				: response.statusText;
		throw new BatchLabClientError(
			'http',
			`模型请求失败：${message}`,
			'MODEL_HTTP_ERROR',
			response.status
		);
	}
	const content = readPath(payload, ['choices', 0, 'message', 'content']);
	if (typeof content !== 'string') {
		throw new BatchLabClientError('protocol', '模型响应缺少 choices[0].message.content');
	}
	return content;
}

function buildAttemptMessages(
	baseHistory: Message[],
	previousOutputs: string[],
	userInput: string,
	outputPreset?: { content?: string; format?: string } | null
): Message[] {
	const presetParts = [
		outputPreset?.content?.trim() ? `内容要求：${outputPreset.content.trim()}` : null,
		outputPreset?.format?.trim() ? `格式要求：${outputPreset.format.trim()}` : null,
	].filter((value): value is string => value !== null);
	return [
		...(presetParts.length
			? [
					{
						role: 'system' as const,
						content: `请严格遵循本次 Batch Lab 输出预设。\n${presetParts.join('\n')}`,
					},
			  ]
			: []),
		...baseHistory,
		...previousOutputs.map(content => ({ role: 'assistant' as const, content })),
		{ role: 'user', content: userInput },
	];
}

async function buildPreviewItems(
	sampleLimit: number,
	parameters: Record<string, unknown>
): Promise<{ items: BatchLabPreviewItem[]; statistics: BatchLabPreviewStatistics }> {
	const tables = await loadTables();
	const historyRows = tables.sourceHistory;
	if (historyRows.length > 0) {
		const minTurn = Number(parameters.min_turn ?? 1);
		const sessions = new Set(
			tables.sourceSessions.filter(row => !row.deleted_at).map(row => row.id)
		);
		const characters = new Map(tables.sourceCharacters.map(row => [row.id, row]));
		const candidates = historyRows
			.filter(
				row =>
					row.user_input &&
					(row.model || row.original_model) &&
					Number(row.turn_index || 0) >= minTurn
			)
			.slice(0, sampleLimit);
		const items = candidates
			.map((row, ordinal) => toPreviewItemFromHistory(row, ordinal, sessions, characters))
			.filter((item): item is BatchLabPreviewItem => item !== null);
		return { items, statistics: buildStatistics(items, sampleLimit, candidates.length, false) };
	}

	const existing = tables.snapshots
		.filter(item => item.source_history_id)
		.slice(0, sampleLimit)
		.map((item, ordinal) => ({ ...item, ordinal }));
	return {
		items: existing,
		statistics: buildStatistics(existing, sampleLimit, existing.length, false),
	};
}

function toPreviewItemFromHistory(
	row: CsvRow,
	ordinal: number,
	validSessions: Set<string>,
	characterById: Map<string, CsvRow>
): BatchLabPreviewItem | null {
	const sessionId = row.session_id || row.source_session_id;
	const characterId = row.character_id || row.source_character_id;
	if (!row.id || !sessionId || !validSessions.has(sessionId) || !characterId) return null;
	const character = characterById.get(characterId);
	if (!character) return null;
	const history = parseJson(row.history, []) as Message[];
	if (!Array.isArray(history)) return null;
	return {
		ordinal,
		source_history_id: row.id,
		source_session_id: sessionId,
		source_user_id: row.user_id || row.source_user_id || '',
		source_character_id: characterId,
		turn_index: Number(row.turn_index || 1),
		revision: Number(row.revision || 0),
		user_input: row.user_input,
		original_assistant_reply: row.assistant_reply || row.original_assistant_reply || null,
		original_model: row.model || row.original_model || 'unknown',
		history,
		character_snapshot: character,
		dynamic_input_snapshot: {
			context_window_start_turn: row.context_window_start_turn
				? Number(row.context_window_start_turn)
				: 1,
			source_status: row.status || 'unknown',
		},
		restoration_strategy: 'exact_prompt_snapshot',
	};
}

function buildStatistics(
	items: BatchLabPreviewItem[],
	requested: number,
	candidates: number,
	truncated: boolean
): BatchLabPreviewStatistics {
	return {
		requested_count: requested,
		candidate_count: candidates,
		valid_count: items.length,
		user_count: new Set(items.map(item => item.source_user_id)).size,
		session_count: new Set(items.map(item => item.source_session_id)).size,
		character_count: new Set(items.map(item => item.source_character_id)).size,
		excluded_by_reason: {},
		truncated,
		snapshot_bytes: new Blob([JSON.stringify(items)]).size,
	};
}

async function runPostprocessor(
	processor: Pick<BatchLabProcessorVersion, 'id' | 'digest' | 'config'>,
	inputText: string
): Promise<BatchLabDisplayResult> {
	if (inputText.length > BATCH_LAB_MAX_PROCESSOR_INPUT_CHARS) {
		return processorFailure(
			processor,
			inputText,
			'limit_exceeded',
			'BATCH_LAB_PROCESSOR_LIMIT_EXCEEDED'
		);
	}
	let output = inputText;
	let matchCount = 0;
	try {
		if (processor.config.protocol === 'regex_json_v1') {
			for (const rule of processor.config.rules) {
				const flags = rule.flags || 'g';
				const regex = new RegExp(rule.pattern, flags);
				const counter = new RegExp(rule.pattern, flags.includes('g') ? flags : `${flags}g`);
				matchCount += [...output.matchAll(counter)].length;
				output = output.replace(regex, rule.replacement);
			}
		}
	} catch {
		return processorFailure(processor, inputText, 'failed', 'BATCH_LAB_PROCESSOR_RUNTIME_ERROR');
	}
	if (output.length > BATCH_LAB_MAX_PROCESSOR_OUTPUT_CHARS) {
		return processorFailure(
			processor,
			inputText,
			'limit_exceeded',
			'BATCH_LAB_PROCESSOR_LIMIT_EXCEEDED'
		);
	}
	return {
		processor_version_id: processor.id,
		processor_digest: processor.digest,
		status: 'success',
		match_count: matchCount,
		input_text: inputText,
		output_text: output,
		sanitized_html: renderSafeHtml(output),
		error_code: null,
		renderer: { protocol: 'batch_lab_html_v1', version: 1 },
	};
}

function processorFailure(
	processor: Pick<BatchLabProcessorVersion, 'id' | 'digest'>,
	inputText: string,
	status: Exclude<BatchLabDisplayResult['status'], 'success'>,
	errorCode: BatchLabDisplayResult['error_code']
): BatchLabDisplayResult {
	return {
		processor_version_id: processor.id,
		processor_digest: processor.digest,
		status,
		match_count: 0,
		input_text: inputText,
		output_text: inputText,
		sanitized_html: renderSafeHtml(inputText),
		error_code: errorCode,
		renderer: { protocol: 'batch_lab_html_v1', version: 1 },
	};
}

function renderSafeHtml(text: string): string {
	const statusBlocks: string[] = [];
	const memoryBlocks: string[] = [];
	const bodyText = text
		.replace(/\[status\]([\s\S]*?)\[\/status\]/gi, (_match, content: string) => {
			statusBlocks.push(content.trim());
			return '\n';
		})
		.replace(/\[memory\]([\s\S]*?)\[\/memory\]/gi, (_match, content: string) => {
			memoryBlocks.push(content.trim());
			return '\n';
		})
		.trim();
	const bodyHtml = bodyText
		? `<div class="batch-lab-message-text">${renderParagraphs(bodyText)}</div>`
		: '';
	const statusHtml = statusBlocks
		.filter(Boolean)
		.map(
			value =>
				`<section class="batch-lab-status-block"><strong>当前状态</strong>${renderLines(
					value
				)}</section>`
		)
		.join('');
	const memoryHtml = memoryBlocks
		.filter(Boolean)
		.map(
			value =>
				`<details class="batch-lab-memory-block"><summary>记忆</summary><div>${renderParagraphs(
					value
				)}</div></details>`
		)
		.join('');
	return `<div class="batch-lab-message-render">${bodyHtml}${statusHtml}${memoryHtml}</div>`;
}

function renderParagraphs(text: string): string {
	return text
		.split(/\n{2,}/)
		.map(paragraph => paragraph.trim())
		.filter(Boolean)
		.map(paragraph => `<p>${renderLines(paragraph)}</p>`)
		.join('');
}

function renderLines(text: string): string {
	return escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>');
}

async function loadTables(): Promise<Tables> {
	if (!tablesPromise) tablesPromise = loadInitialTables();
	return tablesPromise;
}

async function loadInitialTables(): Promise<Tables> {
	const seeded: Tables = {
		annotations: (await readCsvOptional(CSV_FILES.annotations)).map(parseAnnotation),
		displayResults: (await readCsvOptional(CSV_FILES.displayResults)).map(parseDisplayResult),
		experiments: (await readCsvOptional(CSV_FILES.experiments)).map(parseExperiment),
		attempts: (await readCsvOptional(CSV_FILES.attempts)).map(parseAttempt),
		processors: (await readCsvOptional(CSV_FILES.processors)).map(parseProcessor),
		previews: (await readCsvOptional(CSV_FILES.previews)).map(parsePreview),
		previewItems: (await readCsvOptional(CSV_FILES.previewItems)).map(parsePreviewItemRow),
		sampleSets: (await readCsvOptional(CSV_FILES.sampleSets)).map(parseSampleSet),
		snapshots: (await readCsvOptional(CSV_FILES.snapshots)).map(parseSnapshotRow),
		templates: (await readCsvOptional(CSV_FILES.templates)).map(parseTemplate),
		sourceHistory: await readCsvOptional(CSV_FILES.sourceHistory),
		sourceSessions: await readCsvOptional(CSV_FILES.sourceSessions),
		sourceCharacters: await readCsvOptional(CSV_FILES.sourceCharacters),
	};
	if (seeded.templates.length === 0) seeded.templates = defaultTemplates();
	if (seeded.processors.length === 0) seeded.processors = await defaultProcessors();

	removeLegacyLocalStorageState();
	const stored = await readPersistedTables();
	if (!stored) return seeded;
	return { ...seeded, ...stored };
}

function persistTables(tables: Tables): void {
	void writePersistedTables({
		annotations: tables.annotations,
		displayResults: tables.displayResults,
		experiments: tables.experiments,
		attempts: tables.attempts,
		processors: tables.processors,
		sampleSets: tables.sampleSets,
		snapshots: tables.snapshots,
		sourceHistory: tables.sourceHistory,
		sourceSessions: tables.sourceSessions,
		sourceCharacters: tables.sourceCharacters,
	}).catch(() => {
		// The in-memory workbench remains usable even if the browser denies durable storage.
	});
}

async function readPersistedTables(): Promise<Partial<PersistedTables> | null> {
	if (!('indexedDB' in globalThis)) return null;
	const db = await openStateDb();
	return new Promise(resolve => {
		const transaction = db.transaction(DB_STORE, 'readonly');
		const request = transaction.objectStore(DB_STORE).get(DB_STATE_KEY);
		request.onsuccess = () => {
			resolve(isRecord(request.result) ? (request.result as Partial<PersistedTables>) : null);
		};
		request.onerror = () => resolve(null);
	});
}

async function writePersistedTables(tables: PersistedTables): Promise<void> {
	if (!('indexedDB' in globalThis)) return;
	const db = await openStateDb();
	await new Promise<void>((resolve, reject) => {
		const transaction = db.transaction(DB_STORE, 'readwrite');
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
		transaction.objectStore(DB_STORE).put(tables, DB_STATE_KEY);
	});
}

function openStateDb(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	return dbPromise;
}

function removeLegacyLocalStorageState(): void {
	try {
		globalThis.localStorage?.removeItem(LEGACY_STORAGE_KEY);
	} catch {
		// Ignore private-mode or blocked-storage failures.
	}
}

async function readCsvOptional(path: string): Promise<CsvRow[]> {
	const response = await fetch(path, { cache: 'no-store' }).catch(() => null);
	if (!response?.ok) return [];
	const text = await response.text();
	try {
		return parseCsvRows(text, path);
	} catch {
		return [];
	}
}

async function parseCsvFile(file: File, expectedName: string): Promise<CsvRow[]> {
	if (!file.name.toLowerCase().endsWith('.csv')) {
		throw clientError('BATCH_LAB_SOURCE_CSV_INVALID', `${file.name} 不是 CSV 文件`);
	}
	const rows = parseCsvRows(await file.text(), expectedName);
	if (rows.length === 0) {
		throw clientError('BATCH_LAB_SOURCE_CSV_EMPTY', `${file.name} 没有可导入的数据行`);
	}
	return rows;
}

function parseCsvRows(text: string, sourceName: string): CsvRow[] {
	const parsed = Papa.parse<CsvRow>(text, { header: true, skipEmptyLines: 'greedy' });
	const firstError = parsed.errors.find(error => error.code !== 'UndetectableDelimiter');
	if (firstError) {
		throw clientError(
			'BATCH_LAB_SOURCE_CSV_PARSE_ERROR',
			`${sourceName} 解析失败：${firstError.message}`
		);
	}
	return parsed.data
		.map(row => normalizeCsvRow(row))
		.filter(row => Object.values(row).some(value => String(value ?? '').trim()));
}

function normalizeCsvRow(row: CsvRow): CsvRow {
	return Object.fromEntries(
		Object.entries(row)
			.filter(([key]) => key !== '__parsed_extra')
			.map(([key, value]) => [key.replace(/^\uFEFF/, ''), String(value ?? '')])
	);
}

function requireCsvColumns(rows: CsvRow[], fileName: string, columnGroups: string[][]): void {
	const headers = new Set(Object.keys(rows[0] ?? {}));
	const missing = columnGroups
		.filter(group => !group.some(column => headers.has(column)))
		.map(group => group.join(' / '));
	if (missing.length > 0) {
		throw clientError(
			'BATCH_LAB_SOURCE_CSV_COLUMNS_MISSING',
			`${fileName} 缺少列：${missing.join(', ')}`
		);
	}
}

function countPreviewableSourceRows(
	historyRows: CsvRow[],
	sessionRows: CsvRow[],
	characterRows: CsvRow[]
): number {
	const sessions = new Set(sessionRows.filter(row => !row.deleted_at).map(row => row.id));
	const characters = new Set(characterRows.map(row => row.id));
	return historyRows.filter(row => {
		const sessionId = row.session_id || row.source_session_id;
		const characterId = row.character_id || row.source_character_id;
		return Boolean(
			row.id &&
				sessionId &&
				sessions.has(sessionId) &&
				characterId &&
				characters.has(characterId) &&
				row.user_input &&
				(row.model || row.original_model)
		);
	}).length;
}

function parseTemplate(row: CsvRow): BatchLabSqlTemplate {
	return {
		key: row.key || 'recent_chat_history',
		version: Number(row.version || 1),
		name: row.name || '最近有效对话样本',
		description:
			row.description || '从导出的 chat_history / chat_sessions / characters CSV 中生成样本集',
		sql: row.sql || DEFAULT_SAMPLE_SQL,
		default_parameters: row.default_parameters
			? parseSqlParameters(row.default_parameters)
			: { min_turn: 1 },
		enabled: parseBoolean(row.enabled, true),
	};
}

function parseProcessor(row: CsvRow): BatchLabProcessorVersion {
	const config = parseJson(row.config, { protocol: 'none_v1' }) as BatchLabProcessorConfig;
	return {
		id: row.id || newIdempotencyKey(),
		name: row.name || 'Imported processor',
		protocol: (row.protocol as BatchLabProcessorVersion['protocol']) || config.protocol,
		config,
		digest: row.digest || 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
		created_at: toIso(row.created_at),
	};
}

function parsePreview(row: CsvRow): BatchLabPreview {
	return {
		id: row.id || newIdempotencyKey(),
		digest: row.digest || 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
		source_environment: LOCAL_SOURCE_ENVIRONMENT,
		final_sql: row.final_sql || DEFAULT_SAMPLE_SQL,
		parameters: parseSqlParameters(row.parameters),
		sample_limit: Number(row.sample_limit || 50),
		statistics: parseJson(
			row.statistics,
			buildStatistics([], 50, 0, false)
		) as BatchLabPreviewStatistics,
		items: [],
		created_at: toIso(row.created_at),
		expires_at: toIso(row.expires_at),
	};
}

function parsePreviewItemRow(row: CsvRow): BatchLabPreviewItem & { preview_id: string } {
	return { ...parsePreviewLikeItem(row), preview_id: row.preview_id || '' };
}

function parseSnapshotRow(row: CsvRow): BatchLabSampleSnapshot & { sample_set_id: string } {
	return { ...parsePreviewLikeItem(row), sample_set_id: row.sample_set_id || '' };
}

function parsePreviewLikeItem(row: CsvRow): BatchLabPreviewItem {
	return {
		ordinal: Number(row.ordinal || 0),
		source_history_id: row.source_history_id || newIdempotencyKey(),
		source_session_id: row.source_session_id || newIdempotencyKey(),
		source_user_id: row.source_user_id || newIdempotencyKey(),
		source_character_id: row.source_character_id || newIdempotencyKey(),
		turn_index: Number(row.turn_index || 1),
		revision: Number(row.revision || 0),
		user_input: row.user_input || '',
		original_assistant_reply: row.original_assistant_reply || null,
		original_model: row.original_model || 'unknown',
		history: parseJson(row.history, []) as Message[],
		character_snapshot: parseJsonRecord(row.character_snapshot, {}),
		dynamic_input_snapshot: parseJsonRecord(row.dynamic_input_snapshot, {}),
		restoration_strategy: 'exact_prompt_snapshot',
	};
}

function parseSampleSet(row: CsvRow): BatchLabSampleSetDetail {
	return {
		id: row.id || newIdempotencyKey(),
		name: row.name || 'Imported sample set',
		source_environment: LOCAL_SOURCE_ENVIRONMENT,
		source_preview_id: row.source_preview_id || newIdempotencyKey(),
		source_digest:
			row.source_digest ||
			'sha256:0000000000000000000000000000000000000000000000000000000000000000',
		sample_count: Number(row.sample_count || 0),
		statistics: parseJson(
			row.statistics,
			buildStatistics([], 0, 0, false)
		) as BatchLabPreviewStatistics,
		frozen_sql: row.frozen_sql || DEFAULT_SAMPLE_SQL,
		frozen_parameters: parseSqlParameters(row.frozen_parameters),
		created_at: toIso(row.created_at),
		deleted_at: row.deleted_at ? toIso(row.deleted_at) : null,
	};
}

function parseExperiment(row: CsvRow): BatchLabExperimentSummary {
	return {
		id: row.id || newIdempotencyKey(),
		name: row.name || 'Imported experiment',
		source_environment: LOCAL_SOURCE_ENVIRONMENT,
		sample_set_id: row.sample_set_id || newIdempotencyKey(),
		status: (row.status as BatchLabExperimentStatus) || 'draft',
		purpose: row.purpose || null,
		run_mode: row.run_mode === 'multi_turn' ? 'multi_turn' : 'single',
		output_preset: parseJson(
			row.output_preset,
			undefined
		) as BatchLabExperimentSummary['output_preset'],
		provider_config: parseJson(
			row.provider_config,
			undefined
		) as BatchLabExperimentSummary['provider_config'],
		variants: parseJson(row.variants, []) as BatchLabExperimentSummary['variants'],
		total_attempts: Number(row.total_attempts || 0),
		completed_attempts: Number(row.completed_attempts || 0),
		failed_attempts: Number(row.failed_attempts || 0),
		created_at: toIso(row.created_at),
		started_at: row.started_at ? toIso(row.started_at) : null,
		completed_at: row.completed_at ? toIso(row.completed_at) : null,
	};
}

function parseAttempt(row: CsvRow): AttemptRow {
	return {
		id: row.id || newIdempotencyKey(),
		experiment_id: row.experiment_id || '',
		sample_set_id: row.sample_set_id || '',
		sample_ordinal: Number(row.sample_ordinal || 0),
		variant_key: row.variant_key || 'a',
		turn_index: Number(row.turn_index || 1),
		status: (row.status as AttemptRow['status']) || 'pending',
		lease_owner: row.lease_owner || null,
		lease_expires_at: row.lease_expires_at || null,
		attempt_count: Number(row.attempt_count || 0),
		max_attempts: Number(row.max_attempts || 2),
		generation_id: row.generation_id || null,
		finish_reason: row.finish_reason || null,
		raw_output: row.raw_output || null,
		display_result_id: row.display_result_id || null,
		error_code: row.error_code || null,
		error_message: row.error_message || null,
		started_at: row.started_at ? toIso(row.started_at) : null,
		completed_at: row.completed_at ? toIso(row.completed_at) : null,
		created_at: toIso(row.created_at),
	};
}

function parseDisplayResult(row: CsvRow): DisplayResultRow {
	return {
		id: row.id || newIdempotencyKey(),
		processor_version_id: row.processor_version_id || newIdempotencyKey(),
		processor_digest:
			row.processor_digest ||
			'sha256:0000000000000000000000000000000000000000000000000000000000000000',
		status: (row.status as BatchLabDisplayResult['status']) || 'success',
		match_count: Number(row.match_count || 0),
		input_text: row.input_text || '',
		output_text: row.output_text || '',
		sanitized_html: row.sanitized_html || renderSafeHtml(row.output_text || ''),
		error_code: (row.error_code as BatchLabDisplayResult['error_code']) || null,
		renderer: { protocol: 'batch_lab_html_v1', version: 1 },
		created_at: toIso(row.created_at),
	};
}

function parseAnnotation(row: CsvRow): BatchLabAnnotation {
	return {
		experiment_id: row.experiment_id || '',
		sample_ordinal: row.sample_ordinal ? Number(row.sample_ordinal) : null,
		turn_index: row.turn_index ? Number(row.turn_index) : null,
		tag: row.tag || null,
		note: row.note || null,
		updated_at: toIso(row.updated_at),
	};
}

async function defaultProcessors(): Promise<BatchLabProcessorVersion[]> {
	const regexConfig: BatchLabProcessorConfig = {
		protocol: 'regex_json_v1',
		rules: [],
		timeout_ms: 250,
	};
	const noneConfig: BatchLabProcessorConfig = { protocol: 'none_v1' };
	return [
		{
			id: newIdempotencyKey(),
			name: '保留原文',
			protocol: 'none_v1',
			config: noneConfig,
			digest: await digestJson(noneConfig),
			created_at: now(),
		},
		{
			id: newIdempotencyKey(),
			name: '状态栏与记忆块',
			protocol: 'regex_json_v1',
			config: regexConfig,
			digest: await digestJson(regexConfig),
			created_at: now(),
		},
	];
}

function defaultTemplates(): BatchLabSqlTemplate[] {
	return [
		{
			key: 'recent_chat_history',
			version: 1,
			name: '最近有效对话样本',
			description:
				'纯前端版本会使用 data/resouce/chat_history_rows.csv、chat_sessions_rows.csv、characters_rows.csv。',
			sql: DEFAULT_SAMPLE_SQL,
			default_parameters: { min_turn: 1 },
			enabled: true,
		},
	];
}

async function requireExperiment(experimentId: string): Promise<BatchLabExperimentSummary> {
	const experiment = (await loadTables()).experiments.find(item => item.id === experimentId);
	if (!experiment) throw clientError('BATCH_LAB_EXPERIMENT_NOT_FOUND', '实验不存在');
	return experiment;
}

function toExperimentDetail(experiment: BatchLabExperimentSummary): BatchLabExperimentDetail {
	const extended = experiment as BatchLabExperimentSummary & {
		kind?: 'generation' | 'reuse_display';
		source_experiment_id?: string | null;
		generation_source_experiment_id?: string | null;
	};
	return {
		...experiment,
		lineage: {
			kind: extended.kind ?? 'generation',
			source_experiment_id: extended.source_experiment_id ?? null,
			generation_source_experiment_id: extended.generation_source_experiment_id ?? null,
		},
	};
}

async function buildExportRows(experimentId: string): Promise<BatchLabExportRow[]> {
	const detail = await getBatchLabExperimentResults(experimentId, {
		limit: BATCH_LAB_MAX_SAMPLE_LIMIT,
	});
	return detail.samples.map(sample => {
		const attempts: BatchLabExportAttempt[] = detail.attempts
			.filter(attempt => attempt.sample_ordinal === sample.ordinal)
			.map(attempt => ({
				attempt_id: attempt.attempt_id,
				variant_key: attempt.variant_key,
				turn_index: attempt.turn_index,
				status: attempt.status,
				generation_id: attempt.generation_id,
				finish_reason: attempt.finish_reason,
				raw_output: attempt.raw_output,
				display_result_id: attempt.display_result_id,
				error_code: attempt.error_code,
				error_message: attempt.error_message,
			}));
		return {
			schema_version: BATCH_LAB_JSONL_SCHEMA_VERSION,
			experiment: detail.experiment,
			sample,
			attempts,
			annotations: detail.annotations.filter(item => item.sample_ordinal === sample.ordinal),
		};
	});
}

function refreshExperimentCounts(tables: Tables, experimentId: string): void {
	const experiment = tables.experiments.find(item => item.id === experimentId);
	if (!experiment) return;
	const attempts = tables.attempts.filter(item => item.experiment_id === experimentId);
	experiment.total_attempts = attempts.length;
	experiment.completed_attempts = attempts.filter(item => item.status === 'succeeded').length;
	experiment.failed_attempts = attempts.filter(item => item.status === 'failed').length;
	if (attempts.some(item => item.status === 'running')) experiment.status = 'running';
	else if (attempts.some(item => item.status === 'pending')) experiment.status = 'queued';
	else if (attempts.length > 0) {
		experiment.status = experiment.failed_attempts > 0 ? 'failed' : 'completed';
		experiment.completed_at = experiment.completed_at ?? now();
	}
}

function flattenRow(row: unknown): Record<string, string> {
	if (!isRecord(row)) return {};
	return Object.fromEntries(
		Object.entries(row).map(([key, value]) => [
			key,
			value === null || value === undefined
				? ''
				: typeof value === 'object'
				? JSON.stringify(value)
				: String(value),
		])
	);
}

function downloadBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	URL.revokeObjectURL(url);
}

function normalizeChatCompletionsUrl(value: string): string {
	const trimmed = value.trim().replace(/\/$/, '');
	if (trimmed.endsWith('/chat/completions')) return trimmed;
	if (trimmed.endsWith('/api/v1')) return `${trimmed}/chat/completions`;
	return trimmed;
}

function readModelApiKey(): string {
	const config = Array.isArray(BATCH_LAB_CONFIG) ? BATCH_LAB_CONFIG[0] : BATCH_LAB_CONFIG;
	const key = String(config?.BATCH_LAB_MODEL_KEY ?? '')
		.trim()
		.replace(/\s+All$/, '');
	if (!key)
		throw new BatchLabClientError(
			'configuration',
			'缺少 script/config.js 中的 BATCH_LAB_MODEL_KEY'
		);
	return key;
}

function requireConfig(config: BatchLabProcessorConfig | undefined): BatchLabProcessorConfig {
	if (!config) throw clientError('BATCH_LAB_PROCESSOR_VALIDATION_ERROR', '缺少后处理配置');
	return config;
}

function parseJsonRecord(
	text: string | undefined,
	fallback: Record<string, unknown>
): Record<string, unknown> {
	const parsed = parseJson(text, fallback);
	return isRecord(parsed) ? parsed : fallback;
}

function parseSqlParameters(
	text: string | undefined
): Record<string, string | number | boolean | null> {
	const parsed = parseJsonRecord(text, {});
	return Object.fromEntries(
		Object.entries(parsed).filter(
			(entry): entry is [string, string | number | boolean | null] =>
				typeof entry[1] === 'string' ||
				typeof entry[1] === 'number' ||
				typeof entry[1] === 'boolean' ||
				entry[1] === null
		)
	);
}

function parseJson(text: string | undefined, fallback: unknown): unknown {
	if (!text) return fallback;
	try {
		return JSON.parse(text);
	} catch {
		return fallback;
	}
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined || value === '') return fallback;
	return value === 'true' || value === '1';
}

function toIso(value: string | undefined): string {
	if (!value) return now();
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? now() : parsed.toISOString();
}

function now(): string {
	return new Date().toISOString();
}

async function digestJson(value: unknown): Promise<`sha256:${string}`> {
	return digestText(JSON.stringify(sortJson(value)));
}

async function digestText(value: string): Promise<`sha256:${string}`> {
	const data = new TextEncoder().encode(value);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return `sha256:${[...new Uint8Array(hash)]
		.map(byte => byte.toString(16).padStart(2, '0'))
		.join('')}`;
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, child]) => [key, sortJson(child)])
		);
	}
	return value;
}

function readPath(value: unknown, path: Array<string | number>): unknown {
	let cursor = value;
	for (const segment of path) {
		if (Array.isArray(cursor) && typeof segment === 'number') cursor = cursor[segment];
		else if (isRecord(cursor) && typeof segment === 'string') cursor = cursor[segment];
		else return undefined;
	}
	return cursor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDeleted(experiment: BatchLabExperimentSummary): boolean {
	return Boolean((experiment as BatchLabExperimentSummary & { deleted_at?: string }).deleted_at);
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function clientError(code: string, message: string): BatchLabClientError {
	return new BatchLabClientError('protocol', message, code);
}
