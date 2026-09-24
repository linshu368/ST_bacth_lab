# ST Batch Lab

基于 React、Vite、Vercel Functions 和 Neon Postgres 的团队共享实验平台。

## 数据与版本

- **原始数据版本**：一次导入聊天、会话、角色三个 CSV，原文件按字节保存并校验 SHA-256；每次导入生成新版本，已有版本不能覆盖。
- **样本版本**：在选定的原始版本上执行 SQL，保存查询、参数、来源版本和样本快照。后续数据导入不会改变旧样本。
- **实验记录**：保存配置、模型调用输入、原始输出、后处理结果、标注、任务状态和重试日志。多人打开同一实验看到共同进度；需要独立运行时复制或新建实验。

持久化数据统一保存在 Neon，不再依赖当前浏览器的 IndexedDB。网页需要联网；这是不连接业务生产库的独立实验平台。仓库里的旧 IndexedDB 数据不会自动迁移。

## 本地运行

使用 Node.js 22+ 与 pnpm 9：

```bash
pnpm install
cp .env.example .env.local
# 填入 DATABASE_URL 和模型密钥
pnpm db:migrate
pnpm dev
```

打开 `http://127.0.0.1:3004/`。Vite 开发服务包含与部署环境相同的 `/api/lab` 接口。

```bash
pnpm test
pnpm build
# 可选：将仓库 data/resouce 的三个 CSV 导入一次，重复执行不会覆盖版本
pnpm exec tsx script/seed-source.ts
```

测试在本地临时 Postgres（PGlite）中验证 SQL 隔离、版本快照、任务领取、停止、重试和后处理，不调用付费模型。

## SQL 抽样

可查询 `experience.chat_history`、`experience.chat_sessions` 和 `app_core.characters`（也可省略 schema）。查询只作用于所选原始版本，必须返回 `source_history_id`：

```sql
SELECT h.id AS source_history_id
FROM experience.chat_history h
JOIN experience.chat_sessions s ON s.id = h.session_id
JOIN app_core.characters c ON c.id = h.character_id
WHERE h.user_input IS NOT NULL
  AND h.model IS NOT NULL
  AND h.turn_index >= :min_turn
  AND s.deleted_at IS NULL
ORDER BY h.created_at DESC
```

参数示例：`{"min_turn":1}`。支持 SELECT、关联、筛选、排序和 LIMIT；不接受写入、多语句、子查询、CTE、自定义函数或其他表。查询使用只读事务并设置 8 秒超时。

单个原文件最多 64 MiB，三个文件合计最多 128 MiB；单行最多 2 MiB。一次抽样最多 500 条；所有有效样本快照分批完整保存，不设置总快照容量预算。无法形成有效快照的记录会明确计入排除统计。大数据分页读取，原文件可在版本列表完整下载。

## 执行与留痕

任务由实验、样本、对比方案、轮次共同定位。数据库原子领取避免多个浏览器重复执行同一任务；每轮完成立即保存。前一轮成功后才可领取同一方案的下一轮。

浏览器打开实验时按批次推进，每批最多 4 个任务。关闭所有执行页面后，不会继续领取新任务；已领取的请求可能继续完成。中断的任务在 5 分钟后标记为“结果未知”，由使用者手动重试，避免自动重复付费。停止实验会阻止领取新任务，已发出的模型调用可能仍完成并留痕。

日志展示最近 100 条事件。JSONL 导出实验结果；“导出 CSV 数据包”包含样本、配置、任务、完整执行输入及历史事件。原始三个 CSV 单独从版本列表下载。

当前为统一共享空间，不区分成员身份。可选配置 `BATCH_LAB_ACCESS_KEY` 启用统一团队口令；不配置时通过网站地址即可使用。

## Vercel 与 Neon

项目已使用 Vercel 的 Git 集成：推送 `main` 后自动更新生产网站，其他分支按 Vercel 配置生成预览。

1. 在项目 Storage 中连接 Neon，给运行环境注入 `DATABASE_URL`。
2. 配置服务端 `BATCH_LAB_MODEL_KEY`。数据库连接与模型密钥不得使用 `VITE_` 前缀；兼容旧 `VITE_BATCH_LAB_MODEL_KEY` 的服务端读取，但前端不再读取或打包它。
3. 在已连接相应数据库的本地环境执行 `pnpm db:migrate`，再提交代码触发部署。现有迁移是幂等创建。
4. Functions 与 Neon 均使用新加坡区域。API 最长运行 300 秒，单次模型调用最长 90 秒。

模型默认使用 OpenRouter。使用其他服务时，在服务端设置 `BATCH_LAB_MODEL_BASE_URL` 或将域名加入 `BATCH_LAB_ALLOWED_MODEL_HOSTS`，界面中的密钥引用只允许服务端模型密钥变量。

生产与预览若连接同一个数据库，会共享数据；需要独立测试数据时，在 Vercel 中给 Preview 连接独立 Neon 分支。

## 从数据库导出建立 base 版本

可信的本地批量导入支持较大的导出文件，按流式读取和分批写入保存完整原件，不受网页上传大小限制：

```bash
pnpm exec tsx script/import-source.ts --manifest /path/to/export/manifest.json --dry-run
pnpm exec tsx script/import-source.ts --manifest /path/to/export/manifest.json
```

清单包含版本名称、固定幂等标识、三个 CSV 的相对路径、来源项目/表、时间字段、北京时间与 UTC 范围、导出截止时间及行数。脚本检查实际行数和文件摘要；中断后使用同一清单重试只补齐未完成内容。所有文件与解析数据完成校验后，版本才会显示为可用。原始导出和清单应放在仓库外，不提交聊天数据或凭据。
