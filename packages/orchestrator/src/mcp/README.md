# src/mcp/

MCP 客户端桥接（M4 Feature⑦）：`settings.mcpServers` 的 server 配置 → core 工具。

- `connectMcpServers(config, opts?)`：stdio（`command`/`args`/`env`，stderr inherit）与 streamable HTTP（`url`/`headers`）；逐 server try/catch，单个失败 warn + 跳过，不阻塞其余装配；连接超时 `MCP_CONNECT_TIMEOUT_MS`（30s）；连接层可注入 `createClient`，测试用 stub 保持 hermetic。
- `bridgeMcpTools(connection)`：`listTools` 结果转 `ToolDefinition`，命名 `mcp__<server>__<tool>`（非法字符替换为 `_` 并 warn），`inputSchema` 经 `json-schema-to-zod/`；execute 转发 `client.callTool`，60s 超时，content 的 text 块换行拼接，MCP `isError` 透传；`isConcurrencySafe: false`。
- `closeMcpConnections(connections)`：统一关闭 transport（stdio 子进程随之结束）。
- 工具只进 worker/task 注册表；main 永远只有元工具。
- `index.ts` 是本特性的对外出口。
