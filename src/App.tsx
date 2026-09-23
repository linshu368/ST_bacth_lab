import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BatchLabContext,
  BatchLabExperimentResultDetail,
  BatchLabExperimentSummary,
  BatchLabExperimentVariant,
  BatchLabPreview,
  BatchLabProcessorVersion,
  BatchLabSampleSet,
  BatchLabSampleSnapshot,
  BatchLabSqlTemplate,
} from './lib/batch-lab-contracts';
import {
  BATCH_LAB_DEFAULT_SAMPLE_LIMIT,
  BATCH_LAB_MAX_EXPERIMENT_TURNS,
  BATCH_LAB_MAX_SAMPLE_LIMIT,
} from './lib/batch-lab-contracts';
import type { TableProps } from 'antd';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Divider,
  Drawer,
  Form,
  Input,
  InputNumber,
  Layout,
  Menu,
  Modal,
  Progress,
  Result,
  Select,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tag,
  Tabs,
  Typography,
  message,
} from 'antd';
import {
  copyBatchLabExperiment,
  createBatchLabExperiment,
  createBatchLabPreview,
  createBatchLabProcessor,
  createBatchLabReuseDisplayExperiment,
  createBatchLabSampleSet,
  deleteBatchLabExperiment,
  deleteBatchLabSampleSet,
  downloadBatchLabExperimentJsonl,
  exportBatchLabCsvBundle,
  getBatchLabContext,
  getBatchLabExperiment,
  getBatchLabExperimentResults,
  getBatchLabSampleSet,
  importBatchLabSourceCsvFiles,
  listBatchLabExperiments,
  listBatchLabProcessors,
  listBatchLabSampleSetSamples,
  listBatchLabSampleSets,
  listBatchLabSqlTemplates,
  previewBatchLabProcessor,
  runBatchLabExperimentWorkerOnce,
  startBatchLabExperiment,
  stopBatchLabExperiment,
  upsertBatchLabAnnotation,
} from './api/client';
import { batchLabQueryKeys } from './api/query-keys';
import {
  buildProcessorConfig,
  displayStatusText,
  experimentProgress,
  experimentStatusText,
  newIdempotencyKey,
  parseSqlParameters,
  processorConfigToRulesJson,
  processorOptionLabel,
  variantDiffRows,
} from './lib/workbench';

const { Header, Content } = Layout;

const DEFAULT_EXPERIMENT_OPENROUTER_MODEL_ID = 'deepseek/deepseek-v4.1-flash';
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

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

type PageKey = 'experiments' | 'samples' | 'processors' | 'new';

type ExperimentFormValues = {
  name: string;
  purpose: string;
  sample_set_id: string;
  max_turns: number;
  run_mode: 'single' | 'multi_turn';
  variants: Array<{
    name: string;
    provider_base_url: string;
    openrouter_model_id: string;
    output_preset_content: string;
    processor_version_id: string | null;
  }>;
};

type ProcessorFormValues = {
  name: string;
  protocol: 'none_v1' | 'regex_json_v1';
  rules_json: string;
  input_text: string;
};

type SampleFormValues = {
  name: string;
  template_key: string | null;
  min_turn: number;
  sample_limit: number;
  parameters_json: string;
  sql: string;
};

type SourceCsvFiles = {
  history: File | null;
  sessions: File | null;
  characters: File | null;
};

function formatDate(value: string | null): string {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败';
}

function csvFileButtonLabel(file: File | null, fallback: string): string {
  return file ? file.name : fallback;
}

function makeVariant(
  values: ExperimentFormValues,
  index: 0 | 1,
  key: 'a' | 'b'
): BatchLabExperimentVariant {
  const variant = values.variants[index];
  const modelName = variant.openrouter_model_id.trim();
  const presetContent = variant.output_preset_content.trim();
  return {
    key,
    name: variant.name,
    model_id: modelName,
    openrouter_model_id: modelName,
    tier: null,
    is_free: false,
    sampling: {},
    processor_version_id: variant.processor_version_id,
    max_turns: values.max_turns,
    provider_config: {
      base_url: variant.provider_base_url.trim() || DEFAULT_OPENROUTER_BASE_URL,
      key_ref: 'BATCH_LAB_MODEL_KEY',
      module_name: modelName,
    },
    output_preset: {
      name: `${variant.name} 输出预设`,
      content: presetContent,
      format: presetContent,
    },
  };
}

function CapabilityBanner({ context }: { context: BatchLabContext }) {
  const missing = [
    context.capabilities.sample_preview ? null : '样本预览',
    context.capabilities.experiment_execution ? null : '实验执行',
  ].filter(Boolean);

  return (
    <Alert
      className="env-banner"
      type={context.source_environment === 'production' ? 'warning' : 'info'}
      showIcon
      message={
        <Space wrap>
          <strong>环境</strong>
          <Tag>Backend: {context.backend_environment}</Tag>
          <Tag color={context.source_environment === 'production' ? 'red' : 'blue'}>
            样本来源: {context.source_environment}
          </Tag>
          {missing.length > 0 ? <Tag color="orange">未开放: {missing.join('、')}</Tag> : null}
        </Space>
      }
      description="来源环境由 Backend 部署固定，缓存和任务均按此环境隔离。"
    />
  );
}

function useWorkbenchData(context: BatchLabContext) {
  const templates = useQuery({
    queryKey: batchLabQueryKeys.templates(context),
    queryFn: ({ signal }) => listBatchLabSqlTemplates(signal),
  });
  const sampleSets = useQuery({
    queryKey: batchLabQueryKeys.sampleSets(context),
    queryFn: ({ signal }) => listBatchLabSampleSets(signal),
  });
  const processors = useQuery({
    queryKey: batchLabQueryKeys.processors(context),
    queryFn: ({ signal }) => listBatchLabProcessors(signal),
  });
  const experiments = useQuery({
    queryKey: batchLabQueryKeys.experiments(context),
    queryFn: ({ signal }) => listBatchLabExperiments(signal),
    refetchInterval: (query) => {
      const items = query.state.data ?? [];
      return items.some((item) => item.status === 'queued' || item.status === 'running')
        ? 5_000
        : false;
    },
  });
  return { templates, sampleSets, processors, experiments };
}

export function App() {
  const [page, setPage] = useState<PageKey>('new');
  const contextQuery = useQuery({
    queryKey: batchLabQueryKeys.context,
    queryFn: ({ signal }) => getBatchLabContext(signal),
    retry: false,
    staleTime: 60_000,
  });

  if (contextQuery.isPending) return <Skeleton active style={{ padding: 32 }} />;
  if (contextQuery.isError) {
    return (
      <Result
        status="error"
        title="无法确认运行环境"
        subTitle="Batch Lab 已安全停止。请检查 Backend feature flag、来源环境和 API/CORS 配置。"
      />
    );
  }

  return <WorkbenchShell context={contextQuery.data} page={page} onPageChange={setPage} />;
}

function WorkbenchShell({
  context,
  page,
  onPageChange,
}: {
  context: BatchLabContext;
  page: PageKey;
  onPageChange: (page: PageKey) => void;
}) {
  const data = useWorkbenchData(context);
  const anyError = [data.templates, data.sampleSets, data.processors, data.experiments].find(
    (query) => query.isError
  );

  return (
    <Layout className="app-layout">
      <Header className="app-header">
        <Typography.Title level={3} className="app-title">
          TURN / LAB
        </Typography.Title>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[page]}
          onClick={(item) => onPageChange(item.key as PageKey)}
          items={[
            { key: 'experiments', label: '实验记录' },
            { key: 'samples', label: '样本集' },
            { key: 'processors', label: '富文本后处理' },
            { key: 'new', label: '新建实验' },
          ]}
        />
      </Header>
      <Content className="app-content">
        {/* <CapabilityBanner context={context} /> */}
        <Space className="section-gap" wrap>
          <Button
            onClick={() =>
              exportBatchLabCsvBundle()
                .then(() => message.success('CSV 数据包已开始下载'))
                .catch((error) => message.error(errorMessage(error)))
            }
          >
            导出 CSV 数据包
          </Button>
          <Typography.Text type="secondary">
            Vercel 静态站点不能直接写回仓库文件；运行时数据保存在浏览器本地，可在这里下载后覆盖
            data/bacth-lab。
          </Typography.Text>
        </Space>
        {anyError ? (
          <Alert
            className="section-gap"
            type="error"
            showIcon
            message="数据加载失败"
            description={errorMessage(anyError.error)}
          />
        ) : null}
        {page === 'experiments' ? (
          <ExperimentsPage context={context} experiments={data.experiments.data ?? []} />
        ) : null}
        {page === 'samples' ? (
          <SamplesPage
            context={context}
            templates={data.templates.data ?? []}
            sampleSets={data.sampleSets.data ?? []}
            loading={data.templates.isPending || data.sampleSets.isPending}
          />
        ) : null}
        {page === 'processors' ? (
          <ProcessorsPage
            context={context}
            processors={data.processors.data ?? []}
            loading={data.processors.isPending}
          />
        ) : null}
        {page === 'new' ? (
          <ExperimentWizard
            context={context}
            sampleSets={data.sampleSets.data ?? []}
            processors={data.processors.data ?? []}
            loading={data.sampleSets.isPending || data.processors.isPending}
            onCreated={() => onPageChange('experiments')}
          />
        ) : null}
      </Content>
    </Layout>
  );
}

function ExperimentsPage({
  context,
  experiments,
}: {
  context: BatchLabContext;
  experiments: BatchLabExperimentSummary[];
}) {
  const [selected, setSelected] = useState<BatchLabExperimentSummary | null>(null);
  const queryClient = useQueryClient();
  const invalidateExperiments = () =>
    queryClient.invalidateQueries({ queryKey: batchLabQueryKeys.experiments(context) });
  const startMutation = useMutation({
    mutationFn: (experiment: BatchLabExperimentSummary) =>
      startBatchLabExperiment({
        experiment_id: experiment.id,
        source_environment: context.source_environment,
        idempotency_key: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      message.success('实验已启动');
      await invalidateExperiments();
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const stopMutation = useMutation({
    mutationFn: (experiment: BatchLabExperimentSummary) =>
      stopBatchLabExperiment({
        experiment_id: experiment.id,
        source_environment: context.source_environment,
      }),
    onSuccess: async () => {
      message.success('实验已停止，不再领取新任务');
      await invalidateExperiments();
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const deleteMutation = useMutation({
    mutationFn: (experiment: BatchLabExperimentSummary) =>
      deleteBatchLabExperiment({
        experiment_id: experiment.id,
        source_environment: context.source_environment,
      }),
    onSuccess: async (_, experiment) => {
      if (selected?.id === experiment.id) setSelected(null);
      message.success('实验记录已删除');
      await invalidateExperiments();
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const executeOneMutation = useMutation({
    mutationFn: (experiment: BatchLabExperimentSummary) =>
      runBatchLabExperimentWorkerOnce({
        experiment_id: experiment.id,
        source_environment: context.source_environment,
        worker_id: `batch-lab-ui-${newIdempotencyKey()}`,
        claim_limit: 1,
      }),
    onSuccess: async (result) => {
      if (result.claimed_count === 0) {
        message.info('当前没有可领取的任务，可能已有任务正在执行或等待前一轮完成');
      } else {
        message.success(
          `单条执行完成：成功 ${result.completed_count}，失败 ${result.failed_count}`
        );
      }
      await invalidateExperiments();
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const executeAllMutation = useMutation({
    mutationFn: async (experiment: BatchLabExperimentSummary) => {
      const total = { claimed: 0, completed: 0, failed: 0 };
      // 每批最多 10 条，降低单次请求耗时；停止操作会在两批之间生效。
      for (;;) {
        const result = await runBatchLabExperimentWorkerOnce({
          experiment_id: experiment.id,
          source_environment: context.source_environment,
          worker_id: `batch-lab-ui-${newIdempotencyKey()}`,
          claim_limit: 10,
        });
        total.claimed += result.claimed_count;
        total.completed += result.completed_count;
        total.failed += result.failed_count;
        await invalidateExperiments();
        if (result.claimed_count === 0) return total;
      }
    },
    onSuccess: async (result) => {
      if (result.claimed === 0) {
        message.info('当前没有可领取的任务，可能已有任务正在执行或等待前一轮完成');
      } else {
        message.success(`全部执行完成：成功 ${result.completed}，失败 ${result.failed}`);
      }
      await invalidateExperiments();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const confirmExecuteAll = (experiment: BatchLabExperimentSummary) => {
    Modal.confirm({
      title: '全部执行实验任务？',
      content: `将持续分批执行“${experiment.name}”中的全部待处理任务，直至没有可领取任务。`,
      okText: '全部执行',
      cancelText: '取消',
      onOk: () => executeAllMutation.mutateAsync(experiment),
    });
  };

  const confirmDelete = (experiment: BatchLabExperimentSummary) => {
    Modal.confirm({
      title: '删除实验记录？',
      content: `“${experiment.name}”将从列表隐藏，已生成的审计数据仍会保留。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => deleteMutation.mutateAsync(experiment),
    });
  };

  const columns: TableProps<BatchLabExperimentSummary>['columns'] = [
    {
      title: '实验',
      dataIndex: 'name',
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          <Button type="link" className="link-button" onClick={() => setSelected(record)}>
            {record.name}
          </Button>
          <Typography.Text type="secondary">{record.id}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (_, record) => (
        <Space direction="vertical" size={4} className="full-width">
          <Space>
            <Tag
              color={
                record.status === 'failed'
                  ? 'red'
                  : record.status === 'completed'
                    ? 'green'
                    : 'blue'
              }
            >
              {experimentStatusText(record.status)}
            </Tag>
            <Typography.Text type="secondary">
              {record.completed_attempts}/{record.total_attempts}
            </Typography.Text>
          </Space>
          <Progress
            percent={experimentProgress(record)}
            size="small"
            status={record.failed_attempts ? 'exception' : 'active'}
          />
        </Space>
      ),
    },
    {
      title: '失败',
      dataIndex: 'failed_attempts',
      width: 90,
    },
    {
      title: '创建',
      dataIndex: 'created_at',
      render: (value: string) => formatDate(value),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_, record) => (
        <Space wrap>
          <Button onClick={() => setSelected(record)}>查看对比</Button>
          <Button
            type="primary"
            disabled={record.status !== 'draft'}
            loading={startMutation.isPending && startMutation.variables?.id === record.id}
            onClick={() => startMutation.mutate(record)}
          >
            启动
          </Button>
          <Button
            disabled={record.status !== 'queued' && record.status !== 'running'}
            loading={executeOneMutation.isPending && executeOneMutation.variables?.id === record.id}
            onClick={() => executeOneMutation.mutate(record)}
          >
            执行
          </Button>
          <Button
            disabled={record.status !== 'queued' && record.status !== 'running'}
            loading={executeAllMutation.isPending && executeAllMutation.variables?.id === record.id}
            onClick={() => confirmExecuteAll(record)}
          >
            全部执行
          </Button>
          <Button
            disabled={record.status !== 'queued' && record.status !== 'running'}
            loading={stopMutation.isPending && stopMutation.variables?.id === record.id}
            onClick={() => stopMutation.mutate(record)}
          >
            停止
          </Button>
          <Button
            danger
            disabled={record.status === 'queued' || record.status === 'running'}
            loading={deleteMutation.isPending && deleteMutation.variables?.id === record.id}
            onClick={() => confirmDelete(record)}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <section className="section-gap">
      <div className="page-head">
        <div>
          <Typography.Title level={2}>实验记录</Typography.Title>
          <Typography.Text type="secondary">
            按后端持久状态恢复进度，刷新页面不会丢失运行记录。
          </Typography.Text>
        </div>
      </div>
      <Table
        rowKey="id"
        className="work-table"
        columns={columns}
        dataSource={experiments}
        locale={{ emptyText: '暂无实验，先创建并启动一个 A/B 组合。' }}
        scroll={{ x: 840 }}
      />
      <ExperimentDrawer context={context} experiment={selected} onClose={() => setSelected(null)} />
    </section>
  );
}

function ExperimentDrawer({
  context,
  experiment,
  onClose,
}: {
  context: BatchLabContext;
  experiment: BatchLabExperimentSummary | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: experiment
      ? batchLabQueryKeys.experimentResults(context, experiment.id)
      : [...batchLabQueryKeys.experiments(context), 'none'],
    queryFn: ({ signal }) =>
      getBatchLabExperimentResults(experiment?.id ?? '', { limit: 20 }, signal),
    enabled: experiment !== null,
  });
  const resultDetail = detailQuery.data;
  const detail = resultDetail?.experiment;
  const variants = detail?.variants ?? experiment?.variants ?? [];
  const diffRows = variants.length >= 2 ? variantDiffRows(variants[0], variants[1]) : [];
  const [displayMode, setDisplayMode] = useState<'rich' | 'raw'>('rich');
  const [selectedSampleOrdinal, setSelectedSampleOrdinal] = useState<number | null>(null);
  const [selectedTurn, setSelectedTurn] = useState<number>(1);
  const activeSample =
    resultDetail?.samples.find((sample) => sample.ordinal === selectedSampleOrdinal) ??
    resultDetail?.samples[0] ??
    null;
  const activeSampleAttempts =
    activeSample && resultDetail
      ? resultDetail.attempts.filter((attempt) => attempt.sample_ordinal === activeSample.ordinal)
      : [];
  const activeTurns = [...new Set(activeSampleAttempts.map((attempt) => attempt.turn_index))].sort(
    (a, b) => a - b
  );
  const invalidateExperiments = async () => {
    await queryClient.invalidateQueries({ queryKey: batchLabQueryKeys.experiments(context) });
    if (experiment) {
      await queryClient.invalidateQueries({
        queryKey: batchLabQueryKeys.experimentResults(context, experiment.id),
      });
    }
  };
  const copyMutation = useMutation({
    mutationFn: () => {
      if (!experiment) throw new Error('请选择实验');
      return copyBatchLabExperiment({
        source_experiment_id: experiment.id,
        name: `${experiment.name} · 副本`,
        source_environment: context.source_environment,
        idempotency_key: newIdempotencyKey(),
      });
    },
    onSuccess: async () => {
      message.success('已复制为新草稿');
      await invalidateExperiments();
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const reuseMutation = useMutation({
    mutationFn: () => {
      if (!detail) throw new Error('详情尚未加载');
      return createBatchLabReuseDisplayExperiment({
        source_experiment_id: detail.id,
        name: `${detail.name} · 复用原文`,
        source_environment: context.source_environment,
        variants: detail.variants.map((variant) => ({ ...variant })),
        idempotency_key: newIdempotencyKey(),
      });
    },
    onSuccess: async () => {
      message.success('已保存复用原文实验');
      await invalidateExperiments();
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const annotationMutation = useMutation({
    mutationFn: (note: string) => {
      if (!experiment) throw new Error('请选择实验');
      return upsertBatchLabAnnotation({
        experiment_id: experiment.id,
        sample_ordinal: null,
        turn_index: null,
        tag: null,
        note,
        source_environment: context.source_environment,
      });
    },
    onSuccess: () => message.success('备注已保存'),
    onError: (error) => message.error(errorMessage(error)),
  });
  const exportMutation = useMutation({
    mutationFn: async () => {
      if (!experiment) throw new Error('请选择实验');
      const blob = await downloadBatchLabExperimentJsonl(experiment.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `batch-lab-${experiment.id}.jsonl`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  return (
    <Drawer width={1200} title={experiment?.name} open={experiment !== null} onClose={onClose}>
      {experiment ? (
        <Space direction="vertical" size={20} className="full-width">
          <Space wrap>
            <Button loading={copyMutation.isPending} onClick={() => copyMutation.mutate()}>
              复制为草稿
            </Button>
            <Button
              disabled={!detail}
              loading={reuseMutation.isPending}
              onClick={() => reuseMutation.mutate()}
            >
              复用原文
            </Button>
            <Button loading={exportMutation.isPending} onClick={() => exportMutation.mutate()}>
              导出 JSONL
            </Button>
          </Space>
          <Descriptions bordered size="small" column={1}>
            <Descriptions.Item label="状态">
              {experimentStatusText(detail?.status ?? experiment.status)}
            </Descriptions.Item>
            <Descriptions.Item label="样本集">
              {detail?.sample_set_id ?? experiment.sample_set_id}
            </Descriptions.Item>
            <Descriptions.Item label="来源环境">
              {detail?.source_environment ?? experiment.source_environment}
            </Descriptions.Item>
            <Descriptions.Item label="血缘">
              {detail ? (
                <Space direction="vertical" size={2}>
                  <Typography.Text>{detail.lineage.kind}</Typography.Text>
                  <Typography.Text type="secondary">
                    source: {detail.lineage.source_experiment_id ?? '-'}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    generation: {detail.lineage.generation_source_experiment_id ?? '-'}
                  </Typography.Text>
                </Space>
              ) : (
                '加载中'
              )}
            </Descriptions.Item>
            <Descriptions.Item label="进度">
              {experiment.completed_attempts} 成功 / {experiment.failed_attempts} 失败 /{' '}
              {experiment.total_attempts} 总任务
            </Descriptions.Item>
          </Descriptions>
          <Card title="A/B 完整组合差异" size="small">
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={diffRows}
              columns={[
                { title: '字段', dataIndex: 'label', width: 140 },
                { title: '基准 A', dataIndex: 'baseline' },
                {
                  title: '候选 B',
                  dataIndex: 'candidate',
                  render: (value, row) => (
                    <Typography.Text type={row.baseline === value ? 'secondary' : undefined}>
                      {value}
                    </Typography.Text>
                  ),
                },
              ]}
              scroll={{ x: 640 }}
            />
          </Card>
          <Card
            title="查看对比"
            size="small"
            extra={
              <Select
                size="small"
                value={displayMode}
                onChange={setDisplayMode}
                options={[
                  { value: 'rich', label: '富文本' },
                  { value: 'raw', label: '原文' },
                ]}
              />
            }
          >
            {activeSample ? (
              <Space direction="vertical" size={14} className="full-width">
                <Select
                  value={activeSample.ordinal}
                  onChange={setSelectedSampleOrdinal}
                  options={(resultDetail?.samples ?? []).map((sample) => ({
                    value: sample.ordinal,
                    label: `样本 #${sample.ordinal} · 第 ${sample.turn_index} 轮`,
                  }))}
                />
                <Select
                  value={selectedTurn}
                  onChange={setSelectedTurn}
                  options={(activeTurns.length > 0 ? activeTurns : [1]).map((turn) => ({
                    value: turn,
                    label: `第 ${turn} 轮`,
                  }))}
                />
                <Descriptions bordered size="small" column={1}>
                  <Descriptions.Item label="当前样本">
                    #{activeSample.ordinal} · 第 {activeSample.turn_index} 轮
                  </Descriptions.Item>
                  <Descriptions.Item label="用户输入">{activeSample.user_input}</Descriptions.Item>
                </Descriptions>
                <Collapse
                  size="small"
                  items={[
                    {
                      key: 'context',
                      label: `${activeSample.history.length} 条上下文消息`,
                      children: (
                        <Space direction="vertical" className="full-width">
                          {activeSample.history.map((messageItem, index) => (
                            <Typography.Paragraph
                              key={`${messageItem.role}-${index}`}
                              className="sample-message"
                            >
                              <Tag>{messageItem.role}</Tag>
                              {messageItem.content}
                            </Typography.Paragraph>
                          ))}
                        </Space>
                      ),
                    },
                  ]}
                />
                <div className="two-column">
                  {variants.map((variant) => {
                    const attempt = activeSampleAttempts.find(
                      (item) => item.variant_key === variant.key && item.turn_index === selectedTurn
                    );
                    const richHtml = attempt?.display_result?.sanitized_html;
                    return (
                      <Card key={variant.key} size="small" title={variant.name}>
                        <Tag>{attempt?.status ?? 'pending'}</Tag>
                        {displayMode === 'rich' && richHtml ? (
                          <div
                            className="rich-preview phone-preview"
                            dangerouslySetInnerHTML={{ __html: richHtml }}
                          />
                        ) : (
                          <Typography.Paragraph className="sample-message">
                            {attempt?.raw_output ?? attempt?.error_message ?? '暂无输出'}
                          </Typography.Paragraph>
                        )}
                      </Card>
                    );
                  })}
                </div>
              </Space>
            ) : (
              <Skeleton active />
            )}
          </Card>
          <Card title="实验备注" size="small">
            <Input.TextArea id="experiment-note" rows={4} placeholder="记录观察，不参与评分。" />
            <Button
              className="section-gap"
              loading={annotationMutation.isPending}
              onClick={() => {
                const element = document.getElementById('experiment-note');
                annotationMutation.mutate(
                  element instanceof HTMLTextAreaElement ? element.value : ''
                );
              }}
            >
              保存备注
            </Button>
          </Card>
        </Space>
      ) : null}
    </Drawer>
  );
}

function SamplesPage({
  context,
  templates,
  sampleSets,
  loading,
}: {
  context: BatchLabContext;
  templates: BatchLabSqlTemplate[];
  sampleSets: BatchLabSampleSet[];
  loading: boolean;
}) {
  const queryClient = useQueryClient();
  const [form] = Form.useForm<SampleFormValues>();
  const [preview, setPreview] = useState<BatchLabPreview | null>(null);
  const [selectedSampleSet, setSelectedSampleSet] = useState<BatchLabSampleSet | null>(null);
  const [sourceCsvFiles, setSourceCsvFiles] = useState<SourceCsvFiles>({
    history: null,
    sessions: null,
    characters: null,
  });
  const historyInputRef = useRef<HTMLInputElement>(null);
  const sessionsInputRef = useRef<HTMLInputElement>(null);
  const charactersInputRef = useRef<HTMLInputElement>(null);
  const defaultTemplate = templates[0];

  const templateOptions = templates.map((template) => ({
    value: `${template.key}:${template.version}`,
    label: `${template.name} · v${template.version}`,
  }));

  const previewMutation = useMutation({
    mutationFn: (values: SampleFormValues) => {
      const template =
        values.template_key === null
          ? null
          : (templates.find((item) => `${item.key}:${item.version}` === values.template_key) ??
            null);
      return createBatchLabPreview({
        source_environment: context.source_environment,
        template_key: template?.key ?? null,
        template_version: template?.version ?? null,
        sql: values.sql,
        parameters: { min_turn: values.min_turn },
        sample_limit: values.sample_limit,
      });
    },
    onSuccess: (value) => setPreview(value),
    onError: (error) => message.error(errorMessage(error)),
  });

  const sourceImportMutation = useMutation({
    mutationFn: () => {
      if (!sourceCsvFiles.history || !sourceCsvFiles.sessions || !sourceCsvFiles.characters) {
        throw new Error('请先选择 chat_history、chat_sessions 和 characters 三个 CSV 文件');
      }
      return importBatchLabSourceCsvFiles({
        historyFile: sourceCsvFiles.history,
        sessionsFile: sourceCsvFiles.sessions,
        charactersFile: sourceCsvFiles.characters,
      });
    },
    onSuccess: (result) => {
      setPreview(null);
      message.success(
        `已导入 ${result.history_count} 条 history、${result.session_count} 条 session、${result.character_count} 条 character，可预览 ${result.previewable_history_count} 条 history`
      );
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (sampleSet: BatchLabSampleSet) =>
      deleteBatchLabSampleSet({
        sample_set_id: sampleSet.id,
        source_environment: context.source_environment,
      }),
    onSuccess: async () => {
      message.success('样本集已归档');
      await queryClient.invalidateQueries({ queryKey: batchLabQueryKeys.sampleSets(context) });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const saveMutation = useMutation({
    mutationFn: (values: SampleFormValues) => {
      if (!preview) throw new Error('请先预览并确认样本');
      return createBatchLabSampleSet({
        name: values.name,
        preview_id: preview.id,
        preview_digest: preview.digest,
        source_environment: context.source_environment,
        idempotency_key: newIdempotencyKey(),
      });
    },
    onSuccess: async () => {
      message.success('样本集已冻结');
      setPreview(null);
      await queryClient.invalidateQueries({ queryKey: batchLabQueryKeys.sampleSets(context) });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const applyTemplate = (value: string | null) => {
    const template = templates.find((item) => `${item.key}:${item.version}` === value);
    if (!template) return;
    const minTurn =
      typeof template.default_parameters.min_turn === 'number'
        ? template.default_parameters.min_turn
        : Number(form.getFieldValue('min_turn') ?? 60);
    form.setFieldsValue({
      sql: template.sql,
      min_turn: minTurn,
      parameters_json: JSON.stringify(
        { min_turn: minTurn, ...template.default_parameters },
        null,
        2
      ),
    });
    setPreview(null);
  };

  const selectSourceCsvFile = (key: keyof SourceCsvFiles, file: File | null) => {
    setSourceCsvFiles((current) => ({ ...current, [key]: file }));
  };

  return (
    <section className="section-gap">
      <div className="page-head">
        <div>
          <Typography.Title level={2}>样本集</Typography.Title>
          <Typography.Text type="secondary">
            SQL 预览确认后冻结，后续实验复用同一批快照。
          </Typography.Text>
        </div>
      </div>
      <Card className="section-gap" title="运行时导入 data/resouce CSV">
        <Alert
          type="info"
          showIcon
          message="导入后会写入浏览器 IndexedDB，并覆盖 Samples 预览使用的 data/resouce 种子数据。静态站点无法直接写回仓库目录。"
        />
        <div className="form-grid three source-import-grid">
          <input
            ref={historyInputRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(event) => {
              selectSourceCsvFile('history', event.target.files?.[0] ?? null);
              event.target.value = '';
            }}
          />
          <input
            ref={sessionsInputRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(event) => {
              selectSourceCsvFile('sessions', event.target.files?.[0] ?? null);
              event.target.value = '';
            }}
          />
          <input
            ref={charactersInputRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(event) => {
              selectSourceCsvFile('characters', event.target.files?.[0] ?? null);
              event.target.value = '';
            }}
          />
          <Button onClick={() => historyInputRef.current?.click()}>
            {csvFileButtonLabel(sourceCsvFiles.history, '选择 chat_history_rows.csv')}
          </Button>
          <Button onClick={() => sessionsInputRef.current?.click()}>
            {csvFileButtonLabel(sourceCsvFiles.sessions, '选择 chat_sessions_rows.csv')}
          </Button>
          <Button onClick={() => charactersInputRef.current?.click()}>
            {csvFileButtonLabel(sourceCsvFiles.characters, '选择 characters_rows.csv')}
          </Button>
        </div>
        <Space className="section-gap" wrap>
          <Button
            type="primary"
            loading={sourceImportMutation.isPending}
            disabled={
              !sourceCsvFiles.history || !sourceCsvFiles.sessions || !sourceCsvFiles.characters
            }
            onClick={() => sourceImportMutation.mutate()}
          >
            导入到 IndexedDB
          </Button>
          <Typography.Text type="secondary">
            导入完成后重新点击「预览抽样」，会使用刚导入的 history / session / characters。
          </Typography.Text>
        </Space>
      </Card>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={sampleSets}
        scroll={{ x: 820 }}
        columns={[
          { title: '名称', dataIndex: 'name' },
          {
            title: '规模',
            render: (_, record) => (
              <Space>
                <Tag>{record.sample_count} 条</Tag>
                <Typography.Text type="secondary">
                  {record.statistics.user_count} 用户 / {record.statistics.character_count} 角色
                </Typography.Text>
              </Space>
            ),
          },
          { title: '来源', dataIndex: 'source_environment', width: 100 },
          { title: '创建', dataIndex: 'created_at', render: (value: string) => formatDate(value) },
          {
            title: '操作',
            key: 'actions',
            width: 190,
            render: (_, record) => (
              <Space wrap>
                <Button onClick={() => setSelectedSampleSet(record)}>查看样本</Button>
                <Button
                  danger
                  loading={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate(record)}
                >
                  删除
                </Button>
              </Space>
            ),
          },
        ]}
        locale={{ emptyText: '暂无冻结样本集。' }}
      />
      <Card className="section-gap" title="创建样本集">
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            name: '长对话 · 新建调试集',
            template_key: defaultTemplate
              ? `${defaultTemplate.key}:${defaultTemplate.version}`
              : null,
            min_turn:
              typeof defaultTemplate?.default_parameters.min_turn === 'number'
                ? defaultTemplate.default_parameters.min_turn
                : 60,
            sample_limit: BATCH_LAB_DEFAULT_SAMPLE_LIMIT,
            parameters_json: JSON.stringify(
              { ...(defaultTemplate?.default_parameters ?? {}) },
              null,
              2
            ),
            sql: defaultTemplate?.sql ?? DEFAULT_SAMPLE_SQL,
          }}
          onValuesChange={() => setPreview(null)}
          onFinish={(values) => previewMutation.mutate(values)}
        >
          <div className="form-grid three">
            <Form.Item name="name" label="样本集名称" rules={[{ required: true }]}>
              <Input maxLength={120} />
            </Form.Item>
            <Form.Item name="template_key" label="SQL 模板">
              <Select
                allowClear
                placeholder="直接编辑 SQL"
                options={templateOptions}
                onChange={(value) => applyTemplate(value ?? null)}
              />
            </Form.Item>
            <Form.Item name="sample_limit" label="抽取条数" rules={[{ required: true }]}>
              <InputNumber min={1} max={BATCH_LAB_MAX_SAMPLE_LIMIT} className="full-width" />
            </Form.Item>
            <Form.Item name="min_turn" label="当前轮次至少" rules={[{ required: true }]}>
              <InputNumber min={1} max={10_000} className="full-width" />
            </Form.Item>
          </div>
          {/* <Form.Item name="parameters_json" label="参数 JSON">
            <Input.TextArea rows={5} className="code-input" />
          </Form.Item> */}
          <Form.Item name="sql" label="SQL" rules={[{ required: true }]}>
            <Input.TextArea rows={8} className="code-input" />
          </Form.Item>
          <Space wrap>
            <Button
              type="primary"
              htmlType="submit"
              loading={previewMutation.isPending}
              disabled={!context.capabilities.sample_preview}
            >
              预览抽样
            </Button>
            <Button
              disabled={!preview || preview.statistics.valid_count === 0}
              loading={saveMutation.isPending}
              onClick={() => saveMutation.mutate(form.getFieldsValue())}
            >
              保存冻结样本集
            </Button>
          </Space>
        </Form>
      </Card>
      {preview ? <PreviewPanel preview={preview} /> : null}
      <SampleSetDrawer
        context={context}
        sampleSet={selectedSampleSet}
        onClose={() => setSelectedSampleSet(null)}
      />
    </section>
  );
}

function SampleSetDrawer({
  context,
  sampleSet,
  onClose,
}: {
  context: BatchLabContext;
  sampleSet: BatchLabSampleSet | null;
  onClose: () => void;
}) {
  const detailQuery = useQuery({
    queryKey: sampleSet
      ? batchLabQueryKeys.sampleSet(context, sampleSet.id)
      : [...batchLabQueryKeys.sampleSets(context), 'none'],
    queryFn: ({ signal }) => getBatchLabSampleSet(sampleSet?.id ?? '', signal),
    enabled: sampleSet !== null,
  });
  const samplesQuery = useQuery({
    queryKey: sampleSet
      ? batchLabQueryKeys.sampleSetSamples(context, sampleSet.id)
      : [...batchLabQueryKeys.sampleSets(context), 'none', 'samples'],
    queryFn: ({ signal }) =>
      listBatchLabSampleSetSamples(sampleSet?.id ?? '', { limit: 50 }, signal),
    enabled: sampleSet !== null,
  });

  return (
    <Drawer width={1200} title={sampleSet?.name} open={sampleSet !== null} onClose={onClose}>
      <Space direction="vertical" size={18} className="full-width">
        {detailQuery.data ? (
          <Descriptions bordered size="small" column={1}>
            <Descriptions.Item label="样本数">{detailQuery.data.sample_count}</Descriptions.Item>
            <Descriptions.Item label="来源环境">
              {detailQuery.data.source_environment}
            </Descriptions.Item>
            <Descriptions.Item label="创建时间">
              {formatDate(detailQuery.data.created_at)}
            </Descriptions.Item>
            <Descriptions.Item label="冻结参数">
              <Typography.Text code>
                {JSON.stringify(detailQuery.data.frozen_parameters)}
              </Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="筛选 SQL">
              <Input.TextArea
                className="code-input"
                value={detailQuery.data.frozen_sql}
                rows={8}
                readOnly
              />
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Skeleton active />
        )}
        <Table<BatchLabSampleSnapshot>
          rowKey="source_history_id"
          loading={samplesQuery.isPending}
          size="small"
          dataSource={samplesQuery.data?.items ?? []}
          scroll={{ x: 980 }}
          columns={[
            { title: '#', dataIndex: 'ordinal', width: 70 },
            {
              title: '锚点',
              render: (_, item) => (
                <Space direction="vertical" size={2}>
                  <Typography.Text>{item.source_session_id}</Typography.Text>
                  <Typography.Text type="secondary">
                    第 {item.turn_index} 轮 · revision {item.revision}
                  </Typography.Text>
                </Space>
              ),
            },
            { title: '用户输入', dataIndex: 'user_input' },
            {
              title: '上下文',
              render: (_, item) => (
                <Collapse
                  size="small"
                  items={[
                    {
                      key: 'history',
                      label: `${item.history.length} 条窗口消息`,
                      children: (
                        <Space direction="vertical" className="full-width">
                          {item.history.map((messageItem, index) => (
                            <Typography.Paragraph
                              key={`${messageItem.role}-${index}`}
                              className="sample-message"
                            >
                              <Tag>{messageItem.role}</Tag>
                              {messageItem.content}
                            </Typography.Paragraph>
                          ))}
                        </Space>
                      ),
                    },
                  ]}
                />
              ),
            },
          ]}
        />
      </Space>
    </Drawer>
  );
}

function PreviewPanel({ preview }: { preview: BatchLabPreview }) {
  return (
    <Card className="section-gap" title="预览结果">
      <div className="stats-grid">
        <Statistic
          title="有效样本"
          value={preview.statistics.valid_count}
          suffix={`/ ${preview.statistics.requested_count}`}
        />
        <Statistic title="用户" value={preview.statistics.user_count} />
        <Statistic title="会话" value={preview.statistics.session_count} />
        <Statistic title="角色" value={preview.statistics.character_count} />
      </div>
      <Divider />
      <Table
        rowKey="source_history_id"
        size="small"
        dataSource={preview.items}
        scroll={{ x: 980 }}
        columns={[
          { title: '#', dataIndex: 'ordinal', width: 70 },
          {
            title: '锚点',
            render: (_, item) => (
              <Space direction="vertical" size={2}>
                <Typography.Text>{item.source_session_id}</Typography.Text>
                <Typography.Text type="secondary">
                  第 {item.turn_index} 轮 · revision {item.revision}
                </Typography.Text>
              </Space>
            ),
          },
          { title: '用户输入', dataIndex: 'user_input' },
          {
            title: '上下文',
            render: (_, item) => (
              <Collapse
                size="small"
                items={[
                  {
                    key: 'history',
                    label: `${item.history.length} 条窗口消息`,
                    children: (
                      <Space direction="vertical" className="full-width">
                        {item.history.map((messageItem, index) => (
                          <Typography.Paragraph
                            key={`${messageItem.role}-${index}`}
                            className="sample-message"
                          >
                            <Tag>{messageItem.role}</Tag>
                            {messageItem.content}
                          </Typography.Paragraph>
                        ))}
                      </Space>
                    ),
                  },
                ]}
              />
            ),
          },
        ]}
      />
      {Object.keys(preview.statistics.excluded_by_reason).length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message="排除摘要"
          description={JSON.stringify(preview.statistics.excluded_by_reason)}
        />
      ) : null}
    </Card>
  );
}

function ProcessorsPage({
  context,
  processors,
  loading,
}: {
  context: BatchLabContext;
  processors: BatchLabProcessorVersion[];
  loading: boolean;
}) {
  const queryClient = useQueryClient();
  const [form] = Form.useForm<ProcessorFormValues>();
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewStatus, setPreviewStatus] = useState<string | null>(null);
  const [previewHits, setPreviewHits] = useState<number | null>(null);

  const previewMutation = useMutation({
    mutationFn: (values: ProcessorFormValues) =>
      previewBatchLabProcessor({
        config: buildProcessorConfig(values.protocol, values.rules_json),
        input_text: values.input_text,
      }),
    onSuccess: (result) => {
      setPreviewHtml(result.sanitized_html);
      setPreviewStatus(displayStatusText(result.status));
      setPreviewHits(result.match_count);
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const saveMutation = useMutation({
    mutationFn: (values: ProcessorFormValues) =>
      createBatchLabProcessor({
        name: values.name,
        config: buildProcessorConfig(values.protocol, values.rules_json),
        idempotency_key: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      message.success('已保存不可变版本');
      await queryClient.invalidateQueries({ queryKey: batchLabQueryKeys.processors(context) });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const loadProcessor = (processor: BatchLabProcessorVersion) => {
    form.setFieldsValue({
      name: `${processor.name} · 修改版`,
      protocol: processor.protocol,
      rules_json: processorConfigToRulesJson(processor.config),
    });
    setPreviewHtml(null);
    setPreviewStatus(null);
    setPreviewHits(null);
  };

  return (
    <section className="section-gap">
      <div className="page-head">
        <div>
          <Typography.Title level={2}>富文本后处理</Typography.Title>
          <Typography.Text type="secondary">
            复制已有版本、预览原文、保存为不可变新版本。
          </Typography.Text>
        </div>
      </div>
      <div className="two-column">
        <Card title="规则编辑">
          <Form
            form={form}
            layout="vertical"
            initialValues={{
              name: '状态栏与记忆 · 修改版',
              protocol: 'regex_json_v1',
              rules_json: '[]',
              input_text: '模型原始回复\n\n[status]地点：客厅｜情绪：平静[/status]',
            }}
            onValuesChange={() => {
              setPreviewHtml(null);
              setPreviewStatus(null);
              setPreviewHits(null);
            }}
            onFinish={(values) => previewMutation.mutate(values)}
          >
            <Form.Item name="name" label="新版本名称" rules={[{ required: true }]}>
              <Input maxLength={120} />
            </Form.Item>
            <Form.Item name="protocol" label="协议" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'regex_json_v1', label: 'regex_json_v1' },
                  { value: 'none_v1', label: 'none_v1' },
                ]}
              />
            </Form.Item>
            <Form.Item name="rules_json" label="规则 JSON 数组">
              <Input.TextArea rows={10} className="code-input" />
            </Form.Item>
            <Form.Item name="input_text" label="预览原文">
              <Input.TextArea rows={6} />
            </Form.Item>
            <Space wrap>
              <Button type="primary" htmlType="submit" loading={previewMutation.isPending}>
                运行预览
              </Button>
              <Button
                loading={saveMutation.isPending}
                onClick={() => saveMutation.mutate(form.getFieldsValue())}
              >
                保存新版本
              </Button>
            </Space>
          </Form>
        </Card>
        <Card title="预览">
          {previewHtml ? (
            <Space direction="vertical" className="full-width">
              <Space>
                <Tag color="green">{previewStatus}</Tag>
                <Tag>{previewHits ?? 0} 处匹配</Tag>
              </Space>
              <div
                className="rich-preview phone-preview"
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            </Space>
          ) : (
            <Typography.Text type="secondary">运行预览后显示用户展示结果。</Typography.Text>
          )}
        </Card>
      </div>
      <Card className="section-gap" title="已保存版本">
        <Table
          rowKey="id"
          loading={loading}
          dataSource={processors}
          scroll={{ x: 760 }}
          columns={[
            { title: '名称', dataIndex: 'name' },
            { title: '协议', dataIndex: 'protocol', width: 150 },
            { title: 'Digest', dataIndex: 'digest' },
            {
              title: '操作',
              width: 120,
              render: (_, record) => (
                <Button onClick={() => loadProcessor(record)}>复制编辑</Button>
              ),
            },
          ]}
        />
      </Card>
    </section>
  );
}

function ExperimentWizard({
  context,
  sampleSets,
  processors,
  loading,
  onCreated,
}: {
  context: BatchLabContext;
  sampleSets: BatchLabSampleSet[];
  processors: BatchLabProcessorVersion[];
  loading: boolean;
  onCreated: () => void;
}) {
  const queryClient = useQueryClient();
  const [form] = Form.useForm<ExperimentFormValues>();
  const [confirmValues, setConfirmValues] = useState<ExperimentFormValues | null>(null);
  const processorOptions = useMemo(
    () => [
      { value: null, label: '不处理' },
      ...processors.map((processor) => ({
        value: processor.id,
        label: processorOptionLabel(processor),
      })),
    ],
    [processors]
  );

  const createMutation = useMutation({
    mutationFn: (values: ExperimentFormValues) =>
      createBatchLabExperiment({
        name: values.name,
        purpose: values.purpose?.trim() ? values.purpose.trim() : null,
        sample_set_id: values.sample_set_id,
        source_environment: context.source_environment,
        run_mode: values.run_mode,
        variants: [makeVariant(values, 0, 'a'), makeVariant(values, 1, 'b')],
        idempotency_key: newIdempotencyKey(),
      }),
    onSuccess: async (experiment) => {
      message.success('实验草稿已创建');
      await queryClient.invalidateQueries({ queryKey: batchLabQueryKeys.experiments(context) });
      Modal.confirm({
        title: '立即启动实验？',
        content: `计划任务数：${experiment.total_attempts || '启动后生成'}`,
        okText: '启动',
        cancelText: '稍后',
        onOk: async () => {
          await startBatchLabExperiment({
            experiment_id: experiment.id,
            source_environment: context.source_environment,
            idempotency_key: newIdempotencyKey(),
          });
          await queryClient.invalidateQueries({ queryKey: batchLabQueryKeys.experiments(context) });
          onCreated();
        },
        onCancel: onCreated,
      });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const copyBaseline = () => {
    const values = form.getFieldsValue();
    const baseline = values.variants?.[0];
    if (!baseline) return;
    form.setFieldValue(['variants', 1], { ...baseline, name: '候选 B' });
  };

  const initialValues: ExperimentFormValues = {
    name: '长对话 · 减少重复描写',
    purpose: '',
    sample_set_id: sampleSets[0]?.id ?? '',
    max_turns: 1,
    run_mode: 'single',
    variants: [
      {
        name: '基准 A',
        provider_base_url: DEFAULT_OPENROUTER_BASE_URL,
        openrouter_model_id: DEFAULT_EXPERIMENT_OPENROUTER_MODEL_ID,
        output_preset_content:
          '保持角色一致，自然回应用户，推进对话。\n结尾使用 [status]...[/status] 和 [memory]...[/memory] 输出状态及展示记忆。',
        processor_version_id: processors[0]?.id ?? null,
      },
      {
        name: '候选 B',
        provider_base_url: DEFAULT_OPENROUTER_BASE_URL,
        openrouter_model_id: DEFAULT_EXPERIMENT_OPENROUTER_MODEL_ID,
        output_preset_content:
          '保持角色一致，自然回应用户，推进对话。\n减少重复的动作和情绪描写；用户要求安静时，不主动追问。\n结尾使用 [status]...[/status] 和 [memory]...[/memory] 输出状态及展示记忆。',
        processor_version_id: processors[1]?.id ?? processors[0]?.id ?? null,
      },
    ],
  };

  return (
    <section className="section-gap">
      <div className="page-head">
        <div>
          <Typography.Title level={2}>新建对比实验</Typography.Title>
          <Typography.Text type="secondary">
            每个版本冻结模型、采样参数、重跑轮数和后处理版本。
          </Typography.Text>
        </div>
      </div>
      {loading ? (
        <Skeleton active />
      ) : (
        <Form
          form={form}
          layout="vertical"
          initialValues={initialValues}
          onFinish={(values) => setConfirmValues(values)}
        >
          <Card title="样本与规模">
            <div className="form-grid three">
              <Form.Item name="name" label="实验名称" rules={[{ required: true }]}>
                <Input maxLength={120} />
              </Form.Item>
              <Form.Item name="sample_set_id" label="样本集" rules={[{ required: true }]}>
                <Select
                  options={sampleSets.map((sampleSet) => ({
                    value: sampleSet.id,
                    label: `${sampleSet.name} · ${sampleSet.sample_count} 条`,
                  }))}
                />
              </Form.Item>
              <Form.Item name="max_turns" label="重跑轮数 X" rules={[{ required: true }]}>
                <InputNumber min={1} max={BATCH_LAB_MAX_EXPERIMENT_TURNS} className="full-width" />
              </Form.Item>
              <Form.Item name="run_mode" label="运行模式" rules={[{ required: true }]}>
                <Select
                  options={[
                    { value: 'single', label: '单轮' },
                    { value: 'multi_turn', label: '连续多轮' },
                  ]}
                />
              </Form.Item>
            </div>
            <Form.Item name="purpose" label="本次想验证什么 · 选填">
              <Input.TextArea rows={3} maxLength={2000} />
            </Form.Item>
          </Card>
          <div className="two-column section-gap">
            {[0, 1].map((index) => (
              <Card
                key={index}
                title={index === 0 ? '组合 A · 基准' : '组合 B · 候选'}
                extra={
                  index === 1 ? <Button onClick={copyBaseline}>从 A 复制整套组合</Button> : null
                }
              >
                <Alert
                  className="combo-save-alert"
                  type="success"
                  showIcon={false}
                  message="生成配置与展示规则一起保存"
                />
                <Form.Item
                  name={['variants', index, 'name']}
                  label="组合名称"
                  rules={[{ required: true }]}
                >
                  <Input maxLength={120} />
                </Form.Item>
                <Form.Item
                  name={['variants', index, 'provider_base_url']}
                  label="OpenRouter URL"
                  rules={[{ required: true }]}
                >
                  <Input maxLength={500} placeholder="https://openrouter.ai/api/v1" />
                </Form.Item>
                <Form.Item
                  name={['variants', index, 'openrouter_model_id']}
                  label="生成模型"
                  rules={[{ required: true }]}
                >
                  <Input maxLength={200} placeholder="google/gemini-3.1-flash-lite" />
                </Form.Item>
                <Form.Item
                  name={['variants', index, 'output_preset_content']}
                  label="① 输出预设 · 规定内容与格式"
                  rules={[{ required: true }]}
                >
                  <Input.TextArea rows={8} maxLength={10_000} />
                </Form.Item>
                <Typography.Text type="secondary">
                  ↓ 模型按上方约定输出，再由下方规则展示
                </Typography.Text>
                <Form.Item
                  className="combo-processor-field"
                  name={['variants', index, 'processor_version_id']}
                  label="② 对应后处理 · 与本版预设配套"
                >
                  <Select options={processorOptions} />
                </Form.Item>
              </Card>
            ))}
          </div>
          <Space className="section-gap">
            <Button type="primary" htmlType="submit" disabled={sampleSets.length === 0}>
              确认运行规模与差异
            </Button>
          </Space>
        </Form>
      )}
      <ConfirmationModal
        context={context}
        sampleSets={sampleSets}
        values={confirmValues}
        onCancel={() => setConfirmValues(null)}
        onConfirm={(values) => createMutation.mutate(values)}
        confirmLoading={createMutation.isPending}
      />
    </section>
  );
}

function ConfirmationModal({
  context,
  sampleSets,
  values,
  onCancel,
  onConfirm,
  confirmLoading,
}: {
  context: BatchLabContext;
  sampleSets: BatchLabSampleSet[];
  values: ExperimentFormValues | null;
  onCancel: () => void;
  onConfirm: (values: ExperimentFormValues) => void;
  confirmLoading: boolean;
}) {
  const sampleSet = sampleSets.find((item) => item.id === values?.sample_set_id);
  const variants = values ? [makeVariant(values, 0, 'a'), makeVariant(values, 1, 'b')] : null;
  const plannedCalls = sampleSet && values ? sampleSet.sample_count * 2 * values.max_turns : 0;

  return (
    <Modal
      title="确认运行"
      open={values !== null}
      onCancel={onCancel}
      onOk={() => values && onConfirm(values)}
      okText="创建实验草稿"
      confirmLoading={confirmLoading}
      width={780}
    >
      {values && variants ? (
        <Space direction="vertical" size={16} className="full-width">
          <Descriptions bordered size="small" column={1}>
            <Descriptions.Item label="来源环境">{context.source_environment}</Descriptions.Item>
            <Descriptions.Item label="样本集">
              {sampleSet?.name ?? values.sample_set_id}
            </Descriptions.Item>
            <Descriptions.Item label="运行规模">{plannedCalls} 次计划调用</Descriptions.Item>
          </Descriptions>
          <Table
            size="small"
            rowKey="key"
            pagination={false}
            dataSource={variantDiffRows(variants[0], variants[1])}
            columns={[
              { title: '字段', dataIndex: 'label' },
              { title: '基准 A', dataIndex: 'baseline' },
              { title: '候选 B', dataIndex: 'candidate' },
            ]}
            scroll={{ x: 640 }}
          />
        </Space>
      ) : null}
    </Modal>
  );
}
