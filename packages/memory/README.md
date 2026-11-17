# `@hotpot/memory`

代码检索基础设施：OpenAI 兼容 embedding 客户端、本地精确向量库、增量代码索引与 `code_search` 工具。本包不读取或写入 `MEMORY.md`，不提供用户记忆、语义记忆或自动事实提取。

## EmbeddingClient

```ts
const client = new EmbeddingClient({
  model: "text-embedding-3-small",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-...",
});
const vectors = await client.embed(["first", "second"], signal);
```

每次调用向 `<baseUrl>/embeddings` 发送一个批量 POST，请求体为 `{ model, input: texts }`，并携带 `Authorization: Bearer <apiKey>`。响应按每条的 `index` 还原输入顺序；条数、index、向量字段或维度不合法时抛错。HTTP 与响应校验错误不包含输入文本或上游响应正文。`fetchImpl` 可注入 fake，测试不会访问真实网络。

## VectorStore

```ts
const store = await VectorStore.open({
  home: "/home/user/.hotpot",
  projectKey: "project-a",
  model: "text-embedding-3-small",
});
await store.upsert(records);
await store.remove(["chunk-id"]);
const results = await store.search(queryVector, { namespace: "code", limit: 10 });
```

记录包含 `id`、`namespace`、`text`、`vector`、`metadata`。`id` 在项目库内唯一；同 id 后写覆盖先写，tombstone 删除对应记录。`list(namespace)` 返回该命名空间的最新记录；检索按 namespace 隔离，使用精确余弦相似度降序排序，结果附带 `score`。

数据文件为 `<home>/memory/vectors/<project-key>.jsonl`。每行是带模型的 upsert 或 tombstone；每批写操作按 `bytesWritten` 循环 append，完整写入 UTF-8 内容后 fsync，成功后才更新内存。`open` 按日志顺序重建最新状态，跳过坏 JSON 和形状非法的行；模型或维度冲突明确报错。写入在同一实例内串行执行，单批维度不一致会在写盘前整批拒绝。`remove` 在入队前校验所有 ID 非空，保证已接受的 tombstone 与重启 replay 使用同一规则。

## 增量代码索引与 code_search

`createCodeIndexService(options)` 只构造惰性服务，不扫描目录、不打开向量库、不请求网络。首次 `search` 或实际执行 `code_search` 时才扫描当前 cwd，并在每次检索前增量刷新。`<project-key>.manifest.json` 原子记录每文件 hash 与预期 chunk ID（包括空文件）；每次刷新重读 store/manifest，发现缺失或孤儿 chunk 会修复。完整未修改文件只保留 hash，不保留文本；仅新、变更或缺 chunk 的文件保留待分块文本。chunk ID 由相对路径、字符偏移与 chunk 内容的 SHA-256 派生。

同一项目的所有 service/进程通过 `<project-key>.lock` 排他协调「重读 → 扫描 → embedding → 写入」，获得锁后重开 store，异常、abort 和审计失败都在 finally 释放锁，避免交错写入复活旧代码。锁文件携带随机 owner token 并每秒刷新 mtime；超过 10 秒未更新的崩溃残留锁会在再次核对 token 与 mtime 后回收。所有共享锁删除先登记唯一的回收意向文件，新锁必须等意向清空并再次确认 owner token 后才能进入临界区，若等待期间被回收则重新获取；意向文件自身按相同心跳和陈旧规则恢复。正常释放只删除自己持有的锁。单个 service 内的并发检索也串行刷新。

默认忽略任意层级的 `.git`、`node_modules`、`dist`、`build`、`.hotpot`，并排除解析后的 `<home>/memory/vectors` 子树（即使 home 嵌套在 cwd 内也不会自索引），跳过符号链接、含 NUL 或非法 UTF-8 的文件、超过 512KB 的文件。只接受常见源码扩展；`.env*`、凭证/密码/token 同名文件与常见私钥格式即使内容可读也不索引。文本按最多 1200 字符、200 字符重叠分块，保留相对路径与 1 起始止行；行号由一次前向扫描生成，不逐 chunk 重扫前缀。索引 embedding 每批最多 32 个 chunk、最多 4 个请求同时在途，响应按原下标回填保证顺序；每积累约 256 个 chunk 就落一次盘（向量库 + manifest）。因此中断（用户 ESC、进程退出）只丢当前窗口，已落盘文件下次按 hash 跳过，不必从头重建。项目向量写入 `<home>/memory/vectors/<sha256(解析后的 cwd)>.jsonl`。

`createCodeSearchTool(service)` 暴露 `{ query, limit? }`，默认返回 5 条、最多 20 条；结果按 score 降序排列，包含 `path`、`startLine`、`endLine`、`score` 与最多 800 字符的 `excerpt`。空结果分两种提示：索引里一个 chunk 都没有时明确说「工作区没有可索引的源码文件」（例如只有 `.md` 文档），并提示改用 read/grep/glob；有索引但没匹配则回报已索引的文件与 chunk 数。索引规模由 `service.stats()` 提供，索引为空时连查询文本都不外发。索引变化通过 `onIndexed` 回调报告 `{ files, chunks, durationMs }`，回调与遥测不得加入路径或源码。建索引过程另经 `onProgress` 回调按落盘窗口上报 `{ indexedFiles, totalFiles, indexedChunks, totalChunks }`（只含计数），server 侧落成 `vector/progress` 会话事件，web 据此显示「正在建代码索引 x/y」——首次索引大仓库可能要几分钟，没有这条用户会以为检索卡死。

**外发边界**：本地扫描与向量库读写不外发；只有调用 `code_search` 时，通过上述源码与敏感文件策略筛选后的待索引 chunk 和查询文本才会 POST 到用户配置的 `vector.embedding.baseUrl`。启用 vector 不代表同意上传 `.env`、私钥、凭证、任意文本或 YAML/JSON 等部署配置。未修改内容的后续检索只外发查询文本，不重复请求索引 embedding。代码索引在装配与启动时不会扫描或联网。

## 配置

`features.vector` 默认 `false`，只有显式设为 `true` 且 embedding 配置完整时才由上层向 main/worker/task 注册 `code_search`。`vector.embedding` 仅允许用户级 `<home>/settings.json`：

```json
{
  "features": { "vector": true },
  "vector": {
    "embedding": {
      "model": "text-embedding-3-small",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "$OPENAI_API_KEY"
    }
  }
}
```

`apiKey` 支持整串 `$ENV`；项目级 `.hotpot/settings.json` 中的 `features.vector`、`vector` 和 `embedding` 都会被剥离，防止仓库重定向代码与凭证。

本包只使用 Node 文件 API、原生 `fetch` 和 `zod`（工具 schema），没有原生数据库、SQLite 扩展、独立数据库服务或 workspace 依赖。

## 测试

```bash
pnpm exec vitest run packages/memory/test packages/core/test/config.test.ts
```

测试覆盖批量请求、Authorization、乱序响应、HTTP/形状/维度错误、abort、最近邻排序、namespace 隔离、更新/删除、重启恢复、坏行容忍、模型/维度冲突、固定窗口分块、增量刷新、忽略规则、路径/行号、匿名审计与配置安全边界。
