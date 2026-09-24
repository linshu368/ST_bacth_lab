export type DatasetFileKind = 'history' | 'sessions' | 'characters';

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
  row_counts: Record<DatasetFileKind, number>;
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
