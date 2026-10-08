import { EvaluationPage, EvaluationResultsPage } from './components/AutomaticEvaluation';
import { ConversationMessages } from './components/ConversationMessages';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BatchLabContext,
  BatchLabExperimentResultDetail,
  BatchLabExperimentSummary,
  BatchLabExperimentVariant,
  BatchLabResultAttempt,
  BatchLabPreview,
  BatchLabSampleSet,
  BatchLabSampleSnapshot,
  BatchLabSqlTemplate,
  BatchLabSourceVersionSelection,
} from './lib/batch-lab-contracts';
import {
  BATCH_LAB_DEFAULT_SAMPLE_LIMIT,
  BATCH_LAB_MAX_EXPERIMENT_TURNS,
  BATCH_LAB_MAX_WORKER_CLAIM_LIMIT,
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
  createBatchLabSampleSet,
  deleteBatchLabExperiment,
  deleteBatchLabSampleSet,
  downloadBatchLabExperimentJsonl,
  downloadBatchLabAttemptOutput,
  getBatchLabAttemptContent,
  exportBatchLabCsvBundle,
  getBatchLabContext,
  getBatchLabExperiment,
  getBatchLabExperimentResults,
  getBatchLabSampleSet,
  getBatchLabSession,
  loginBatchLab,
  logoutBatchLab,
  importBatchLabSourceCsvFiles,
  listBatchLabDatasets,
  downloadBatchLabSourceCsv,
  listBatchLabAttemptEvents,
  retryBatchLabExperiment,
  listBatchLabExperiments,
  listBatchLabSampleSetSamples,
  listBatchLabSampleSets,
  listBatchLabSqlTemplates,
  runBatchLabExperimentWorkerOnce,
  startBatchLabExperiment,
  stopBatchLabExperiment,
  upsertBatchLabAnnotation,
} from './api/client';
import { batchLabQueryKeys } from './api/query-keys';
import { defaultDatasetName, datasetVersionLabel, datasetTableCount, datasetTableScope, SOURCE_TABLES, type DatasetVersion, type DatasetFileKind } from './lib/datasets';
import {
  experimentProgress,
  experimentStatusText,
  newIdempotencyKey,
  parseSqlParameters,
  variantDiffRows,
} from './lib/workbench';

const { Header, Content } = Layout;

const DEFAULT_EXPERIMENT_OPENROUTER_MODEL_ID = 'deepseek/deepseek-v4.1-flash';
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
const PAGE_SIZE = 5;

const DEFAULT_SAMPLE_SQL = `SELECT h.id AS source_history_id
FROM experience.chat_history AS h
JOIN app_core.characters AS c ON c.id = h.character_id
WHERE h.user_input IS NOT NULL
  AND h.model IS NOT NULL
  AND h.turn_index >= :min_turn
  AND h.revision >= 0
ORDER BY h.created_at DESC`;

type PageKey = 'experiments' | 'datasets' | 'samples' | 'new' | 'evaluations' | 'evaluation-results';

type ExperimentFormValues = {
  name: string;
  purpose: string;
  sample_set_id: string;
  max_turns: number;
  concurrency: number;
  sample_scope: 'all' | 'random';
  sample_limit: number;
  comparison_variable: 'instruction_prompt' | 'model';
  shared_provider_url: string;
  shared_instruction_prompt: string;
  run_mode: 'single' | 'multi_turn';
  variants: Array<{
    name: string;
    generation_mode: 'generate' | 'original';
    model_source: 'sample' | 'custom';
    provider_base_url: string;
    openrouter_model_id: string;
    output_preset_content: string;
  }>;
};

type SampleFormValues = {
  name: string;
  source_versions: BatchLabSourceVersionSelection;
  template_key: string | null;
  sample_limit: number;
  parameters_json: string;
  sql: string;
};

type SourceCsvFiles = {
  history: File | null;
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

function formatBeijingDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value));
}

function DatasetProvenanceDetails({ provenance }: { provenance: DatasetVersion['provenance'] }) {
  if (provenance?.source !== 'supabase') return null;
  return <Space direction="vertical" size={2}>
    <Typography.Text type="secondary">
      来源：{provenance.project_name ?? provenance.project_ref} · {provenance.schema}.{provenance.table}
    </Typography.Text>
    <Typography.Text type="secondary">
      北京时间：{formatBeijingDate(provenance.start_beijing)} 至 {formatBeijingDate(provenance.end_beijing_exclusive)}（不含结束时刻）
    </Typography.Text>
    <Typography.Text type="secondary">
      数据截至：{formatBeijingDate(provenance.snapshot_cutoff_utc)}（北京时间）
    </Typography.Text>
    {provenance.characters_scope ? <Typography.Text type="secondary">
      角色：{provenance.characters_scope === 'enabled_rows' ? '全部已启用（enabled=true），不限时间' : provenance.characters_scope === 'all_rows' ? '全表快照' : '关联角色快照'}
      {provenance.characters_snapshot_cutoff_utc ? ` · 导出时刻 ${formatBeijingDate(provenance.characters_snapshot_cutoff_utc)}（北京时间）` : ''}
    </Typography.Text> : null}
  </Space>;
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
  if (values.comparison_variable !== 'model' && variant.generation_mode === 'original') return {
    key, name: variant.name, generation_mode: 'original', model_id: 'original', openrouter_model_id: 'original',
    tier: null, is_free: true, sampling: {}, processor_version_id: null,
    max_turns: values.run_mode === 'single' ? 1 : values.max_turns,
  };
  const modelSource = values.comparison_variable === 'instruction_prompt' ? 'sample' : variant.model_source;
  const modelName = modelSource === 'sample' ? 'sample-original-model' : variant.openrouter_model_id.trim();
  const presetContent = variant.output_preset_content;
  return {
    key,
    generation_mode: 'generate',
    model_source: modelSource,
    name: variant.name,
    model_id: modelName,
    openrouter_model_id: modelName,
    tier: null,
    is_free: false,
    sampling: {},
    processor_version_id: null,
    max_turns: values.run_mode === 'single' ? 1 : values.max_turns,
    provider_config: {
      base_url: values.shared_provider_url.trim() || DEFAULT_OPENROUTER_BASE_URL,
      key_ref: 'BATCH_LAB_MODEL_KEY',
      module_name: modelName,
    },
    output_preset: values.comparison_variable === 'model' ? { name: '两组共用 Instruction prompt', content: values.shared_instruction_prompt, format: '' } : {
      name: `${variant.name} Instruction prompt`,
      content: presetContent,
      format: '',
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

function useWorkbenchData(context: BatchLabContext, page: PageKey) {
  const templates = useQuery({
    queryKey: batchLabQueryKeys.templates(context),
    queryFn: ({ signal }) => listBatchLabSqlTemplates(signal),
  });
  const sampleSets = useQuery({
    queryKey: batchLabQueryKeys.sampleSets(context),
    queryFn: ({ signal }) => listBatchLabSampleSets(signal),
  });
  const experiments = useQuery({
    queryKey: batchLabQueryKeys.experiments(context),
    queryFn: ({ signal }) => listBatchLabExperiments(signal),
    enabled: page === 'experiments' || page === 'evaluations' || page === 'evaluation-results',
    refetchIntervalInBackground: false,
    refetchInterval: (query) => {
      const items = query.state.data ?? [];
      return items.some((item) => item.status === 'queued' || item.status === 'running')
        ? 5_000
        : false;
    },
  });
  return { templates, sampleSets, experiments };
}

export function App() {
  const [page, setPage] = useState<PageKey>('new');
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: batchLabQueryKeys.session,
    queryFn: getBatchLabSession,
    retry: false,
  });
  const contextQuery = useQuery({
    queryKey: batchLabQueryKeys.context,
    queryFn: ({ signal }) => getBatchLabContext(signal),
    retry: false,
    staleTime: 60_000,
    enabled: sessionQuery.data?.authenticated === true,
  });

  if (sessionQuery.isPending) return <Skeleton active style={{ padding: 32 }} />;
  if (sessionQuery.isError) {
    return <Result status="error" title="无法连接团队空间" subTitle={errorMessage(sessionQuery.error)}
      extra={<Button onClick={() => sessionQuery.refetch()}>重新连接</Button>} />;
  }
  if (!sessionQuery.data.authenticated) {
    return <TeamAccess onSuccess={() => queryClient.invalidateQueries({ queryKey: batchLabQueryKeys.session })} />;
  }
  if (contextQuery.isPending) return <Skeleton active style={{ padding: 32 }} />;
  if (contextQuery.isError) {
    return (
      <Result
        status="error"
        title="无法确认运行环境"
        subTitle={errorMessage(contextQuery.error)}
        extra={<Button onClick={() => contextQuery.refetch()}>重新连接</Button>}
      />
    );
  }

  return <WorkbenchShell context={contextQuery.data} page={page} onPageChange={setPage}
    requiresKey={sessionQuery.data.requires_key} />;
}

function TeamAccess({ onSuccess }: { onSuccess: () => Promise<unknown> }) {
  const mutation = useMutation({
    mutationFn: (values: { accessKey: string }) => loginBatchLab(values.accessKey),
    onSuccess,
    onError: (error) => message.error(errorMessage(error)),
  });
  return <div className="team-access"><Card title="进入团队空间">
    <Typography.Paragraph type="secondary">输入团队共享口令，即可使用同一份数据、样本与实验记录。</Typography.Paragraph>
    <Form layout="vertical" onFinish={(values) => mutation.mutate(values)}>
      <Form.Item name="accessKey" label="团队口令" rules={[{ required: true, message: '请输入团队口令' }]}>
        <Input.Password autoComplete="current-password" />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={mutation.isPending}>进入</Button>
    </Form>
  </Card></div>;
}

function WorkbenchShell({
  context,
  page,
  onPageChange,
  requiresKey,
}: {
  context: BatchLabContext;
  page: PageKey;
  onPageChange: (page: PageKey) => void;
  requiresKey: boolean;
}) {
  const queryClient = useQueryClient();
  const data = useWorkbenchData(context, page);
  const [sampleSource, setSampleSource] = useState<{ id: string } | null>(null);
  const [openedDataPages, setOpenedDataPages] = useState({ datasets: false, samples: false });
  useEffect(() => {
    if (page === 'datasets' || page === 'samples') setOpenedDataPages(current => current[page] ? current : { ...current, [page]: true });
  }, [page]);
  const logoutMutation = useMutation({
    mutationFn: logoutBatchLab,
    onSuccess: () => {
      queryClient.setQueryData(batchLabQueryKeys.session, { authenticated: false, requires_key: true });
      queryClient.removeQueries({ predicate: (query) => query.queryKey[1] !== 'session' });
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const anyError = [data.templates, data.sampleSets, data.experiments].find(
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
            { key: 'datasets', label: '原始数据' },
            { key: 'samples', label: '样本集' },
            { key: 'new', label: '新建实验' },
            { key: 'evaluations', label: '大模型评估' },
            { key: 'evaluation-results', label: '评估结果' },
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
            团队共享空间 · 原始数据、冻结样本与实验记录均保存在云端。
          </Typography.Text>
          {requiresKey ? <Button type="text" loading={logoutMutation.isPending} onClick={() => logoutMutation.mutate()}>退出空间</Button> : null}
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
        {page === 'evaluations' ? <EvaluationPage experiments={data.experiments.data ?? []} loading={data.experiments.isFetching} /> : null}
        {page === 'evaluation-results' ? <EvaluationResultsPage experiments={data.experiments.data ?? []} /> : null}
        {page === 'datasets' || openedDataPages.datasets ? <div hidden={page !== 'datasets'}><SourceDataPage context={context} onBuildSample={(id) => {
          setSampleSource({id});
          onPageChange('samples');
        }} /></div> : null}
        {page === 'samples' || openedDataPages.samples ? <div hidden={page !== 'samples'}>
          <SamplesPage
            context={context}
            templates={data.templates.data ?? []}
            sampleSets={data.sampleSets.data ?? []}
            loading={data.templates.isPending || data.sampleSets.isPending}
            initialDataset={sampleSource}
            onOpenDatasets={() => onPageChange('datasets')}
          />
        </div> : null}
        {page === 'new' ? (
          <ExperimentWizard
            context={context}
            sampleSets={data.sampleSets.data ?? []}
            loading={data.sampleSets.isPending}
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
    onSuccess: (started) => {
      message.success('实验已启动');
      queryClient.setQueryData<BatchLabExperimentSummary[]>(batchLabQueryKeys.experiments(context), current =>
        current?.map(item => item.id === started.id ? started : item));
      void invalidateExperiments();
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
  const retryMutation = useMutation({
    mutationFn: (experiment: BatchLabExperimentSummary) =>
      retryBatchLabExperiment({ experiment_id: experiment.id }),
    onSuccess: async () => {
      message.success('失败或中断的任务已重新排队，原有运行记录已保留');
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
  const executeAllMutation = useMutation({
    mutationFn: async (experiment: BatchLabExperimentSummary) => {
      const total = { claimed: 0, completed: 0, failed: 0 };
      // 每批按实验保存的并发数领取任务。
      for (;;) {
        const result = await runBatchLabExperimentWorkerOnce({
          experiment_id: experiment.id,
          source_environment: context.source_environment,
          worker_id: `batch-lab-ui-${newIdempotencyKey()}`,
          claim_limit: experiment.concurrency ?? 4,
        });
        total.claimed += result.claimed_count;
        total.completed += result.completed_count;
        total.failed += result.failed_count;
        await invalidateExperiments();
        if (result.claimed_count === 0) return total;
      }
    },
    onSuccess: async (result, experiment) => {
      if (result.claimed === 0) {
        message.info(`“${experiment.name}”当前没有可领取的任务，可能已有任务正在执行或等待前一轮完成`);
      } else {
        message.success(`“${experiment.name}”本轮执行结束：成功 ${result.completed}，失败 ${result.failed}；整体进度以实验状态为准`);
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
          {record.status === 'draft' ? <Button
            type="primary"
            loading={startMutation.isPending && startMutation.variables?.id === record.id}
            onClick={() => startMutation.mutate(record)}
          >启动</Button> : null}
          {record.status === 'queued' || record.status === 'running' ? <>
            <Button type="primary"
              loading={executeAllMutation.isPending && executeAllMutation.variables?.id === record.id}
              onClick={() => confirmExecuteAll(record)}
            >全部执行</Button>
            <Button loading={stopMutation.isPending && stopMutation.variables?.id === record.id}
              onClick={() => stopMutation.mutate(record)}
            >停止</Button>
          </> : <Button danger
            loading={deleteMutation.isPending && deleteMutation.variables?.id === record.id}
            onClick={() => confirmDelete(record)}
          >删除</Button>}
          {record.status !== 'running' && record.status !== 'queued' &&
            (record.failed_attempts > 0 || record.status === 'cancelled' || record.status === 'failed') ? <Button
              loading={retryMutation.isPending && retryMutation.variables?.id === record.id}
              onClick={() => retryMutation.mutate(record)}
            >{record.status === 'cancelled' ? '恢复未完成任务' : '重试失败任务'}</Button> : null}
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
            运行进度与每次执行记录保存在云端。多人打开同一实验会共享进度；独立对比请复制实验。
          </Typography.Text>
        </div>
      </div>
      <Table
        rowKey="id"
        className="work-table"
        columns={columns}
        dataSource={experiments}
        pagination={{ pageSize: PAGE_SIZE, showSizeChanger: false }}
        locale={{ emptyText: '暂无实验，先创建并启动一个 A/B 组合。' }}
        scroll={{ x: 840 }}
      />
      {selected ? <ExperimentDrawer key={selected.id} context={context}
        experiment={experiments.find((item) => item.id === selected.id) ?? selected}
        onClose={() => setSelected(null)} /> : null}
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
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [eventsOpen, setEventsOpen] = useState(false);
  const cursor = cursors[pageIndex];
  const detailQuery = useQuery({
    queryKey: experiment
      ? batchLabQueryKeys.experimentResults(context, experiment.id, cursor)
      : [...batchLabQueryKeys.experiments(context), 'none'],
    queryFn: ({ signal }) =>
      getBatchLabExperimentResults(experiment?.id ?? '', { limit: PAGE_SIZE, cursor }, signal),
    enabled: experiment !== null,
    refetchIntervalInBackground: false,
    refetchInterval: (query) => {
      const status = query.state.data?.experiment.status ?? experiment?.status;
      return status === 'queued' || status === 'running' ? 5_000 : false;
    },
  });
  const eventsQuery = useQuery({
    queryKey: batchLabQueryKeys.attemptEvents(context, experiment?.id ?? 'none'),
    queryFn: ({ signal }) => listBatchLabAttemptEvents(experiment?.id ?? '', signal),
    enabled: experiment !== null && eventsOpen,
    refetchIntervalInBackground: false,
    refetchInterval: experiment?.status === 'running' || experiment?.status === 'queued' ? 5_000 : false,
  });
  const resultDetail = detailQuery.data;
  const detail = resultDetail?.experiment;
  const variants = detail?.variants ?? experiment?.variants ?? [];
  const diffRows = variants.length >= 2 ? variantDiffRows(variants[0], variants[1]) : [];
  const [selectedSampleOrdinal, setSelectedSampleOrdinal] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
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
        queryKey: batchLabQueryKeys.experiment(context, experiment.id),
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
    onSuccess: async () => {
      message.success('备注已保存');
      await invalidateExperiments();
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const preferenceMutation = useMutation({
    mutationFn: ({ ordinal, turn, tag }: { ordinal: number; turn: number; tag: string | null }) => {
      if (!experiment) throw new Error('请选择实验');
      const existing = resultDetail?.annotations.find(item => item.sample_ordinal === ordinal && item.turn_index === turn);
      return upsertBatchLabAnnotation({ experiment_id: experiment.id, sample_ordinal: ordinal, turn_index: turn,
        tag, note: existing?.note ?? null, source_environment: context.source_environment });
    },
    onSuccess: async () => { message.success('本轮评价已保存'); await detailQuery.refetch(); },
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
            <Button loading={exportMutation.isPending} onClick={() => exportMutation.mutate()}>
              导出 JSONL
            </Button>
          </Space>
          <Descriptions bordered size="small" column={1}>
            <Descriptions.Item label="状态">
              {experimentStatusText(detail?.status ?? experiment.status)}
            </Descriptions.Item>
            <Descriptions.Item label="样本集">
              {resultDetail?.sample_set.name ?? detail?.sample_set_id ?? experiment.sample_set_id}
              {resultDetail?.sample_set.version ? ` · 样本 v${resultDetail.sample_set.version}` : ''}
            </Descriptions.Item>
            <Descriptions.Item label="版本链">
              {resultDetail ? <VersionLineage sampleSet={resultDetail.sample_set} experimentId={experiment.id} /> : '加载中'}
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
            <Descriptions.Item label="对比变量">{(detail?.comparison_variable ?? experiment.comparison_variable) === 'model' ? '模型（手动指令共用）' : (detail?.comparison_variable ?? experiment.comparison_variable) === 'instruction_prompt' ? 'Instruction prompt（样本模型固定）' : '历史实验'}</Descriptions.Item>
            <Descriptions.Item label="并发请求数">{detail?.concurrency ?? experiment.concurrency ?? 4} 个 / 批</Descriptions.Item>
            <Descriptions.Item label="样本范围">{(detail?.selected_sample_ordinals ?? experiment.selected_sample_ordinals)?.length
              ? `随机调试 · ${(detail?.selected_sample_ordinals ?? experiment.selected_sample_ordinals)?.length} 条`
              : '全部样本'}</Descriptions.Item>
            <Descriptions.Item label="进度">
              {detail?.completed_attempts ?? experiment.completed_attempts} 成功 / {detail?.failed_attempts ?? experiment.failed_attempts} 失败 /{' '}
              {detail?.total_attempts ?? experiment.total_attempts} 总任务
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
          {resultDetail?.comparison_summary ? <Card title="结果汇总 · 整个实验" size="small">
            <div className="stats-grid">
              <Statistic title={`A 胜 · ${variants[0]?.name ?? '基准'}`} value={resultDetail.comparison_summary.a_wins} />
              <Statistic title={`B 胜 · ${variants[1]?.name ?? '候选'}`} value={resultDetail.comparison_summary.b_wins} />
              <Statistic title="平局" value={resultDetail.comparison_summary.ties} />
              <Statistic title="未评价" value={resultDetail.comparison_summary.unrated} />
            </div>
            <Typography.Paragraph type="secondary">
              按“样本 × 对比轮次”统计，共 {resultDetail.comparison_summary.total} 组，不受当前分页影响。
              未评价中有 {resultDetail.comparison_summary.awaiting_results} 组尚未完成两组结果；只将已完成的对比计入胜负。
            </Typography.Paragraph>
            <Table size="small" pagination={false} scroll={{ x: 760 }}
              rowKey={row => JSON.stringify([row.model_a, row.model_b])}
              dataSource={resultDetail.comparison_summary.by_model} columns={[
                { title: 'A 模型', dataIndex: 'model_a' }, { title: 'B 模型', dataIndex: 'model_b' },
                { title: 'A 胜', dataIndex: 'a_wins' }, { title: 'B 胜', dataIndex: 'b_wins' },
                { title: '平局', dataIndex: 'ties' }, { title: '未评价', dataIndex: 'unrated' }, { title: '合计', dataIndex: 'total' },
              ]} />
          </Card> : null}
          <Card title="查看对比 · 模型原文" size="small">
            {detailQuery.isError ? <Alert type="error" message={errorMessage(detailQuery.error)} /> : null}
            <CursorPagination pageIndex={pageIndex} loading={detailQuery.isFetching}
              nextCursor={resultDetail?.next_sample_cursor ?? null}
              onPrevious={() => { setPageIndex((value) => value - 1); setSelectedSampleOrdinal(null); }}
              onNext={(next) => { setCursors((values) => [...values.slice(0, pageIndex + 1), next]); setPageIndex((value) => value + 1); setSelectedSampleOrdinal(null); }} />
            {activeSample ? (
              <Space direction="vertical" size={14} className="full-width">
                <Select
                  value={activeSample.ordinal}
                  onChange={(value) => { setSelectedSampleOrdinal(value); }}
                  options={(resultDetail?.samples ?? []).map((sample) => ({
                    value: sample.ordinal,
                    label: `样本 #${sample.ordinal} · 第 ${sample.turn_index} 轮`,
                  }))}
                />
                <Typography.Text type="secondary">样本 #{activeSample.ordinal} · 截至原对话第 {activeSample.turn_index} 轮 · 样本记录模型：{activeSample.original_model}</Typography.Text>
                <Collapse size="small" items={[{
                  key: 'context', label: '共同前文 · 未重跑对话（相同变量）',
                  children: <Space direction="vertical" className="full-width">
                    {activeSample.preview_truncated ? <Alert type="info" message="共同前文为预览，完整内容保存在样本快照中。" /> : null}
                    <ConversationMessages turnModels={activeSample.turn_models} messages={activeSample.history.slice(0, activeSample.replay_start_index ?? activeSample.history.length)} />
                  </Space>,
                }]} />
                <Collapse key={activeSample.ordinal} className="full-width" items={activeTurns.map(turn => {
                  const attempts = variants.map(variant => activeSampleAttempts.find(item => item.variant_key === variant.key && item.turn_index === turn));
                  const annotation = resultDetail?.annotations.find(item => item.sample_ordinal === activeSample.ordinal && item.turn_index === turn);
                  const voteOptions = [
                    ...variants.map(variant => ({ value: `preference:${variant.key}`, label: `${variant.name} 更好` })),
                    { value: 'preference:tie', label: '平局' },
                  ];
                  const verdict = voteOptions.find(option => option.value === annotation?.tag)?.label ?? '未评价';
                  const input = attempts.find(attempt => attempt?.replay_user_input)?.replay_user_input;
                  return {
                    key: String(turn), label: `对比第 ${turn} 轮 · ${verdict}`,
                    children: <Space direction="vertical" className="full-width" size={14}>
                      <Typography.Text type="secondary">本轮用户输入 · 两组相同</Typography.Text>
                      <ConversationMessages startTurn={turn} messages={[{ role: 'user', content: input ?? '等待执行后显示' }]} />
                      <div className="two-column full-width">
                        {variants.map((variant, index) => (
                          <ComparisonOutput key={attempts[index]?.attempt_id ?? variant.key} variant={variant} attempt={attempts[index]} turn={turn} />
                        ))}
                      </div>
                      <Space wrap>
                        <Typography.Text>本轮哪组更好？</Typography.Text>
                        <Select aria-label={`第 ${turn} 轮评价`} style={{ minWidth: 220 }} allowClear placeholder="请选择评价"
                          options={voteOptions} value={annotation?.tag ?? undefined}
                          disabled={!attempts.length || attempts.some(attempt => attempt?.status !== 'succeeded') || preferenceMutation.isPending}
                          loading={preferenceMutation.isPending && preferenceMutation.variables?.ordinal === activeSample.ordinal && preferenceMutation.variables?.turn === turn}
                          onChange={tag => preferenceMutation.mutate({ ordinal: activeSample.ordinal, turn, tag: tag ?? null })} />
                        <Typography.Text type="secondary">自动保存，团队可见</Typography.Text>
                      </Space>
                    </Space>,
                  };
                })} />
                {!activeTurns.length ? <Typography.Text type="secondary">启动实验后显示逐轮对比。</Typography.Text> : null}
              </Space>
            ) : detailQuery.isPending ? <Skeleton active /> : <Typography.Text type="secondary">本页暂无样本。</Typography.Text>}
          </Card>
          <Collapse className="full-width" onChange={(keys) => setEventsOpen(keys.includes('events'))}
            items={[{ key: 'events', label: '运行日志 · 最近 100 条执行与保存事件', children: <>
              {eventsQuery.isError ? <Alert type="error" message={errorMessage(eventsQuery.error)} /> : null}
              <Table rowKey="id" size="small" loading={eventsQuery.isPending}
                dataSource={eventsQuery.data ?? []} pagination={{ pageSize: PAGE_SIZE, showSizeChanger: false }}
                locale={{ emptyText: '尚无运行事件。' }} columns={[
                  { title: '时间', dataIndex: 'created_at', render: (value: string) => formatDate(value) },
                  { title: '事件', dataIndex: 'event_type' },
                  { title: '任务', dataIndex: 'attempt_id', render: (value: string) => <Typography.Text code>{value}</Typography.Text> },
                  { title: '详情', dataIndex: 'data', render: (value: unknown) => <pre className="event-data">{JSON.stringify(value, null, 2)}</pre> },
                ]} scroll={{ x: 680 }} />
            </> }]} />
          <Card title="实验备注" size="small">
            <Input.TextArea rows={4} placeholder="记录观察，不参与评分。" aria-label="实验备注"
              value={note ?? resultDetail?.annotations.find((item) => item.sample_ordinal === null && item.turn_index === null)?.note ?? ''}
              onChange={(event) => setNote(event.target.value)} />
            <Button
              className="section-gap"
              loading={annotationMutation.isPending}
              onClick={() => annotationMutation.mutate(note ?? resultDetail?.annotations.find((item) => item.sample_ordinal === null && item.turn_index === null)?.note ?? '')}
            >
              保存备注
            </Button>
          </Card>
        </Space>
      ) : null}
    </Drawer>
  );
}

function ComparisonOutput({ variant, attempt, turn }: { variant: BatchLabExperimentVariant; attempt?: BatchLabResultAttempt; turn: number }) {
  const [expanded, setExpanded] = useState(false);
  const fullOutput = useQuery({
    queryKey: ['attempt-output', attempt?.attempt_id, attempt?.raw_output],
    queryFn: ({ signal }) => getBatchLabAttemptContent(attempt!.attempt_id, 'raw_output', signal),
    enabled: expanded && !!attempt?.preview_truncated,
  });
  const downloadOutput = useMutation({
    mutationFn: () => downloadBatchLabAttemptOutput(attempt!.attempt_id),
    onError: error => message.error(errorMessage(error)),
  });
  return <Card size="small" title={variant.name}>
    <Space wrap>
      <Tag>{variant.generation_mode === 'original' ? '原始线上回复 · 固定' : '重新生成'}</Tag>
      <Tag>{attempt?.request_model ?? (variant.model_source === 'sample' || variant.generation_mode === 'original' ? '样本原始模型' : variant.openrouter_model_id)}</Tag>
      <Tag>{attempt?.status ?? 'pending'}</Tag>
    </Space>
    {attempt?.preview_truncated ? <Space wrap className="section-gap">
      <Button loading={fullOutput.isFetching} onClick={() => setExpanded(value => !value)}>{expanded ? '收起完整结果' : '展开完整结果'}</Button>
      <Button loading={downloadOutput.isPending} onClick={() => downloadOutput.mutate()}>下载完整原文</Button>
    </Space> : null}
    {fullOutput.isError ? <Alert type="error" message={errorMessage(fullOutput.error)} /> : null}
    <ConversationMessages startTurn={turn} messages={[{ role: 'assistant', content: expanded && fullOutput.data !== undefined ? fullOutput.data : attempt?.raw_output ?? attempt?.error_message ?? '暂无输出' }]} />
  </Card>;
}

function CursorPagination({ pageIndex, nextCursor, loading, onPrevious, onNext }: {
  pageIndex: number;
  nextCursor: string | null;
  loading: boolean;
  onPrevious: () => void;
  onNext: (cursor: string) => void;
}) {
  return <Space wrap className="cursor-pagination">
    <Button disabled={pageIndex === 0 || loading} onClick={onPrevious}>上一页</Button>
    <Typography.Text type="secondary">第 {pageIndex + 1} 页 · 每页最多 {PAGE_SIZE} 条</Typography.Text>
    <Button disabled={!nextCursor || loading} onClick={() => { if (nextCursor) onNext(nextCursor); }}>下一页</Button>
  </Space>;
}

function SourceVersionSummary({ source }: { source: Pick<BatchLabPreview, 'source_versions' | 'dataset_version_id' | 'dataset_version_number' | 'dataset_version_name'> }) {
  return <Space direction="vertical" size={4} className="source-version-summary">
    {SOURCE_TABLES.map(({kind, label, table}) => {
      const version = source.source_versions?.[kind];
      const number = version?.dataset_version_number ?? source.dataset_version_number;
      const name = version?.dataset_version_name ?? source.dataset_version_name;
      const id = version?.dataset_version_id ?? source.dataset_version_id;
      return <div key={kind} title={`${table} · ${id ?? '旧样本未记录来源 ID'}`}>
        <Tag>{label}{number ? ` · 原始 v${number}` : ' · 原始版本'}</Tag>
        <Typography.Text>{name ?? id ?? '旧样本未记录版本'}</Typography.Text>
        {version ? <Typography.Text type="secondary"> · {version.row_count.toLocaleString()} 条</Typography.Text> : null}
      </div>;
    })}
    {source.source_versions?.sessions ? <Typography.Text type="secondary">
      历史会话来源：原始 v{source.source_versions.sessions.dataset_version_number} · {source.source_versions.sessions.dataset_version_name}
    </Typography.Text> : null}
  </Space>;
}

function VersionLineage({ sampleSet, experimentId }: { sampleSet: BatchLabSampleSet; experimentId?: string }) {
  return <Space wrap size={4}>
    <SourceVersionSummary source={sampleSet} />
    <span aria-hidden>→</span>
    <Tag color="blue">{sampleSet.version ? `样本 v${sampleSet.version}` : '冻结样本'} · {sampleSet.name}</Tag>
    {experimentId ? <><span aria-hidden>→</span><Tag color="purple">实验 {experimentId.slice(0, 8)}</Tag></> : null}
  </Space>;
}

function SourceDataPage({ context, onBuildSample }: {
  context: BatchLabContext;
  onBuildSample: (datasetId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [datasetName, setDatasetName] = useState(defaultDatasetName);
  const [uploadProgress, setUploadProgress] = useState(0);
  const datasetsQuery = useQuery({
    queryKey: batchLabQueryKeys.datasets(context),
    queryFn: ({ signal }) => listBatchLabDatasets(signal),
    refetchOnMount: 'always',
  });
  const datasets = datasetsQuery.data ?? [];
  const [sourceCsvFiles, setSourceCsvFiles] = useState<SourceCsvFiles>({
    history: null,
    characters: null,
  });
  const historyInputRef = useRef<HTMLInputElement>(null);
  const charactersInputRef = useRef<HTMLInputElement>(null);
  const sourceImportMutation = useMutation({
    mutationFn: () => {
      if (!sourceCsvFiles.history || !sourceCsvFiles.characters) {
        throw new Error('请先选择 chat_history 和 characters 两个 CSV 文件');
      }
      setUploadProgress(0);
      return importBatchLabSourceCsvFiles({
        historyFile: sourceCsvFiles.history,
        charactersFile: sourceCsvFiles.characters,
        name: datasetName.trim() || defaultDatasetName(),
        onProgress: setUploadProgress,
      });
    },
    onSuccess: async (result) => {
      setUploadProgress(100);
      queryClient.setQueryData<DatasetVersion[]>(batchLabQueryKeys.datasets(context), (current = []) =>
        [result.dataset, ...current.filter((item) => item.id !== result.dataset.id)]);
      setSourceCsvFiles({ history: null, characters: null });
      setDatasetName(defaultDatasetName());
      message.success(
        `${datasetVersionLabel(result.dataset)} 已保存：${result.history_count} 条聊天记录、${result.character_count} 条角色卡`
      );
      await queryClient.invalidateQueries({ queryKey: batchLabQueryKeys.datasets(context) });
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const downloadMutation = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: DatasetFileKind }) => downloadBatchLabSourceCsv(id, kind),
    onError: (error) => message.error(errorMessage(error)),
  });

  const selectSourceCsvFile = (key: keyof SourceCsvFiles, file: File | null) => {
    setSourceCsvFiles((current) => ({ ...current, [key]: file }));
  };

  return <section className="section-gap">
    <div className="page-head">
      <div>
        <Typography.Title level={2}>原始数据</Typography.Title>
        <Typography.Text type="secondary">导入并保存原始数据版本，查看来源范围和下载原文件。使用这些数据构建样本，请进入“样本集”。</Typography.Text>
      </div>
    </div>
      <Card className="section-gap" title="导入原始数据版本">
        <Alert
          type="info"
          showIcon
          message="聊天记录和角色卡两个 CSV 组成一个不可变版本，保留原文件供团队下载。再次导入会创建新版本，已有样本与实验不受影响。"
        />
        <div className="dataset-name-field"><Typography.Text>版本名称</Typography.Text>
          <Input aria-label="原始数据版本名称" maxLength={120} value={datasetName} onChange={(event) => setDatasetName(event.target.value)} disabled={sourceImportMutation.isPending} /></div>
        <div className="form-grid two source-import-grid">
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
            ref={charactersInputRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(event) => {
              selectSourceCsvFile('characters', event.target.files?.[0] ?? null);
              event.target.value = '';
            }}
          />
          <Button disabled={sourceImportMutation.isPending} onClick={() => historyInputRef.current?.click()}>
            {csvFileButtonLabel(sourceCsvFiles.history, '选择 chat_history_rows.csv')}
          </Button>
          <Button disabled={sourceImportMutation.isPending} onClick={() => charactersInputRef.current?.click()}>
            {csvFileButtonLabel(sourceCsvFiles.characters, '选择 characters_rows.csv')}
          </Button>
        </div>
        <Space className="section-gap" wrap>
          <Button
            type="primary"
            loading={sourceImportMutation.isPending}
            disabled={
              !sourceCsvFiles.history || !sourceCsvFiles.characters
            }
            onClick={() => sourceImportMutation.mutate()}
          >
            上传并保存新版本
          </Button>
          <Typography.Text type="secondary">
            上传保存后，在下方版本列表点击“构建样本集”，即可进入 SQL 抽样。
          </Typography.Text>
        </Space>
        {sourceImportMutation.isPending || uploadProgress > 0 ? <Progress percent={Math.round(uploadProgress)}
          status={sourceImportMutation.isError ? 'exception' : sourceImportMutation.isPending ? 'active' : 'success'}
          format={(value) => `${value}%${sourceImportMutation.isPending && value === 100 ? ' · 校验保存中' : ''}`} /> : null}
      </Card>
      <Card className="section-gap" title="原始数据版本">
        {datasetsQuery.isError ? <Alert type="error" message={errorMessage(datasetsQuery.error)} /> : null}
        <Table<DatasetVersion> rowKey="id" loading={datasetsQuery.isFetching} dataSource={datasets}
          pagination={{ pageSize: PAGE_SIZE, showSizeChanger: false }} scroll={{ x: 900 }}
          locale={{ emptyText: '上传聊天记录和角色卡两个 CSV，创建第一个原始数据版本。' }}
          columns={[
            { title: '版本', render: (_, item) => <Space direction="vertical" size={2}><Typography.Text strong>{datasetVersionLabel(item)}</Typography.Text><Typography.Text type="secondary">{formatDate(item.created_at)}</Typography.Text><DatasetProvenanceDetails provenance={item.provenance} /></Space> },
            { title: '数据量', render: (_, item) => `${item.history_count} 条聊天记录 / ${item.character_count} 条角色卡` },
            { title: '状态', render: (_, item) => <Tag color={item.status === 'ready' ? 'green' : 'orange'}>{item.status === 'ready' ? '已冻结' : '上传中'}</Tag> },
            { title: '操作', render: (_, item) => <Space wrap>
              <Button disabled={item.status !== 'ready'} onClick={() => onBuildSample(item.id)}>构建样本集</Button>
              {(['history', 'characters'] as const).map((kind) => <Button key={kind} size="small" disabled={item.status !== 'ready'}
                title={item.files.find((file) => file.kind === kind)?.name}
                loading={downloadMutation.isPending && downloadMutation.variables?.id === item.id && downloadMutation.variables?.kind === kind}
                onClick={() => downloadMutation.mutate({ id: item.id, kind })}>下载 {kind}</Button>)}
            </Space> },
          ]} />
      </Card>
  </section>;
}

function SamplesPage({
  context,
  templates,
  sampleSets,
  loading,
  initialDataset,
  onOpenDatasets,
}: {
  context: BatchLabContext;
  templates: BatchLabSqlTemplate[];
  sampleSets: BatchLabSampleSet[];
  loading: boolean;
  initialDataset: { id: string } | null;
  onOpenDatasets: () => void;
}) {
  const queryClient = useQueryClient();
  const [form] = Form.useForm<SampleFormValues>();
  const [savedSampleSet, setSavedSampleSet] = useState<BatchLabSampleSet | null>(null);
  const selectionInitialized = useRef(false);
  const appliedDataset = useRef<{ id: string } | null>(null);
  const previewRevision = useRef(0);
  const selectedSources = Form.useWatch('source_versions', form) as BatchLabSourceVersionSelection | undefined;
  const datasetsQuery = useQuery({
    queryKey: batchLabQueryKeys.datasets(context),
    queryFn: ({ signal }) => listBatchLabDatasets(signal),
    refetchOnMount: 'always',
  });
  const readyDatasets = (datasetsQuery.data ?? []).filter((item) => item.status === 'ready').sort((a, b) => b.version - a.version);
  useEffect(() => {
    // Wait for a fresh response before selecting a default; an older cache must not win.
    if (!datasetsQuery.isFetchedAfterMount || !datasetsQuery.isSuccess || datasetsQuery.isFetching) return;
    const explicitSelection = initialDataset !== null && initialDataset !== appliedDataset.current;
    if (selectionInitialized.current && !explicitSelection) return;
    const available = datasetsQuery.data?.filter((item) => item.status === 'ready').sort((a, b) => b.version - a.version) ?? [];
    const newest = explicitSelection ? available.find(item => item.id === initialDataset.id) : available[0];
    if (!newest) return;
    if (explicitSelection || !form.getFieldValue('source_versions')) {
      form.setFieldValue('source_versions', {history:newest.id,characters:newest.id});
      previewRevision.current += 1;
      setPreview(null);
    }
    appliedDataset.current = initialDataset;
    selectionInitialized.current = true;
  }, [datasetsQuery.isFetchedAfterMount, datasetsQuery.isSuccess, datasetsQuery.isFetching, datasetsQuery.data, form, initialDataset]);
  const [preview, setPreview] = useState<BatchLabPreview | null>(null);
  const invalidatePreview = () => { previewRevision.current += 1; setPreview(null); };
  const [selectedSampleSet, setSelectedSampleSet] = useState<BatchLabSampleSet | null>(null);
  const defaultTemplate = templates[0];

  const templateOptions = templates.map((template) => ({
    value: `${template.key}:${template.version}`,
    label: `${template.name} · v${template.version}`,
  }));

  const previewMutation = useMutation({
    mutationFn: ({values}: {values: SampleFormValues; revision: number}) => {
      if (!SOURCE_TABLES.every(({kind})=>values.source_versions?.[kind])) throw new Error('请先为聊天记录和角色卡分别选择原始数据版本');
      const template =
        values.template_key === null
          ? null
          : (templates.find((item) => `${item.key}:${item.version}` === values.template_key) ??
            null);
      return createBatchLabPreview({
        source_environment: context.source_environment,
        source_versions: values.source_versions,
        template_key: template?.key ?? null,
        template_version: template?.version ?? null,
        sql: values.sql,
        parameters: parseSqlParameters(values.parameters_json),
        sample_limit: values.sample_limit,
      });
    },
    onSuccess: (value, {revision}) => {
      if (previewRevision.current === revision) {
        setPreview(value);
      }
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
    onSuccess: async (sampleSet) => {
      message.success(`样本${sampleSet.version ? ` v${sampleSet.version}` : ''}已冻结并共享`);
      setSavedSampleSet(sampleSet);
      setPreview(null);
      await queryClient.invalidateQueries({ queryKey: batchLabQueryKeys.sampleSets(context) });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const applyTemplate = (value: string | null) => {
    const template = templates.find((item) => `${item.key}:${item.version}` === value);
    if (!template) return;
    form.setFieldsValue({
      sql: template.sql,
      parameters_json: JSON.stringify(
        template.default_parameters,
        null,
        2
      ),
    });
    invalidatePreview();
  };


  return (
    <section className="section-gap">
      <div className="page-head">
        <div>
          <Typography.Title level={2}>样本集</Typography.Title>
          <Typography.Text type="secondary">
            先为聊天记录和角色卡分别选择来源版本，再用 SQL 关联抽样。保存后固定两表来源和样本快照，供团队复用。
          </Typography.Text>
        </div>
        <Button onClick={onOpenDatasets}>管理原始数据</Button>
      </div>
      {datasetsQuery.isError ? <Alert className="section-gap" type="error" message={errorMessage(datasetsQuery.error)} /> : null}
      {datasetsQuery.isSuccess && readyDatasets.length === 0 ? <Alert className="section-gap" type="info" message="还没有可用的原始数据版本" action={<Button onClick={onOpenDatasets}>去导入原始数据</Button>} /> : null}
      <Typography.Title level={4} className="section-gap">冻结样本版本</Typography.Title>
      {savedSampleSet ? <Alert className="section-gap" type="success" showIcon message="冻结样本已保存，团队成员可在新建实验中选择"
        description={<VersionLineage sampleSet={savedSampleSet} />} /> : null}
      <Table
        rowKey="id"
        loading={loading}
        dataSource={sampleSets}
        pagination={{ pageSize: PAGE_SIZE, showSizeChanger: false }}
        scroll={{ x: 820 }}
        columns={[
          { title: '版本链', render: (_, record) => <VersionLineage sampleSet={record} /> },
          {
            title: '规模',
            render: (_, record) => (
              <Space wrap>
                <Tag>{record.sample_count} 条</Tag>
                <Typography.Text type="secondary">
                  {record.statistics.user_count} 用户 / {record.statistics.character_count} 角色 / {record.statistics.session_count} 原始会话
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
            sample_limit: BATCH_LAB_DEFAULT_SAMPLE_LIMIT,
            parameters_json: JSON.stringify(
              defaultTemplate?.default_parameters ?? { min_turn: 60 },
              null,
              2
            ),
            sql: defaultTemplate?.sql ?? DEFAULT_SAMPLE_SQL,
          }}
          onValuesChange={invalidatePreview}
          onFinish={(values) => {
            invalidatePreview();
            previewMutation.mutate({values:{...values,source_versions:{...values.source_versions}},revision:previewRevision.current});
          }}
        >
          <Typography.Title level={5}>1. 确定聊天记录和角色卡的数据来源</Typography.Title>
          <Typography.Paragraph type="secondary">
            每张表各选一个版本，可以来自不同导入批次。SQL 中的表名对应下方选择；不会混入该表的其他版本，WHERE 可进一步缩小范围。
          </Typography.Paragraph>
          <div className="source-table-grid">
            {SOURCE_TABLES.map(({kind,label,table}) => {
              const dataset = readyDatasets.find(item=>item.id===selectedSources?.[kind]);
              return <div className="source-table-choice" key={kind}>
                <Typography.Text strong>{label}</Typography.Text>
                <Typography.Text code className="source-table-name">{table}</Typography.Text>
                <Form.Item name={['source_versions',kind]} label={`${label}版本`} rules={[{required:true,message:`请选择${label}版本`}]}>
                  <Select aria-label={`${label}版本`} loading={datasetsQuery.isFetching} placeholder={`选择${label}的原始版本`}
                    options={readyDatasets.map(item=>({value:item.id,label:`原始 v${item.version} · ${item.name} · ${datasetTableCount(item,kind).toLocaleString()} 条`}))}
                    onChange={()=>{selectionInitialized.current=true;}} />
                </Form.Item>
                {dataset ? <Typography.Paragraph type="secondary" className="source-table-scope">
                  {datasetTableCount(dataset,kind).toLocaleString()} 条 · {datasetTableScope(dataset,kind)}
                </Typography.Paragraph> : <Typography.Text type="secondary">选择版本后显示数据范围</Typography.Text>}
              </div>;
            })}
          </div>
          <Alert className="section-gap" type="info" showIcon message="按角色 ID 关联所选两表；缺失的角色不会从其他版本补齐。" />
          <Typography.Paragraph type="secondary" className="section-gap">
            保留原始 history 上下文；仅使用数据中已有的会话 ID，不新增会话划分。
          </Typography.Paragraph>
          <Typography.Title level={5}>2. 编写 SQL 并预览</Typography.Title>
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
          </div>
          <Form.Item name="parameters_json" label="SQL 参数 JSON" extra="使用 :参数名 绑定 SQL 中的值，例如 :min_turn 对应下方的 min_turn。"
            rules={[{ validator: async (_, value: string) => { parseSqlParameters(value); } }]}>
            <Input.TextArea rows={5} className="code-input" spellCheck={false} />
          </Form.Item>
          <Form.Item name="sql" label="SQL" rules={[{ required: true }]}>
            <Input.TextArea rows={8} className="code-input" />
          </Form.Item>
          <Space wrap>
            <Button
              type="primary"
              htmlType="submit"
              loading={previewMutation.isPending}
              disabled={!context.capabilities.sample_preview || readyDatasets.length === 0 || datasetsQuery.isFetching}
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
      {selectedSampleSet ? <SampleSetDrawer key={selectedSampleSet.id}
        context={context}
        sampleSet={selectedSampleSet}
        onClose={() => setSelectedSampleSet(null)}
      /> : null}
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
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const cursor = cursors[pageIndex];
  const detailQuery = useQuery({
    queryKey: sampleSet
      ? batchLabQueryKeys.sampleSet(context, sampleSet.id)
      : [...batchLabQueryKeys.sampleSets(context), 'none'],
    queryFn: ({ signal }) => getBatchLabSampleSet(sampleSet?.id ?? '', signal),
    enabled: sampleSet !== null,
  });
  const samplesQuery = useQuery({
    queryKey: sampleSet
      ? batchLabQueryKeys.sampleSetSamples(context, sampleSet.id, cursor)
      : [...batchLabQueryKeys.sampleSets(context), 'none', 'samples'],
    queryFn: ({ signal }) =>
      listBatchLabSampleSetSamples(sampleSet?.id ?? '', { limit: PAGE_SIZE, cursor }, signal),
    enabled: sampleSet !== null,
  });

  return (
    <Drawer width={1200} title={sampleSet?.name} open={sampleSet !== null} onClose={onClose}>
      <Space direction="vertical" size={18} className="full-width">
        {detailQuery.data ? (
          <Descriptions bordered size="small" column={1}>
            <Descriptions.Item label="版本链"><VersionLineage sampleSet={detailQuery.data} /></Descriptions.Item>
            <Descriptions.Item label="样本数">{detailQuery.data.sample_count}</Descriptions.Item>
            <Descriptions.Item label="原始会话">{detailQuery.data.statistics.session_count}</Descriptions.Item>
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
        {detailQuery.isError || samplesQuery.isError ? <Alert type="error" message={errorMessage(detailQuery.error ?? samplesQuery.error)} /> : null}
        <CursorPagination pageIndex={pageIndex} loading={samplesQuery.isFetching}
          nextCursor={samplesQuery.data?.next_cursor ?? null}
          onPrevious={() => setPageIndex((value) => value - 1)}
          onNext={(next) => { setCursors((values) => [...values.slice(0, pageIndex + 1), next]); setPageIndex((value) => value + 1); }} />
        <Table<BatchLabSampleSnapshot>
          rowKey="source_history_id"
          loading={samplesQuery.isPending}
          size="small"
          dataSource={samplesQuery.data?.items ?? []}
          pagination={false}
          scroll={{ x: 980 }}
          columns={[
            { title: '#', dataIndex: 'ordinal', width: 70 },
            {
              title: '锚点',
              render: (_, item) => (
                <Space direction="vertical" size={2}>
                  <Typography.Text>{item.source_session_id ?? '未提供原始会话ID'}</Typography.Text>
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
                        <ConversationMessages messages={item.history} turnModels={item.turn_models} />
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
      <Space wrap className="version-lineage">
        <SourceVersionSummary source={preview} />
        <Typography.Text type="secondary">保存后固定以上两表来源、SQL 和样本快照。</Typography.Text>
      </Space>
      <div className="stats-grid">
        <Statistic
          title="有效样本"
          value={preview.statistics.valid_count}
          suffix={`/ ${preview.statistics.requested_count}`}
        />
        <Statistic title="用户" value={preview.statistics.user_count} />
        <Statistic title="原始会话" value={preview.statistics.session_count} />
        <Statistic title="角色" value={preview.statistics.character_count} />
      </div>
      <Divider />
      <Table
        rowKey="source_history_id"
        size="small"
        dataSource={preview.items}
        pagination={{ pageSize: PAGE_SIZE, showSizeChanger: false }}
        scroll={{ x: 980 }}
        columns={[
          { title: '#', dataIndex: 'ordinal', width: 70 },
          {
            title: '锚点',
            render: (_, item) => (
              <Space direction="vertical" size={2}>
                <Typography.Text>{item.source_session_id ?? '未提供原始会话ID'}</Typography.Text>
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
                      <ConversationMessages messages={item.history} turnModels={item.turn_models} />
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

function ExperimentWizard({
  context,
  sampleSets,
  loading,
  onCreated,
}: {
  context: BatchLabContext;
  sampleSets: BatchLabSampleSet[];
  loading: boolean;
  onCreated: () => void;
}) {
  const queryClient = useQueryClient();
  const [form] = Form.useForm<ExperimentFormValues>();
  const runMode = Form.useWatch('run_mode', form) ?? 'single';
  const comparisonVariable = Form.useWatch('comparison_variable', form) ?? 'instruction_prompt';
  const sampleScope = Form.useWatch('sample_scope', form) ?? 'all';
  const variantValues = Form.useWatch('variants', form);
  const [confirmValues, setConfirmValues] = useState<ExperimentFormValues | null>(null);
  const createMutation = useMutation({
    mutationFn: (values: ExperimentFormValues) =>
      createBatchLabExperiment({
        name: values.name,
        purpose: values.purpose?.trim() ? values.purpose.trim() : null,
        sample_set_id: values.sample_set_id,
        source_environment: context.source_environment,
        run_mode: values.run_mode,
        concurrency: values.concurrency,
        sample_limit: values.sample_scope === 'random' ? values.sample_limit : undefined,
        comparison_variable: values.comparison_variable,
        output_preset: values.comparison_variable === 'model' ? { name: '两组共用 Instruction prompt', content: values.shared_instruction_prompt, format: '' } : undefined,
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
          const started = await startBatchLabExperiment({
            experiment_id: experiment.id,
            source_environment: context.source_environment,
            idempotency_key: newIdempotencyKey(),
          });
          queryClient.setQueryData<BatchLabExperimentSummary[]>(batchLabQueryKeys.experiments(context), current =>
            current?.map(item => item.id === started.id ? started : item));
          onCreated();
          void queryClient.invalidateQueries({ queryKey: batchLabQueryKeys.experiments(context) });
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
    concurrency: 4,
    sample_scope: 'all',
    sample_limit: 3,
    comparison_variable: 'instruction_prompt',
    shared_provider_url: DEFAULT_OPENROUTER_BASE_URL,
    shared_instruction_prompt: '',
    variants: [
      {
        name: '基准 A',
        generation_mode: 'original',
        model_source: 'sample',
        provider_base_url: DEFAULT_OPENROUTER_BASE_URL,
        openrouter_model_id: DEFAULT_EXPERIMENT_OPENROUTER_MODEL_ID,
        output_preset_content:
          '保持角色一致，自然回应用户，推进对话。',
      },
      {
        name: '候选 B',
        generation_mode: 'generate',
        model_source: 'custom',
        provider_base_url: DEFAULT_OPENROUTER_BASE_URL,
        openrouter_model_id: DEFAULT_EXPERIMENT_OPENROUTER_MODEL_ID,
        output_preset_content:
          '保持角色一致，自然回应用户，推进对话。\n减少重复的动作和情绪描写；用户要求安静时，不主动追问。',
      },
    ],
  };

  return (
    <section className="section-gap">
      <div className="page-head">
        <div>
          <Typography.Title level={2}>新建对比实验</Typography.Title>
          <Typography.Text type="secondary">
            先排除样本原来的最后一轮，以倒数第二轮为终点；重跑时逐轮在用户原话前加本组 instruction prompt。
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
            <Form.Item name="comparison_variable" label="本次对比变量" rules={[{ required: true }]}>
              <Select options={[{ value: 'instruction_prompt', label: 'Instruction prompt · 固定样本记录的模型' }, { value: 'model', label: '模型 · 手动填写两组共用 Instruction prompt' }]} />
            </Form.Item>
            <Alert type="info" message={comparisonVariable === 'model'
              ? 'A、B 都重新生成，使用手动填写的同一份指令、用户输入和采样设置，只改变模型。连续模式后续上下文承接各组自己的新回复。'
              : '重新生成时使用样本对应轮次记录的模型，两组只修改 Instruction prompt。'} />
            <Form.Item name="shared_provider_url" label="两组共用 OpenRouter URL" rules={[{ required: true }]}>
              <Input maxLength={500} />
            </Form.Item>
            {comparisonVariable === 'model' ? <Form.Item name="shared_instruction_prompt" label="两组共用 Instruction prompt" rules={[{ required: true, whitespace: true }]} extra="手动填写，A、B 使用完全相同的指令，只改变模型。">
              <Input.TextArea rows={8} maxLength={10_000} />
            </Form.Item> : null}
            <div className="form-grid three">
              <Form.Item name="name" label="实验名称" rules={[{ required: true }]}>
                <Input maxLength={120} />
              </Form.Item>
              <Form.Item name="sample_set_id" label="样本集" rules={[{ required: true }]}>
                <Select
                  options={sampleSets.map((sampleSet) => ({
                    value: sampleSet.id,
                    label: `${sampleSet.version ? `样本 v${sampleSet.version} · ` : ''}${sampleSet.name} · ${sampleSet.sample_count} 条${sampleSet.dataset_version_number ? ` · 原始 v${sampleSet.dataset_version_number}` : ''}`,
                  }))}
                />
              </Form.Item>
              <Form.Item name="sample_scope" label="运行样本" rules={[{ required: true }]}>
                <Select options={[{ value: 'all', label: '全部样本' }, { value: 'random', label: '随机抽样 · 调试' }]} />
              </Form.Item>
              {sampleScope === 'random' ? <Form.Item name="sample_limit" label="随机样本数（N）" rules={[{ required: true }]} extra="创建实验时随机选定，后续重试和评估保持同一批样本。">
                <InputNumber min={1} max={BATCH_LAB_MAX_SAMPLE_LIMIT} precision={0} className="full-width" />
              </Form.Item> : null}
              <Form.Item name="concurrency" label="并发请求数" extra="每批同时调用模型的数量；连续轮次仍按顺序执行。" rules={[{ required: true }]} >
                <InputNumber min={1} max={BATCH_LAB_MAX_WORKER_CLAIM_LIMIT} precision={0} className="full-width" />
              </Form.Item>
              <Form.Item name="run_mode" label="运行模式" rules={[{ required: true }]}>
                <Select
                  options={[
                    { value: 'single', label: '单轮 · 只重跑最后一轮' },
                    { value: 'multi_turn', label: '连续 · 重跑最后 X 轮' },
                  ]}
                />
              </Form.Item>
              {runMode === 'multi_turn' ? <Form.Item name="max_turns" label="重跑最后几轮（X）" rules={[{ required: true }]}>
                <InputNumber min={1} max={BATCH_LAB_MAX_EXPERIMENT_TURNS} precision={0} className="full-width" />
              </Form.Item> : null}
            </div>
            <Alert type="info" showIcon className="section-gap" message={runMode === 'single'
              ? '保留原始上下文和用户输入，只重新生成最后一轮助手回复。'
              : '按顺序重跑最后 X 轮，各轮用户输入保持原样；上一轮新生成的助手回复会进入下一轮上下文。'} />
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
                  message="回复来源与配置随实验保存"
                />
                <Form.Item
                  name={['variants', index, 'name']}
                  label="组合名称"
                  rules={[{ required: true }]}
                >
                  <Input maxLength={120} />
                </Form.Item>
                {comparisonVariable === 'instruction_prompt' ? <Form.Item name={['variants', index, 'generation_mode']} label="回复来源" rules={[{ required: true }]}>
                  <Select options={[{ value: 'original', label: '固定 · 使用原始线上回复（不调用模型）' }, { value: 'generate', label: '重新生成 · 调用模型' }]} />
                </Form.Item> : null}
                {(comparisonVariable === 'instruction_prompt' && (variantValues?.[index]?.generation_mode ?? initialValues.variants[index].generation_mode)) === 'original' ? (
                  <Alert type="info" message="直接对照样本中保存的原始线上回复。连续模式逐轮取对应回复，保持原样。" />
                ) : <>
                {comparisonVariable === 'model' ? <>
                  <Form.Item name={['variants', index, 'model_source']} label="模型来源" rules={[{ required: true }]}>
                    <Select options={[{ value: 'sample', label: '使用样本对应轮次的模型' }, { value: 'custom', label: '指定模型' }]} />
                  </Form.Item>
                  {(variantValues?.[index]?.model_source ?? initialValues.variants[index].model_source) === 'custom' ? <Form.Item
                    name={['variants', index, 'openrouter_model_id']} label="生成模型" rules={[{ required: true }]}>
                    <Input maxLength={200} placeholder="填写 OpenRouter 模型名称" />
                  </Form.Item> : null}
                  <Typography.Text type="secondary">Instruction prompt 使用上方手动填写的共用内容。</Typography.Text>
                </> : <>
                <Form.Item
                  name={['variants', index, 'output_preset_content']}
                  label="Instruction prompt · 每轮用户输入前的指令"
                  extra="填写完整指令。先清除历史用户消息中的旧指令，再为需要重跑的轮次拼接本组指令；可包含末尾的 ##用户指令:。"
                  rules={[{ required: true }]}
                >
                  <Input.TextArea rows={8} maxLength={10_000} />
                </Form.Item>
                </>}
                </>}
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
  const runSampleCount = sampleSet && values ? (values.sample_scope === 'random' ? Math.min(sampleSet.sample_count, values.sample_limit) : sampleSet.sample_count) : 0;
  const plannedCalls = values ? runSampleCount * (values.comparison_variable === 'model' ? 2 : values.variants.filter(variant => variant.generation_mode !== 'original').length) * (values.run_mode === 'single' ? 1 : values.max_turns) : 0;

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
            {sampleSet ? <Descriptions.Item label="版本链"><VersionLineage sampleSet={sampleSet} /></Descriptions.Item> : null}
            <Descriptions.Item label="对比变量">{values.comparison_variable === 'model' ? '模型（手动指令共用）' : 'Instruction prompt（样本模型固定）'}</Descriptions.Item>
            <Descriptions.Item label="运行模式">{values.run_mode === 'single' ? '单轮 · 只重跑最后一轮' : `连续 · 重跑最后 ${values.max_turns} 轮（用户输入不变）`}</Descriptions.Item>
            <Descriptions.Item label="样本范围">{values.sample_scope === 'random' ? `随机抽取 ${runSampleCount} 条用于调试` : `全部 ${runSampleCount} 条`}</Descriptions.Item>
            <Descriptions.Item label="并发请求数">{values.concurrency} 个 / 批</Descriptions.Item>
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
