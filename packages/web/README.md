# @hotpot/web

hotpot-code 的 Web UI（React SPA）。M3 产物：通过 server 的 REST + SSE API 观察与驱动会话。

## 定位

- 纯前端包，不依赖 `@hotpot/core` 等 node 包；与服务端的契约镜像在 `src/protocol.ts`（改动需与 `packages/server/src/wire.ts` 双侧同步）。
- 状态归约是纯函数（`src/state/reducer.ts`），UI 只是它的投影。

## 命令

```bash
pnpm --filter @hotpot/web dev    # 开发服务器（/api 代理到 http://localhost:4573）
pnpm --filter @hotpot/web build  # 产物输出到 packages/web/dist
```

## 静态资产

`vite.config.ts` 的 `publicDir` 指向仓库根 `public/`：logo 与各 agent 形象图（`logo.png`、`main_agent.png`、`work_agent*.webp`、`task_agent*.webp`）不搬迁、直接复用，构建时复制进 `dist/`。
