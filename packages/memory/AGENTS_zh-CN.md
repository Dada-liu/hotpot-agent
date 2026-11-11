# packages/memory/ 开发约定

- `@hotpot/memory` 只提供代码检索基础设施：OpenAI 兼容 embedding 客户端与本地精确向量库。不得读取或写入 `MEMORY.md`，不得增加用户语义记忆或自动事实提取。
- 保持零运行时依赖。网络 I/O 使用可注入的原生 `fetch`，持久化使用 Node 文件 API。不得新增 SQLite 原生扩展、LanceDB、其他原生数据库或数据库服务。
- `EmbeddingClient.embed(texts, signal)` 向 `<baseUrl>/embeddings` 发送一个批量 POST，请求体为 `{ model, input: texts }` 并携带 Bearer 认证。按响应 `index` 还原向量，校验条数、索引、向量与维度一致性。透传 abort signal。错误不得包含输入文本或上游响应正文。
- `VectorStore` 持久化到 `<home>/memory/vectors/<project-key>.jsonl`。每行是携带模型的 upsert 或 tombstone。每批写入遵循 open/write/fsync/close，fsync 成功后才更新内存。写入保持串行，追加前校验整批；打开时按顺序折叠日志、跳过坏行，模型或维度冲突必须明确报错。
- 记录 ID 在项目库内唯一。后写 upsert 替换先写记录，tombstone 删除记录。检索按 namespace 隔离，使用精确余弦相似度并按分数降序排列。不得替换为近似检索。
- `features.vector` 默认关闭。`settings.vector.embedding` 及其凭证只允许用户级配置；不得加入项目级配置白名单，不得隐式联网或扫描。
- 只使用 erasable TypeScript；相对导入带 `.ts`；禁止 `any` 与 inline import。注释和 README 使用简体中文；AGENTS 使用英文，并同步维护 `AGENTS_zh-CN.md`。
- 提交前在仓库根目录运行 `pnpm exec vitest run packages/memory/test packages/core/test/config.test.ts`、`pnpm typecheck`、`pnpm test` 与 `pnpm exec biome check`。
