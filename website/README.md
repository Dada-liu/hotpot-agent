# hotpot-agent 官网

基于 [Rspress](https://rspress.rs/zh/) 的项目官网：项目介绍、文档与更新日志。

## 目录结构

```
website/
├── rspress.config.ts     # 站点配置（导航、侧边栏、页脚）
└── docs/                 # 站点内容
    ├── public/           # 静态资源（logo、特性图标）
    ├── index.md          # 首页
    ├── guide/            # 指南
    ├── advanced/         # 深入（架构与配套体系）
    └── changelog.md      # 更新日志
```

## 常用命令

```bash
pnpm install     # 安装依赖（注意：本目录不在根 workspace 内，需加 --ignore-workspace 或先 cd 进来）
pnpm dev         # 本地开发（默认 http://localhost:3000）
pnpm build       # 构建静态产物到 doc_build/
pnpm preview     # 本地预览构建产物
```

本目录是独立于根 pnpm workspace 的项目（`pnpm-workspace.yaml` 只匹配 `packages/*`），安装依赖请在 `website/` 目录内执行 `pnpm install --ignore-workspace`，避免 pnpm 上溯到仓库根 workspace。

## 部署

GitHub Actions 工作流 `.github/workflows/website.yml` 在 `main` 分支的 `website/**` 变动时自动构建并部署到 GitHub Pages，站点地址为 `https://<owner>.github.io/hotpot-agent/`。

首次启用需要在仓库 **Settings → Pages → Source** 选择 **GitHub Actions**。之后每次 push 到 `main`（或手动触发 workflow_dispatch）即自动发布。

部署形态与本地开发的差异由构建时的 `RSPRESS_BASE` 环境变量控制：

- CI：注入 `RSPRESS_BASE=/hotpot-agent/`，资源链接全部挂在子路径下；
- 本地：`base` 默认为 `/`，同时 `route.cleanUrls: false` 让页面链接显式带 `.html`，与 GitHub Pages 的静态服务行为一致（本地 dev/preview 两种路径都可访问）。

## 维护约定

- 站点内容为简体中文，页面组织参考 https://rspress.rs/zh/。
- 新增页面时同步更新对应目录的 `_meta.json` 与 `rspress.config.ts` 的 sidebar。
- 内容来源：根 `README.md`、`docs/`（PRD、archive）、各包 `README.md`；改写为用户文档语言，不整段搬运。
