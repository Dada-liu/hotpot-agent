# src/config/

settings.json 双层加载与功能开关。

- `config.ts` — zod schema（models/features/hooks/webSearch/mcpServers/skillsDirs/promptsDirs/approval/telemetry 等）、`loadSettings({ home, cwd })`、`featureEnabled(features, name)`。
- 用户级 `<home>/settings.json` 必填，含三档模型与凭证；`apiKey` 支持整串 `$ENV` 引用（仅用户级）。
- 项目级 `.hotpot/settings.json` 自 cwd 向上逐级查找，可选；只覆盖非凭证白名单字段，未知字段静默剥离。
- home 解析复用 `session/store.ts` 的 `resolveHome`（参数 > `HOTPOT_HOME` > `~/.hotpot`）。
- 模块级字段（`hooks`、`webSearch`、`mcpServers`、`skillsDirs`、`promptsDirs`、`telemetry`、`features.*`）仅来自用户级，避免恶意仓库注入命令或重定向凭证。
- `telemetry`（`enabled`/`endpoint`/`token`/`flushIntervalMs`）是 M5 匿名上报配置：`token` 支持整串 `$ENV`。endpoint/token 若可由项目级覆盖，会把上报数据与凭证导向攻击者，因此不在项目级白名单内。
- `index.ts` 是本特性的对外出口。
