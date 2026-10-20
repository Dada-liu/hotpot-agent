# packages/core/src/

`@hotpot/core` 的源码目录。本包是 agent 内核，不依赖任何 UI；会话 JSONL 事件日志是唯一事实源，UI 状态全部由 `deriveMessages` 推导。

`src/` 按特性分目录，每个目录以 `index.ts` 作为对外出口；根目录只保留包入口与 ambient 声明。

- `agent/`：turn/step 两级循环 `runTurn`；含 max_tokens 截断防御、finish=error 不执行工具、abort 补落 tool_result 等语义。
- `approval/`：审批 waterfall `ApprovalChain`，顺序询问，全部 next 时默认 deny（fail-closed）；`audit.ts` 负责 asked/decided 落盘。
- `config/`：`loadSettings({ home, cwd })` 双层加载——用户级 `<home>/settings.json` 必填（zod 校验，apiKey 支持 `$ENV` 引用，home 解析复用 `session/store.ts` 的 `resolveHome`）；项目级自 cwd 向上查找 `.hotpot/settings.json`（可选，只覆盖非凭证白名单字段）。
- `frontmatter/`：最小 frontmatter 解析，skill 与 prompt templates 共用。
- `hooks/`：生命周期钩子链（Claude Code 配置格式）。
- `prompt/`：系统提示词 section 注册表（按 order 拼接，prompt 文案全英文；`registerDefaultSections` 非幂等，有模块级守卫）。
- `prompt-templates/`：`prompts/*.md` → `/命令`，支持参数占位。
- `session/`：append-only JSONL 事件日志（`SessionEvent` 类型、`loadSession`/`createSession`/`resumeSession`、`deriveMessages` 转换历史；加载跳过末尾损坏行）。
- `skills/`：递归扫描 `SKILL.md`，产出 name/description/path 清单。
- `tools/`：工具框架（`ToolDefinition`/`ToolRegistry`，zod 校验擦除层）与 bash、read、write、edit、todo、web 工具；高危命令与覆盖写走审批。
- `index.ts`：包入口，仅 re-export 各特性目录的 `index.ts`，不写逻辑。
- `node-builtins.d.ts`：node builtins 的最小 ambient 声明（依赖白名单不允许 `@types/node`），用到新 API 时在此补充。各模块声明明细见下文「Node 内置模块声明」。

## Node 内置模块声明（`node-builtins.d.ts`）

依赖白名单不允许引入 `@types/node`，因此在 `node-builtins.d.ts` 对用到的 Node 内置模块做**最小 ambient 类型声明**，运行时由 Node 提供真身。只声明 `src/` 与 `test/` 实际用到的 API，用到新 API 时在此补充。

### `node:fs/promises`（异步文件读写）

会话 JSONL 日志的读写、read/write/edit 工具的落地，以及测试的临时目录管理。

- `open(path, "a")`：以追加模式打开文件，返回 `HotpotFileHandle`（`write`/`sync`/`close`）；`session/store.ts` 用它实现「写一行 + fsync」的崩溃语义（最多丢最后一行）。
- `mkdir(path, { recursive })`：递归建目录；`session/store.ts` 建会话目录、`tools/write.ts` 建目标文件父目录。
- `readFile(path, "utf8")`：读整个文件；`session/store.ts` 的 `loadSession`、`tools/read.ts`、`tools/edit.ts`。
- `writeFile(path, data)`：整文件覆盖写；`tools/edit.ts`、`tools/write.ts`。
- `readdir(path)`：列目录；`session/store.ts` 的 `listSessions` 遍历会话目录。
- `appendFile(path, data)`：追加内容；仅测试（`test/session.test.ts` 构造损坏的末尾半行）。
- `mkdtemp(prefix)`：建唯一临时目录；仅测试（各用例的临时 home/cwd）。
- `rm(path, { recursive, force })`：删除；仅测试（清理临时目录）。

### `node:fs`（同步文件读写）

`config/config.ts` 的 settings.json 同步加载。

- `existsSync(path)`：判断存在；`config/config.ts` 向上逐级探测项目级配置，`tools/write.ts` 判断目标是否已存在。
- `readFileSync(path, "utf8")`：同步读文件；`config/config.ts` 读 settings.json。

### `node:child_process`（子进程）

`tools/bash.ts` 执行 shell 命令。

- `spawn(command, args, { cwd })`：拉起子进程，返回 `HotpotChildProcess`。
- `HotpotChildProcess`：`stdout`/`stderr`（`HotpotChildStream`，监听 `data` 事件收输出）、`kill(signal)`、`on("error")`、`on("close", (code, signal))`——用 `close` 而非 `exit` 结算，避免丢失末尾输出。
- `HotpotChildStream`：子进程输出流，只用到 `data` 事件（chunk 运行时为 Buffer，结构上有 `toString`）。

### `node:os`（操作系统信息）

- `homedir()`：用户主目录；`session/store.ts` 的 `resolveHome` 默认回退到 `~/.hotpot`。
- `tmpdir()`：系统临时目录；仅测试（搭配 `mkdtemp` 建临时目录）。

### `node:path`（路径处理）

- `join(...parts)`：拼接路径；`session/store.ts`、`config/config.ts` 及测试。
- `resolve(...parts)`：解析为绝对路径；`config/config.ts` 与 read/edit/write 工具把入参规整为绝对路径。
- `dirname(path)`：取父目录；`config/config.ts` 向上逐级查找、`tools/write.ts` 取目标父目录。

### `node:crypto`

- `randomUUID()`：生成 UUID；`session/store.ts` 的会话 id、`agent/loop.ts` 的事件/消息 id。

### `process`（进程全局）

- `env`：环境变量；`session/store.ts` 读 `HOTPOT_HOME`、`config/config.ts` 做 apiKey 的 `$ENV` 插值。
- `platform`：操作系统平台；`agent/loop.ts` 写进系统提示词的运行环境信息。
- `cwd()`：当前工作目录；`config/config.ts` 未显式传 `cwd` 时作为项目级配置查找起点。
