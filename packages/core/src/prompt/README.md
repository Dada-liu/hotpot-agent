# src/prompt/

`index.ts` 是本特性的对外出口；内部文件之间按具体路径导入。

系统提示词 section 注册表：各功能模块以「段」为单位注册文本，`buildSystemPrompt` 按 `order` 升序拼接（段间空行分隔），产出传给 LLM 的 `ChatRequest.system`。设计借鉴 dsh/pi，见 `docs/archive/02-architecture.md` 第 3 节。

- `sections.ts` — 注册表本体：`PromptSection`（name + order + 静态文本或 ctx 函数）、`PromptContext`（cwd/os/date/tools）、`registerSection`、`buildSystemPrompt`、`resetSections`（仅供测试隔离）。
- `default-sections.ts` — 默认四段 identity / tools / rules / env，order 常量集中在 `SECTION_ORDER`（0/1000/2000/3000，留出插入空间）；`registerDefaultSections()` 一次性注册。

约定：所有 prompt 文案为英文（见根 AGENTS.md）；段文案保持简洁，每段几行。
