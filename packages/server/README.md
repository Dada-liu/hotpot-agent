# @hotpot/server

M3 服务层：在 cli 与 orchestrator 之上提供 REST + SSE API，负责会话管理、事件推送与断线重连（重连时从 JSONL 日志按 offset 补发 missed 事件）。依赖方向 `server → orchestrator → core → ai`。

## 当前已实现（Task 2）

- **`createTailer` JSONL 日志 tailer**（`src/tailer.ts`）：后续事件总线的基础。
  - `start()` 先补读历史（`fromOffset`，缺省 0）整批回调，再进入跟随模式；
  - 跟随：`fs.watch` 触发增量读 + `pollIntervalMs`（默认 250）轮询文件大小兜底；
  - 只读新增字节：空行与 `JSON.parse` 失败的坏行跳过；末尾无换行的半行留待下次拼接（写入中途被杀不掉数据）；
  - `offset()` 返回已消费字节数（半行不算），客户端断线重连时携带它即可从 tailer 续读补发；
  - `stop()` 清除 watch 与轮询；原地再 `start()` 从上次 offset 续读；`fs.watch` 报错自动降级为纯轮询，不抛给调用方。

## 目录

```
src/
  index.ts             包入口：re-export tailer
  tailer.ts            JSONL 会话日志 tailer（createTailer）
  node-builtins.d.ts   Node 内置模块的最小 ambient 声明（禁 @types/node，超集自 core）
test/
  tailer.test.ts       补读/坏行/半行/stop/offset 续读用例
```

## 计划（后续任务）

- hono REST 路由（会话列表、创建、resume）与 SSE 事件流；
- bin 入口（`hotpot-server`，Task 4 建 `src/bin.ts` 后再在 package.json 加 bin 字段）。
