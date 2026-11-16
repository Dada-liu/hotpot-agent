# 配置

hotpot-agent 的配置分两层：**用户级**与**项目级**。凭证只从用户级读取，项目级配置无法改写上报地址或模型凭证。

## 用户级配置

文件位置：`~/.hotpot/settings.json`（可用环境变量 `HOTPOT_HOME` 改写 `~/.hotpot` 这个根目录）。

### models（必填）

三档模型 `high` / `medium` / `low` 必填，字段：

| 字段 | 说明 |
|------|------|
| `provider` | 提供方标识，如 `anthropic` / `openai` / `deepseek` / `moonshot` |
| `model` | 模型名，如 `claude-sonnet-4-5`、`deepseek-chat` |
| `apiKey` | 字面值或 `"$ENV_VAR"` 环境变量引用 |
| `baseUrl` | 可选，默认走 provider 官方端点；第三方端点必须显式填写 |

### mainAgentTier（可选）

主 agent 使用的档位，默认 `high`。

### maxParallelTasks（可选）

worker 可并行的 task 上限，默认 `10`。

### planMaxRevisions（可选）

plan 被批注后的最大修订轮数，默认 `3`。

### permission（可选）

权限档位，作用于 worker 工具链；只能从用户级配置读取：

| 值 | 行为 |
|----|------|
| `readonly` | read 类工具自动放行，其余 worker 工具逐个审批 |
| `ask-on-dangerous`（默认） | 仅高危命令与覆盖写询问 `y/n`，默认 `n` |
| `full` | 全部自动放行（谨慎使用） |

配置示例：`{ "permission": { "mode": "ask-on-dangerous" } }`。

### features（可选）

M4 功能开关，全部可选布尔。既有功能默认全开；`memory` 为避免隐式增加 prompt token **默认关闭**。关闭开关 = 不注册工具 / 不挂钩子 / 不扫描目录，读取统一经 `featureEnabled`，不直接裸读 `settings.features`：

| 开关 | 默认 | 控制 |
|------|------|------|
| `todo` / `hooks` / `skills` / `promptTemplates` | 开 | 任务清单 / 钩子链 / SKILL.md 技能发现 / `/` 命令 prompt 模板 |
| `webSearch` / `webFetch` | 开 | 联网搜索与网页抓取工具 |
| `mcp` | 开 | MCP server 接入（配合 `mcpServers`） |
| `compaction` | 开 | 上下文自动压缩 |
| `memory` | 关 | 用户记忆：关闭时不读 `MEMORY.md`、不注册 `memory_save`、不注入记忆段 |

`features.memory=true` 后，新会话与 `--session` 恢复会话从同一 `<home>/MEMORY.md` 构建 prompt，每轮注入最新有界摘要（最多 8,000 字符，超出只保留末尾完整条目并带截断标记，读取失败降级为空）；main/worker 可调用 `memory_save` 追加写入，task 只读。记忆文件可人工编辑，但不要保存密钥、凭证或临时任务状态。

### compaction（可选）

上下文自动压缩的用户级配置（`features.compaction` 总开关默认开）：

| 字段 | 默认 | 说明 |
|------|------|------|
| `triggerRatio` | `0.8` | 正式请求前估算值严格超过 `(contextWindow - maxTokens) * triggerRatio` 时触发；合法范围 `(0,1]` |
| `keepRecentTokens` | `20000` | 压缩时由尾向前保留的最近历史估算预算，正整数，工具调用与结果组不拆开 |

### telemetry（可选）

匿名遥测开关，只从用户级读取：

```json
{
  "telemetry": {
    "enabled": true,
    "endpoint": "https://your-telemetry-server.example.com",
    "token": "$HOTPOT_TELEMETRY_TOKEN",
    "flushIntervalMs": 30000
  }
}
```

- `enabled` 默认开启，endpoint 默认使用源码内置的已部署地址；设置 `enabled: false` 可始终关闭遥测。
- 仅当 settings 未配置非空 endpoint 时，把 `HOTPOT_TELEMETRY_ENDPOINT` 显式置为空串才会遮挡内置地址并关闭遥测；settings 中的非空 endpoint 优先级更高。
- `token` 可选，发送时带 `Authorization: Bearer <token>`。
- 事件白名单与数据边界见[遥测](/advanced/telemetry)。

## 项目级配置

文件位置：从当前工作目录向上任一级可放置 `.hotpot/settings.json`。

项目级**只能覆盖非凭证白名单字段**：`mainAgentTier`、`maxParallelTasks`、`planMaxRevisions`。模型凭证与 `permission` 只从用户级读取，项目级 `permission` 会被忽略——这保证恶意仓库无法通过提交 `.hotpot/settings.json` 提升权限、窃取或改写你的 API key 与上报地址。

一个典型场景：在某个仓库里把主 agent 降到中档以省成本，同时不影响其他项目：

```json
{
  "mainAgentTier": "medium"
}
```

## 环境变量汇总

| 变量 | 作用 |
|------|------|
| `HOTPOT_HOME` | 覆盖 `~/.hotpot` 根目录（会话、配置、遥测安装 ID 都在其下） |
| `HOTPOT_PORT` | `hotpot web` 监听端口，默认 `4573` |
| `HOTPOT_WEB_DIST` / `HOTPOT_PUBLIC_DIR` | server 静态托管目录覆盖 |
| `HOTPOT_TELEMETRY_ENDPOINT` | settings 未配置非空 endpoint 时的回退来源；此时置为空串会遮挡源码默认地址并关闭遥测。任何情况下都可设置 `telemetry.enabled: false` 关闭 |
