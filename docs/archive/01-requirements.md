# 01 需求细化

> 来源：`PRD.md`。本文档把 PRD 中的条目展开为可验收的需求。未标注的条目均为已确认决议。

## 1. 项目目标

构建一个基于 Node + TypeScript 的 code agent，项目名 **hotpot-code**。

核心原则：**更低的成本、更好的效果**。这句话需要可量化，否则无法指导设计决策：

| 维度 | 度量指标 | 采集方式 |
|------|----------|----------|
| 成本 | 单任务 token 消耗（input/output/cache 分项）、单任务耗时 | 遥测 + 会话事件中的 usage 记录 |
| 效果 | 任务成功率（benchmark 通过率）、人工干预次数 | benchmarks + 遥测 |

设计含义：任何增加 token 开销的功能（如三层编排、记忆注入）都必须能用数据证明它提升了成功率，否则默认关闭或简化。

## 2. Goals / Non-goals / Anti-goals

### Goals（要做）
- 完整可用的 agentic loop：对话 → 工具调用 → 结果回传 → 继续推理
- 三层 agent 编排：主 agent → 从 agent → 子 agent
- 复杂任务 human-in-the-loop：先 plan，用户审查后再执行
- 会话全量持久化，可回放、可审计
- Web 端操作界面

### Non-goals（不做）
- 不做 IDE 插件形态（VS Code 扩展等）
- 不做多用户协作/权限体系（单机单用户）
- 不自研 LLM，只适配第三方 provider
- P0 阶段不做 GUI 桌面端

### Anti-goals（做了就算失败）
- 编排开销大于收益：简单任务（一句话能解决的）被强行拆分，token 翻倍、延迟翻倍
- 会话存储缺漏：无法从存储中完整重建一次会话的上下文
- 工具无防护：bash 工具可无条件执行任意高危命令（如 `rm -rf ~`），没有确认机制

## 3. 工程原则（来自 PRD）

1. **md 即代码**：每个文件夹带 `README.md`（本文件夹做了什么）和 `AGENTS.md`（如何开发修改本文件夹）。当前层只概述子文件夹，具体内容下沉到子文件夹的 md。
2. 符合软件工程要求：模块化、可测试、类型严格（no `any`）、版本控制。
3. 文档语言：README/代码注释用简体中文；LLM prompt 和 AGENTS.md 用英文（附中文注释或中文版备份）。

## 4. 功能需求

### P0 基础功能

#### F1 基础 agentic loop
- 循环：用户消息 → LLM 推理（流式）→ 解析 tool call → 执行工具 → 结果追加到上下文 → 再次推理，直到 LLM 不再调用工具
- 支持中断（用户随时取消当前轮次）
- 支持上下文长度管理：M1 先做「超限报错 + 提示用户开新会话」，自动压缩放到 M4（见 `docs/04-roadmap.md` M4 第 8 项）
- 验收：给定一个需要多步工具调用的任务（如「找出 src 下所有 .ts 文件并统计行数写进 report.txt」），agent 能自主完成

#### F2 系统提示词
- 分层组织：身份与原则 → 工具使用规范 → 环境信息（OS、cwd、日期）→ 任务指令
- 所有 prompt 用英文撰写（AGENTS.md 约定），在代码中以模板函数组装，禁止字符串散落各处
- 验收：prompt 有独立模块管理，单元测试覆盖组装逻辑

#### F3 四个基础工具
bash / read / write / edit 四个（已确认）。理由：这是 code agent 的最小完备集——bash 提供通用能力，read/write/edit 提供结构化文件操作（比纯 bash 更省 token、更易审计）。

| 工具 | 说明 | 防护 |
|------|------|------|
| bash | 执行 shell 命令，返回 stdout/stderr/exit code | 超时限制；高危命令需用户确认 |
| read | 读文件，支持行范围分页 | 拒绝二进制/超大文件直接全读 |
| write | 创建或整体覆写文件 | 覆写已存在文件前确认 |
| edit | 精确字符串替换（old_string/new_string） | old_string 不唯一时报错 |

- 验收：每个工具有单元测试；工具定义（name/description/schema）统一注册，供 LLM tool calling 使用

#### F4 LLM 适配器
- provider 无关的统一接口：流式消息、tool calling、用量统计（usage）
- 首批适配：Anthropic（Claude 系列）+ OpenAI 兼容协议（覆盖 GPT、DeepSeek、Kimi 等）（已确认）
- 内置重试（指数退避）、超时、限流错误处理
- 验收：同一个 agent 对话逻辑，切换 provider 只改配置不改代码

#### F5 agent 编排（三层结构）
- **主 agent**：一个对话就是一个主 agent。接收用户输入，判断任务难度
- **从 agent**：主 agent 分配任务的执行单元。从 agent 判断任务是否可并行，可再切分为多个子 agent
- **子 agent**：并行执行的具体执行单元，独立上下文，结果摘要回传
- 简单任务：跳过 plan 审查，直接分配给从 agent 执行
- 复杂任务：先产出 plan → 用户审查/修改/批准 → 再分给从/子 agent 执行
- 详细设计见 `docs/03-agent-orchestration.md`
- 验收：简单任务不经过 plan 审查（观测 token 消耗验证）；复杂任务必须经过用户批准才开始执行

#### F6 原始会话全量存储
- 每会话一个 JSONL 文件：每条记录是一个事件（用户消息、LLM 请求/响应、tool call、tool result、agent 派生、usage、错误）
- 事件流可完整重建任意时刻的上下文（append-only，不改写历史）
- 存储位置：`~/hotpot-code/sessions/`（已确认，详见 `docs/02-architecture.md` 第 5 节）
- 验收：kill 进程后重启，能从 JSONL 恢复会话继续对话

#### F7 Web 端
- 会话列表（新建/恢复/归档）
- 实时流式对话展示（SSE）
- 工具调用可视化：展示工具名、参数、结果，bash 命令高亮
- plan 审查界面：展示 plan，支持批准/拒绝/批注
- 验收：web 端完成 F1-F6 的全部操作，不依赖 CLI

### P1 扩展功能

> 实施顺序与详细说明以 `docs/04-roadmap.md` M4 为准（参考 pi/dsh 调研后增补了 hooks、prompt templates、web 工具、jobs、权限预设、tool_search 六项）。

| 功能 | 说明 | 依赖 |
|------|------|------|
| steer / queue | 任务执行中插入新指令（steer）；任务排队（queue） | F5 |
| plan 模式 / todo | plan 模式在 F5 中已有；todo 是 agent 自管理的任务清单工具 | F5 |
| MCP 支持 | 接入 MCP server，工具自动注册进工具体系 | F3 |
| skill 支持 | 加载 SKILL.md 形式的技能包，渐进式按需注入上下文 | F2 |
| 用户记忆 | 跨会话记忆用户偏好与事实，写入/检索策略待定 | F6 |
| 向量数据库 | 为记忆和代码检索提供 embedding 索引 | 用户记忆 |
| 沙箱 | 工具执行隔离（docker/Seatbelt），bash 工具的安全升级 | F3 |
| hooks | 生命周期钩子链：session_start、pre/post tool、turn_end | F3 |
| prompt templates | `prompts/*.md` 变成 `/命令`，支持参数占位 | F2 |
| web_search / web_fetch | 联网搜索与抓取工具 | F3 |
| 后台任务 jobs | 后台 bash、子 agent 后台运行 | F5 |
| 权限预设 | sandbox/approval 旋钮打包（safe / default / yolo） | F3 |
| tool_search | 工具目录延迟加载，工具多时省 token | F3 |

### P2 配套

| 项目 | 说明 |
|------|------|
| 测试 | 单元测试（vitest）+ 集成测试（agent 端到端场景，mock LLM） |
| benchmarks | SWE-bench（标准化）+ 自建 bench：金融、软件开发、自媒体运营三个领域 |
| 遥测 | token 用量、耗时、工具调用成功率、任务成功率，本地存储可导出 |

## 5. 已确认决议记录

| 问题 | 决议 |
|------|------|
| 四个基础工具 | bash / read / write / edit |
| 会话存储位置 | `~/hotpot-code/sessions/` |
| 首批 LLM provider | Anthropic + OpenAI 兼容协议（api × provider 二维适配，见 `docs/02-architecture.md`） |
| 项目名 | hotpot-code |
| 自建 benchmark 题目来源 | 金融、软件开发、自媒体运营三个领域各先出 1 题（由设计者出题打底），后续从日常使用本 agent 的历史任务中沉淀 |
