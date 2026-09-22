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

Model settings are read from `script/config.js`. Because this is a pure frontend app, any model key
in that file is public to browser users after deployment.
