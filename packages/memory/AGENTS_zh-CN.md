# packages/memory/ 开发约定

- `@hotpot/memory` 只提供代码检索基础设施：OpenAI 兼容 embedding 客户端、本地精确向量库、增量代码索引与 `code_search` 工具。不得读取或写入 `MEMORY.md`，不得增加用户语义记忆或自动事实提取。
- 不得增加 workspace 依赖。运行时依赖仅限用于工具 schema 的 `zod`。网络 I/O 使用可注入的原生 `fetch`，持久化使用 Node 文件 API。不得新增 SQLite 原生扩展、LanceDB、其他原生数据库或数据库服务。工具通过结构化类型兼容 core 的 `ToolDefinition`，不得导入 core，避免 memory 独立编译拉入 core 源码。
- `EmbeddingClient.embed(texts, signal)` 向 `<baseUrl>/embeddings` 发送一个批量 POST，请求体为 `{ model, input: texts }` 并携带 Bearer 认证。按响应 `index` 还原向量，校验条数、索引、向量与维度一致性。透传 abort signal。错误不得包含输入文本或上游响应正文。
- `VectorStore` 持久化到 `<home>/memory/vectors/<project-key>.jsonl`。每行是携带模型的 upsert 或 tombstone。每批写入按 `bytesWritten` 循环，直到完整 UTF-8 内容全部追加，再执行 fsync/close；fsync 成功后才更新内存。写入保持串行，追加前校验整批；打开时按顺序折叠日志、跳过坏行，模型或维度冲突必须明确报错。`list(namespace)` 返回该命名空间的最新记录。
- 记录 ID 在项目库内唯一。后写 upsert 替换先写记录，tombstone 删除记录。删除入队前必须校验每个 ID 非空，确保接受的 tombstone 总能重放。检索按 namespace 隔离，使用精确余弦相似度并按分数降序排列。不得替换为近似检索。
- `createCodeIndexService` 必须保持惰性：构造、CLI/server 装配和项目启动不得扫描、打开向量库或联网。只在检索前刷新当前 cwd。用内容哈希跳过未修改文件，修改时替换 chunk，删除时写 tombstone。固定窗口最多 1200 字符、重叠 200；忽略 `.git/node_modules/dist/build/.hotpot`、解析后的 `<home>/memory/vectors` 子树、符号链接、二进制/非 UTF-8 文件及超过 512KB 的文件。只索引常见源码扩展，并排除 `.env*`、凭证、密码/token 同名文件与常见私钥格式。每批 embedding 最多 16 个 chunk，保持批次和向量顺序。行号由一次前向扫描计算。结果使用相对路径、1 基包含端点的行范围与最多 800 字符的 excerpt。
- 每个项目将 `<project-key>.manifest.json` 与向量库放在同一目录，manifest 原子写入并保存每文件 hash、预期 chunk ID（包括空文件）。刷新时重新读取 store 与 manifest，检测缺失/孤儿 chunk 并修复。完整未修改文件只保留 hash，不保留文本；只有新文件、变更或缺 chunk 的文件保留待分块文本。
- 同一项目所有 service/进程通过 `<project-key>.lock` 的排他 `wx` 创建协调「重读 → 扫描 → embedding → 写入」。获得锁后重新打开 store；abort、异常和审计失败都必须在 `finally` 中释放锁，不得留下由本次调用持有的锁文件。
- `createCodeSearchTool(service)` 暴露 `{query, limit?}`（默认 5、最多 20），按 score 降序并提供明确无匹配提示。索引变化只通过 `onIndexed` 报告 `{files, chunks, durationMs}`；审计和遥测不得加入源码或路径。
- `features.vector` 默认关闭。`settings.vector.embedding` 及其凭证只允许用户级配置；不得加入项目级配置白名单，不得隐式联网或扫描。只有 `features.vector=true` 且 embedding 配置完整时才可向 main/worker/task 注册工具。
- 只使用 erasable TypeScript；相对导入带 `.ts`；禁止 `any` 与 inline import。注释和 README 使用简体中文；AGENTS 使用英文，并同步维护 `AGENTS_zh-CN.md`。
- 提交前在仓库根目录运行 `pnpm exec vitest run packages/memory/test packages/core/test/config.test.ts`、`pnpm typecheck`、`pnpm test` 与 `pnpm exec biome check`。
