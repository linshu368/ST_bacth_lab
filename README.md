# ST Batch Lab

Standalone, pure-frontend Batch Lab migrated from `ST_miniapp/packages/batch-lab`.

pnpm@9.15.9 node@22.14.0

## Run

```bash
pnpm install
pnpm dev
pnpm build
```

The local app runs at `http://127.0.0.1:3004/`.

## Data Layout

- `data/resouce/`
  - `chat_history_rows.csv`
  - `chat_sessions_rows.csv`
  - `characters_rows.csv`
- `data/bacth-lab/`
  - Batch Lab sample sets, previews, snapshots, processors, experiments, attempts, display results,
    annotations, and SQL templates.

Static Vercel deployments cannot write back to repository CSV files. The app loads CSV as seed data,
saves runtime changes in browser IndexedDB, and provides `导出 CSV 数据包` to download updated CSV
files for `data/bacth-lab/`.

## Config

Runtime model settings are read from Vercel/Vite environment variables through `script/config.js`.
Set these in Vercel Project Settings, or in local `.env.local`:

```bash
VITE_BATCH_LAB_MODEL_KEY=your_model_key
VITE_BATCH_LAB_ENABLED=true
VITE_BATCH_LAB_ALLOW_PRODUCTION_SOURCE=true
```

Because this is a pure frontend app, every `VITE_*` value is public to browser users after deployment.
