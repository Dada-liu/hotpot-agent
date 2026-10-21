# 快速开始

本页带你从安装到跑通第一个任务，全程约 5 分钟。

## 前置要求

- Node.js >= 22
- 任意支持 `anthropic-messages` 或 `openai-completions` 协议的模型 API key（Anthropic / OpenAI / DeepSeek / Moonshot 等均可）

## 安装

```bash
npm install -g hotpot-agent
```

npm 包名是 `hotpot-agent`，安装后的命令是 `hotpot`。

## 配置模型

编辑（首次会自动创建）用户级配置文件 `~/.hotpot/settings.json`，填入三档模型：

```json
{
  "models": {
    "high": { "provider": "anthropic", "model": "claude-sonnet-4-5", "apiKey": "$ANTHROPIC_API_KEY" },
    "medium": { "provider": "openai", "model": "gpt-4.1", "apiKey": "$OPENAI_API_KEY" },
    "low": {
      "provider": "deepseek",
      "model": "deepseek-chat",
      "apiKey": "$DEEPSEEK_API_KEY",
      "baseUrl": "https://api.deepseek.com/v1"
    }
  }
}
```

说明：

- `apiKey` 可以写字面值，也可以写 `"$VAR"` 引用环境变量（推荐）。
- 内置目录模型的协议按 provider 自动选择：anthropic 走 `anthropic-messages`，其余走 `openai-completions`。
- `baseUrl` 可省略，默认走各家官方端点；DeepSeek / Moonshot 等第三方端点需显式填写。
- 三档模型的用途见[分层模型路由](/advanced/orchestration)：贵模型只处理难任务，简单任务自动降级。

配置的完整字段见[配置](/guide/configuration)。

## 跑第一个任务

```bash
hotpot chat
```

输入一个任务，例如：

```
找出当前目录下所有 .ts 文件，统计行数写入 report.txt
```

agent 会自主多步调用工具完成：简单任务首轮直接派发执行，复杂任务会先产出 plan 等待你审批（`y` 批准、`n` 拒绝、其他非空行批注进入修订）。

终端里你会看到事件流：`[tool] name(参数摘要)` 是工具调用，`[spawn] worker-1 (tier=low): <task>` 是子 agent 诞生，`[plan] drafted/approved/denied` 是计划审批状态。

快捷键：

- `/exit` 退出对话
- Ctrl-C 中断当前回合（不退出进程）

## 打开 Web 端

```bash
hotpot web
```

默认启动在 http://127.0.0.1:4573（就绪后自动打开浏览器）。Web 端与 CLI 使用同一份配置和同一份会话存储，两边可以同时观察同一会话。详见 [Web 端](/guide/web)。

## 恢复历史会话

会话以 JSONL 落盘在 `~/.hotpot/sessions/`。用 `--session` 恢复任意历史会话继续对话：

```bash
hotpot chat --session ~/.hotpot/sessions/<会话文件>.jsonl
```

## 源码仓库开发态

如果你 clone 的是源码仓库（pnpm monorepo）：

```bash
pnpm install          # 安装依赖
pnpm dev cli chat     # tsx 直跑 CLI，等价于 hotpot chat
pnpm dev web          # 构建并启动 Web 端
pnpm test             # 全量测试
```

Benchmark runner 与遥测客户端也在仓库内，见[跑 Benchmark](/guide/benchmark)与[遥测](/advanced/telemetry)。
