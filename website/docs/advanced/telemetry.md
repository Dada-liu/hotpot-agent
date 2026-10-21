# 遥测

`@hotpot/telemetry` 是匿名遥测客户端：`cli` 与 `server` 在启动时装配它，把每个用户 turn 折叠成匿名指标后异步批量上报；benchmark runner 复用同一套客户端，以 `kind: "benchmark"` 隔离数据。

定位是**旁路**：上报失败、配置错误、会话日志损坏都不会抛错或阻塞 agent 主流程。

## 事件白名单（schema v1）

事件 schema 是严格白名单：所有对象 `.strict()`，未知字段直接判为非法。九类事件：

| 事件 | 内容 |
|------|------|
| `session_start` / `session_end` | 会话生命周期、时长、turn/error 计数、功能开关 |
| `turn_start` / `turn_end` | 回合结果（success / error / aborted）、时长、mainSteps、worker/task 计数、input/output token、`byTier` / `byModel` 拆分 |
| `llm_call` | agent 角色、档位、模型、token（含 cache read/write）、step 序号 |
| `tool_call` | 工具名、耗时、是否出错 |
| `error` | phase、机器码、**脱敏后**的错误消息 |
| `feature_usage` | 功能开关与事件/工具调用计数 |
| `benchmark_run` | 单题通过与否、时长、token |

`turn_end` 的 token 汇总覆盖该用户 turn 的**整棵 agent 树**（main + worker + task）。

## 不采集用户内容

明确禁止上报：prompt / 回复文本、工具入参 / 输出、文件内容、文件路径、命令、URL 查询参数、用户名、仓库名、任务标题。

实现上，采集器只读会话日志的元数据字段（事件类型、时间戳、usage、model、tier、agentId）；`assistant_msg.content` 仅用于识别 tool_call 块里的工具名。错误消息经脱敏（代码块、URL、邮箱、路径去除）并截断到 500 字符，脱敏解析失败时**丢弃原文返回空串**，宁可少报也不透传。

## endpoint、token 与开关

endpoint 解析顺序：

1. `settings.telemetry.endpoint`（空串 / 纯空白视为未配置，继续回退）
2. 环境变量 `HOTPOT_TELEMETRY_ENDPOINT`
3. 源码内置默认 endpoint

`HOTPOT_TELEMETRY_ENDPOINT=""` 会**遮挡**源码默认值，等于显式关闭。最终取值做空串 / 非绝对 URL / 非 http(s) 校验，非法即视为未配置，runtime 为 `null`、全部 no-op。

- `settings.telemetry.enabled: false` → 关闭。
- `token` 可选（字面值或 `$ENV` 引用），发送时带 `Authorization: Bearer`。
- `flushIntervalMs` 默认 30000；`0` 表示只靠阈值（50 条）与 close 触发 flush。
- `telemetry` **只从用户级配置读取**，项目级 schema 不接受该字段。

## client 行为

- 内存队列，达阈值（50 条）立即异步 flush，不阻塞调用方；队列超 1000 条丢最旧并计数。
- flush 串行；失败按 1s / 2s / 4s 退避重试 3 次，仍失败整批放回队首。
- 单请求超时 5s；定时器与重试 sleep 都 `unref()`，不会阻止进程退出。
- `close()` 只做一次有界尝试（不重试、不退避）。
- 网络错误、超时、序列化异常全部吞掉，`flush()` / `close()` 永不 reject。

## 安装 ID

首次运行生成随机 UUID，持久化在 `<home>/telemetry/install-id`（benchmark 用独立的 `benchmark-install-id`，避免跑批污染真实设备标识）。不关联账号、机器名或任何用户信息；文件损坏时重新生成。
