export type DatasetFileKind = 'history' | 'sessions' | 'characters';

export const SOURCE_TABLES = [
  { kind: 'history', label: '聊天记录', table: 'experience.chat_history' },
  { kind: 'characters', label: '角色卡', table: 'app_core.characters' },
] as const;

export function datasetTableCount(dataset: DatasetVersion, kind: DatasetFileKind): number {
  return kind === 'history' ? dataset.history_count : kind === 'sessions' ? dataset.session_count : dataset.character_count;
}

export function datasetTableScope(dataset: DatasetVersion, kind: DatasetFileKind): string {
  const provenance = dataset.provenance;
  if (provenance?.source !== 'supabase') return '范围：该版本 CSV 的全部记录；未记录额外导入筛选条件。';
  const time = (value: string) => new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value));
  if (kind === 'history') return `范围：${time(provenance.start_utc)} 至 ${time(provenance.end_utc_exclusive)}（不含结束时刻），数据截至 ${time(provenance.snapshot_cutoff_utc)}；北京时间。`;
  if (kind === 'sessions') return '范围：该导入版本中与聊天记录关联的会话。';
  const scope = provenance.characters_scope === 'enabled_rows' ? '全部 enabled=true 的角色卡，不限时间'
    : provenance.characters_scope === 'all_rows' ? '角色表全量快照，不限时间'
    : provenance.characters_scope === 'referenced_rows' ? '该导入版本中与聊天记录关联的角色卡' : '该版本角色 CSV 的全部记录';
  return `范围：${scope}${provenance.characters_snapshot_cutoff_utc ? `；快照时刻 ${time(provenance.characters_snapshot_cutoff_utc)}（北京时间）` : ''}。`;
}

export type DatasetProvenance = {
  source: 'supabase';
  project_ref: string;
  project_name?: string;
  schema: string;
  table: string;
  time_column: string;
  start_utc: string;
  end_utc_exclusive: string;
  start_beijing: string;
  end_beijing_exclusive: string;
  timezone: 'Asia/Shanghai';
  snapshot_cutoff_utc: string;
  characters_scope?: 'all_rows' | 'referenced_rows' | 'enabled_rows';
  characters_snapshot_cutoff_utc?: string;
  exported_at: string;
  row_counts: Record<'history' | 'characters', number> & { sessions?: number };
};

export type DatasetVersion = {
  id: string;
  version: number;
  name: string;
  status: 'uploading' | 'ready';
  created_at: string;
  history_count: number;
  session_count: number;
  character_count: number;
  provenance?: DatasetProvenance | { source?: undefined };
  files: Array<{
    kind: DatasetFileKind;
    name: string;
    size: number;
    sha256: string;
  }>;
};

export function datasetVersionLabel(dataset: Pick<DatasetVersion, 'version' | 'name'>): string {
  return `原始 v${dataset.version} · ${dataset.name}`;
}

export function defaultDatasetName(): string {
  return `原始数据 ${new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date())}`;
}
