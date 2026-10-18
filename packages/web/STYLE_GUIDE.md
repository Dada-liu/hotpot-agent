# Web 端样式规范

本文汇总 `packages/web` 的样式约定，新增 UI 时遵循。代码注释一律简体中文。

## 1. 主题与色板：黑白橙三色纪律

- 主题定义在 `src/styles.css`：语义变量放 `:root`，再经 `@theme inline` 映射成 Tailwind 颜色工具类。**禁止在组件里散写色值**，一律用语义类（`bg-background`、`text-muted-foreground`、`border-border` 等）。
- 三色分工：
  - 黑 `--primary #17171a`：主按钮、激活态、用户气泡、正文标题；
  - 白 `--background`：底色，灰阶（`--secondary #f7f7f8`、`--accent #ededef`）只做中性过渡；
  - 橙 `--brand #ff5c00`：仅用于强调与运行态（品牌、聚焦 ring、steer 胶囊、运行徽标、流式光标），浅橙 `--brand-soft` 做运行态底。
- `--destructive #d94800` 是橙系深档，不引入纯红。
- 边框分两档，按需取用：
  - `--border #f5f5f7`：极浅，用于全局裸边框（侧边栏分隔线、markdown 代码块等），已在 base 层对 `*` 统一设置；
  - `--border-strong #e3e3e6`：一级可见控件——「新建会话」按钮、对话输入卡片（`border border-border-strong`）。

## 2. Tailwind v4（CSS-first）

- 无 `tailwind.config.js`，主题全在 `src/styles.css` 的 `@theme inline`；新增语义色要同时写 `:root` 变量和 `@theme inline` 映射。
- **颜色工具类只上色不上宽度**：`border-border-strong` 必须搭配 `border` 才有边框线（v4 行为，踩坑记录）。
- 圆角梯度：`rounded-lg`（列表项）→ `rounded-xl`（卡片）→ `rounded-2xl`（输入卡片、大卡）。
- 阴影克制：默认无阴影；悬浮/输入卡用 `shadow-sm` 或 `shadow-lg shadow-black/5`，不使用浓重彩色阴影。

## 3. 布局：Kimi 式聊天页

- 内容窄列居中：对话流 `max-w-3xl`，欢迎态输入框 `max-w-2xl`，均 `mx-auto`。
- 三栏：左侧会话栏 `w-60`（`border-r bg-secondary/60`）｜中栏对话区｜右侧面板 `w-80`（`border-l bg-secondary/40`，仅 spawn 后展开）。
- 对话区按回合分组：用户消息右侧黑气泡（`ml-auto max-w-[80%] rounded-2xl rounded-br-md bg-primary`）；助手侧左侧头像栏——`main_agent.png` 头像（`size-9 rounded-full`）+ 内容列，过程区（思考 + 工具卡片）可折叠，最终回答裸排版文章流。
- 输入卡片浮于对话区底部：`rounded-2xl border border-border-strong bg-background p-3`。

## 4. 组件与资产

- 基础组件用 shadcn/ui（`src/components/ui/`，仓库自有代码），变体组合用 `cn()`；图标只用 `lucide-react`。
- 头像/形象图资产在仓库根 `public/`：
  - `logo.png`：产品 logo（侧栏、欢迎态、面板头部）；
  - `main_agent.png`：对话区助手头像；
  - `work_agent.png` / `work_agent_active.webp`、`task_agent.png` / `task_agent_active.webp`：右侧面板 worker/task 卡片，**运行中切换 `*_active` 动图**（见 `AgentPanel.nodeAvatarSrc`）。
- 头像加载失败回退首字母圆点（`AgentPanel.Avatar` 的 `broken` 状态）。

## 5. 流式（打字机）性能约定

- `Markdown`、`MessageBubble`、`ToolCallCard` 已 `memo` 化：流式期间每个 delta 都会触发 ChatView 重渲染，历史条目必须跳过。**新增进入对话流的列表组件时保持这一约定**。
- 流式光标用 `.md-streaming::after` 橙色竖条，`cursor-blink` 淡入淡出（不要改回 `steps` 硬切）。
- 滚动跟随在 ChatView 的 effect 里按活动计数驱动，不要在条目组件里各自滚动。

## 6. 代码组织

- 展示相关的纯逻辑（回合分组、会话命名）抽 `src/lib/*.ts` 纯函数，配 `test/*.test.ts`（现有范例：`turn-groups.ts`、`session-name.ts`）。
- 可擦除 TS、无 `any`、相对导入带 `.ts`/`.tsx` 扩展名、顶层导入（禁 inline import）。
- 提交前从仓库根跑 `pnpm test`、`pnpm typecheck`、`pnpm exec biome check`。
