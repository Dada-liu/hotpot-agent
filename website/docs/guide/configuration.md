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

### approval（可选）

审批策略，作用于 worker 工具链：

| 值 | 行为 |
|----|------|
| `ask-on-dangerous`（默认） | 仅高危命令与覆盖写询问 `y/n`，默认 `n` |
| `always` | 所有 bash/write/edit 调用前都预审批 |
| `never` | 不询问（谨慎使用） |

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

- `enabled` 默认开启；但 endpoint 未配置时同样不启用。
- `token` 可选，发送时带 `Authorization: Bearer <token>`。
- 事件白名单与数据边界见[遥测](/advanced/telemetry)。

## 项目级配置

文件位置：从当前工作目录向上任一级可放置 `.hotpot/settings.json`。

项目级**只能覆盖非凭证白名单字段**：`mainAgentTier`、`maxParallelTasks`、`planMaxRevisions`、`approval.policy`。模型凭证只从用户级读取——这保证了恶意仓库无法通过提交 `.hotpot/settings.json` 窃取或改写你的 API key 与上报地址。

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
| `HOTPOT_TELEMETRY_ENDPOINT` | 遥测 endpoint 回退来源；**置为空串等于显式关闭遥测**（会遮挡源码默认 endpoint） |
