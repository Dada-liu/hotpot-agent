# 用户记忆

用户记忆保存在用户级 `<home>/MEMORY.md`，默认路径为 `~/.hotpot/MEMORY.md`。`home` 参数和 `HOTPOT_HOME` 环境变量沿用 `resolveHome` 的解析顺序。文件是可人工编辑的 Markdown，不使用向量数据库，也不提供搜索工具或自动事实提取。

`appendMemory(content, home?)` 会去除正文首尾空白，拒绝空内容；首次写入创建 `# User Memory` 标题。每次写入追加一个 Markdown 列表项，多行正文的续行缩进两个空格，写入后执行 fsync。已有文件内容不会被覆盖。

`readMemorySummary(home?)` 在文件不存在或不可读时返回空字符串。内容不超过 8,000 字符时原样返回；超过时以 `[... older memory truncated ...]` 开头，只保留末尾能放入预算的完整 Markdown 列表条目。单个最新条目超过预算时只返回截断标记，不截断条目正文。

`createMemorySaveTool(home?)` 返回唯一写工具 `memory_save { content: string }`。写入成功后追加 `memory/saved { id, ts, agentId }` 会话审计事件，事件和工具成功结果均不复制记忆正文；写入失败返回 `isError`，不生成成功审计事件。

`features.memory` 仅允许用户级配置，默认 `false`。提示词注入和角色工具注册由编排层负责，本模块只提供存储、摘要与工具。
