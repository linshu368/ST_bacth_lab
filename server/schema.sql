CREATE TABLE IF NOT EXISTS lab_datasets (
  id uuid PRIMARY KEY,
  version bigserial UNIQUE NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'ready')),
  manifest jsonb NOT NULL,
  counts jsonb NOT NULL DEFAULT '{}',
  idempotency_key uuid UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz
);
ALTER TABLE lab_datasets ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS lab_source_chunks (
  dataset_id uuid NOT NULL REFERENCES lab_datasets(id),
  kind text NOT NULL CHECK (kind IN ('history','sessions','characters')),
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  data text NOT NULL,
  PRIMARY KEY (dataset_id, kind, chunk_index)
);
CREATE TABLE IF NOT EXISTS lab_source_rows (
  dataset_id uuid NOT NULL REFERENCES lab_datasets(id),
  kind text NOT NULL CHECK (kind IN ('history','sessions','characters')),
  ordinal integer NOT NULL,
  row_id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (dataset_id, kind, row_id),
  UNIQUE (dataset_id,kind,ordinal)
);
CREATE TABLE IF NOT EXISTS lab_records (
  kind text NOT NULL,
  id uuid NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind,id)
);
CREATE INDEX IF NOT EXISTS lab_records_kind_date ON lab_records(kind,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS lab_records_idempotency ON lab_records(kind,(data->>'idempotency_key')) WHERE data ? 'idempotency_key';
CREATE SEQUENCE IF NOT EXISTS lab_sample_version_seq;
CREATE TABLE IF NOT EXISTS lab_snapshots (
  sample_set_id uuid NOT NULL,
  ordinal integer NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (sample_set_id,ordinal)
);
CREATE TABLE IF NOT EXISTS lab_attempts (
  id uuid PRIMARY KEY,
  experiment_id uuid NOT NULL,
  sample_set_id uuid NOT NULL,
  sample_ordinal integer NOT NULL,
  variant_key text NOT NULL,
  turn_index integer NOT NULL,
  status text NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL DEFAULT '{}',
  UNIQUE (experiment_id,sample_ordinal,variant_key,turn_index)
);
CREATE INDEX IF NOT EXISTS lab_attempts_experiment_status ON lab_attempts(experiment_id,status);
CREATE TABLE IF NOT EXISTS lab_attempt_events (
  id bigserial PRIMARY KEY,
  attempt_id uuid NOT NULL,
  experiment_id uuid NOT NULL,
  event_type text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lab_attempt_events_experiment ON lab_attempt_events(experiment_id,id DESC);
CREATE TABLE IF NOT EXISTS lab_annotations (
  experiment_id uuid NOT NULL,
  sample_ordinal integer NOT NULL,
  turn_index integer NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (experiment_id,sample_ordinal,turn_index)
);
