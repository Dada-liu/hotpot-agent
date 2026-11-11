# `@hotpot/memory`

代码检索基础设施：OpenAI 兼容 embedding 客户端与本地精确向量库。本包不读取或写入 `MEMORY.md`，不提供用户记忆、语义记忆或自动事实提取。

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
const results = await store.search(queryVector, { namespace: "src", limit: 10 });
```

记录包含 `id`、`namespace`、`text`、`vector`、`metadata`。`id` 在项目库内唯一；同 id 后写覆盖先写，tombstone 删除对应记录。检索按 namespace 隔离，使用精确余弦相似度降序排序，结果附带 `score`。

数据文件为 `<home>/memory/vectors/<project-key>.jsonl`。每行是带模型的 upsert 或 tombstone；每批写操作按 `bytesWritten` 循环 append，完整写入 UTF-8 内容后 fsync，成功后才更新内存。`open` 按日志顺序重建最新状态，跳过坏 JSON 和形状非法的行；模型或维度冲突明确报错。写入在同一实例内串行执行，单批维度不一致会在写盘前整批拒绝。`remove` 在入队前校验所有 ID 非空，保证已接受的 tombstone 与重启 replay 使用同一规则。

本包只使用 Node 文件 API 和原生 `fetch`，没有原生数据库、SQLite 扩展或独立数据库服务依赖。

## 配置

`features.vector` 默认 `false`，只有显式设为 `true` 才允许上层装配代码检索。`vector.embedding` 仅允许用户级 `<home>/settings.json`：

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

## 测试

```bash
pnpm exec vitest run packages/memory/test packages/core/test/config.test.ts
```

测试覆盖批量请求、Authorization、乱序响应、HTTP/形状/维度错误、abort、最近邻排序、namespace 隔离、更新/删除、重启恢复、坏行容忍、模型/维度冲突与配置安全边界。
