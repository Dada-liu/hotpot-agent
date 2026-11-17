# 更新日志

## v0.3.1（2026-11-17）

修复配置与显示名的几处硬伤，并把首次建代码索引从「看不出在跑」变成可中断、有进度。

### 修复

- `vector.embedding.apiKey` 允许留空或省略：Ollama、llama.cpp、vLLM 等本地 OpenAI 兼容服务通常不校验凭证，此前空串会让整份用户配置校验失败，`/api/settings` 与新建会话直接 500。
- `features` 改为严格校验：把 `vector` 拼成 `vetor` 之类的未知键会在启动时报出键名，而不是静默丢弃导致「开关配了没生效」。
- 设置弹窗补上「代码向量检索（embedding）」区块，可直接编辑 `model` / `baseUrl` / `apiKey`；功能开关清单补全 `vector`，修复保存设置时 `features.vector` 被写没的问题。
- 会话显示名改由服务端从日志首条用户消息派生（`SessionSummary.name`），不再只存在浏览器 localStorage：换 host、换端口、换浏览器都不会退化成工作路径。
- `code_search` 的两种空结果分开了：工作区没有可索引的源码文件时明确说明只索引源码而非静默返回「无匹配」，避免模型误判目录为空。

### 改进

- 建索引并行化：单请求 32 个 chunk、最多 4 个请求同时在途（原为串行每批 16 个）。
- 分批落盘：每约 256 个 chunk 写一次向量库与 manifest，中断只丢当前窗口，已落盘文件下次按 hash 跳过，不再从头重建。
- 进度可见：新增 `vector/progress` 审计事件（只含计数），web 端 composer 上方显示「正在建代码索引 x/y 文件」，索引完成或回合结束自动消失。

## v0.3.0（2026-11-16）

新增代码向量检索，并交付跨会话用户记忆、上下文自动压缩与设置弹窗全量配置。

### 新能力：代码向量检索

- 用户级设置 `features.vector=true` 并配置 OpenAI 兼容 `vector.embedding`（`model` / `baseUrl` / `apiKey`，apiKey 支持 `$ENV` 引用）后，main/worker/task 获得 `code_search` 工具，按语义检索当前工作区源码，结果带路径、起止行、得分与摘要片段。
- 惰性启动：装配与项目启动不扫描、不联网；首次检索才扫描当前目录，之后每次检索前按文件 hash 增量刷新索引。本地向量库与索引文件存于 `~/.hotpot/memory/vectors/<sha256(cwd)>.jsonl`，不进入项目目录。
- 外发边界：`.env*`、私钥、凭证/密码/token 文件与 YAML/JSON 等部署配置不参与索引；只有筛选后的待索引源码 chunk 与查询文本会 POST 到所配 embedding endpoint，未修改内容不重复请求索引 embedding。审计与遥测只含计数，不含路径与源码。
- 默认关闭；`vector` 相关字段只从用户级读取，项目级 `.hotpot/settings.json` 中的同名字段会被剥离，防止仓库重定向代码与凭证外发目的地。

### 新能力：用户记忆与上下文压缩

- `features.memory`（默认关闭）：main/worker 可经 `memory_save` 把稳定偏好或事实写入 `~/.hotpot/MEMORY.md`（人工可编辑的 Markdown），task 只读；每轮注入最新有界摘要，遥测只报开关与次数，正文永不上报。
- 上下文自动压缩（默认开启）：正式请求前按模型上下文预算触发摘要，压缩点落盘、恢复时注入摘要并跳过旧历史；`compaction.triggerRatio` / `keepRecentTokens` 可调（仅用户级）。

### Web 端

- 设置弹窗支持全部用户级配置（models / permission / features / compaction / hooks / webSearch / mcpServers / skillsDirs / promptsDirs / telemetry 等），敏感字段掩码展示、保存时保留原值。
- 主对话区只展示 main agent 内容与审批交互，worker/task 执行过程收进右侧面板。

### Benchmark 与基础设施

- 跑批新增实验台账（`pnpm exp`）与 worktree 脚手架、分片/续跑/合并，以及 `bench doctor` 自检；`exp run` 支持双版本对比编排，遥测回读只读。
- 遥测契约升到 v3：`benchmark_run` 必带 `attempt`（第几次尝试），服务端按 `(runId, instanceId, attempt)` 去重，v1/v2 客户端会被拒收。
- 源码仓库 `pnpm dev web` 正确透传 `--port` / `--host` / `--no-open`（此前 `--port` 会被静默忽略）。

### 官网

- 首页卡片入场动画、开场序列每个标签页永久只展示一次、loading 与图片体积优化。
- 配置页补充代码向量检索完整说明；架构页与遥测页同步 `packages/memory` 与 `vector/indexed` 事件。

## v0.2.0（2026-11-04）

新增会话文件预览与首屏启动动画。

### Web 端

- 会话区里的本地路径可以点击：文件在右侧面板以可关闭的 tab 打开（图片、文本预览），文件夹展示面包屑与单层目录浏览；可访问范围限定在会话 cwd 与 uploads 目录。
- 打开 Web 时播放一次启动动画，结束时 500ms 渐隐；每个标签页会话只播一次，刷新不再重播。
- 发送消息后立即显示用户消息、main agent 头像与处理中提示，不再等待首个事件到达。

### 官网

- 首页加入同一段启动动画（同样每个标签页会话只播一次）。
- 权限文案统一为「只读 / 危险操作询问 / 完全权限」。

## v0.1.2（2026-11-02）

针对并行 task agent 场景的审批死锁修复，以及对话区渲染与安全加固。

### 编排

- worker 并行拆分判据从「任务过大」改为「满足三条件即拆」，补写批量正例（创建多个相互独立的文件），task agent 派生更稳定。

### 审批

- 待处理审批由单槽位改为按 requestId 的映射，并发审批不再相互覆盖；审批条挂回各自的审计行，逐项可答。
- 订阅时按审批桥内存中挂起请求对账补发，刷新/重连后未决审批可恢复；切到 full 模式时放行在途审批，修复「回合永挂、卡片永转」死锁。

### Web 对话区

- 对话区 Markdown 渲染迁移至 streamdown，接入 GFM、代码高亮、公式与 mermaid。
- 权限弹窗、工具卡片、计划条与审批折叠等交互细节调整。

### 安全

- 本地 API 强制 token 鉴权，settings 输出时对 `apiKey` 做掩码；项目级 `.hotpot/settings.json` 不再允许覆盖权限配置。

### 官网与文档

- 官网新增博客 tab，更新首页 hero 与卡片；补充安装、使用与发布说明。

## v0.1.1（2026-10-25）

v0.1.0 之后的 Web 与编排迭代，重点补齐工作区、权限档位与输入框能力。

### 编排

- 移除 delegate 工具，改为 main 首轮提示词难度路由；新增 plan 草稿检测与格式模板，plan 扫描窗口对齐回合起点。
- 内联 agent 收尾时落盘 `agent_end` 事件。

### 工作区

- 新增持久化工作区注册表；服务端提供工作区 CRUD、会话归属与系统原生目录选择器。
- Web 侧栏按工作区分组、支持拖拽排序，并可通过原生选择器直接添加工作区。

### 权限与队列

- 三档权限模式、main 只读工具与 inbox 队列变更方法；Web 端提供中文权限档位选择器。
- 发送改为排队优先，回合进行中可排队补发并随时取消。

### 输入框与附件

- 输入框改为上下布局，支持回形针附件上传、`@` 文件提及与工作区选择。
- 新增临时草稿会话与始终可用的输入控件；发送/取消按钮补充 tooltip。

### 会话与面板

- agent 卡片状态改由 `agent_end` 驱动，新增任务清单与详情弹窗。
- 会话列表支持归档/删除、行尾操作菜单与省略名称；新增模型档位设置弹窗。
- 审批 durable requestId 透传为广播级 requestId，内外 id 统一，Web 审批 UI 同步调整。

### 基础设施

- 默认遥测地址指向已部署的 telemetry server；`turn_end` 的分档/分模型统计与 server schema 对齐。

### 官网与 benchmark

- 新增 Rspress 官网与 GitHub Pages 部署。
- benchmarks 移至仓库根目录，并新增 `software-pos-cart` 任务。

## v0.1.0（2026-10-19）

首个发布版本。核心闭环与配套体系均已通过里程碑验收（验收标准见仓库 `docs/archive/04-roadmap.md`）。

### 核心能力

- **最小可用闭环（M1）**：CLI 对话 → 工具调用 → 完成任务；append-only JSONL 会话日志为唯一事实源，进程被杀后可恢复续聊；bash / read / write / edit 四工具带审批 waterfall。
- **三层编排（M2）**：main 首轮提示词难度路由（trivial 直答 / simple 派 worker / complex 出 plan）、worker 执行与并行拆分（默认上限 10）、task 原子任务继承档位；plan 先审后执行（修订上限 3 轮）；steer / queue 双队列支持回合中纠偏与排队补发。
- **Web 端（M3）**：`hotpot web` 一键启动（默认 4573 端口）；REST + SSE 流式会话，断线重连从 JSONL 按偏移补发不丢事件；三栏界面含工具卡片、plan 审查、审批桥、队列与用量面板；CLI 与 Web 可同时观察同一会话。

### 扩展功能（M4，已完成 7/14）

todo 工具、steer/queue Web 交互、hooks（Claude Code 格式）、skill（SKILL.md 渐进式注入）、prompt templates（`/` 命令）、web_search / web_fetch 工具、MCP 接入（stdio + streamable HTTP，工具桥接 `mcp__<server>__<tool>`）。

### 配套体系（M5）

- **遥测客户端**：九类事件严格白名单、错误消息脱敏、匿名安装 ID、内存队列批量上报；明确不采集 prompt / 回复 / 工具入参输出 / 文件内容等用户内容。
- **Benchmark runner**：SWE-bench 官方 harness 评分 + 自建三题（金融 / 软件开发 / 自媒体）；SWE-bench Lite 10 题通过率 **9/10（90%）**，平均单题 input 908,943 / output 17,615 token，估算成本约 $4.62（patch-only 基线）。

### 路线（后续版本）

- M4 剩余项：上下文自动压缩、用户记忆、向量数据库、后台任务 jobs、权限预设、tool_search 延迟工具加载、沙箱。
- M5.2 遥测后台（仓库外独立项目）：ingest + 聚合 + 管理界面 + 告警。
