---
name: syncing-website-on-release
description: Use when preparing a hotpot-agent release tag（打新版本 tag / 发版 / 发布新版本）or when website content must be synced with the latest code（官网更新日志、同步官网、官网内容过时、首页特性过时）.
---

# Syncing the Website on Release

打新版本 tag 前，把官网更新日志补齐，并把官网正文与最新代码改动对齐。

## 核心规则

1. **先同步官网，再打 tag**。tag 一旦推送就会同时触发 npm 发布和官网部署，事后补日志会出现「官网落后于版本」的窗口。
2. **更新日志只写真实变化**。从 `git log`、`docs/changelog/` 和实际代码差异里提炼用户可感知的变化，不复制设计文档、不编造功能、不把内部重构写成用户收益。
3. **版本号三处一致**：`packages/hotpot-agent/package.json`、`packages/telemetry/src/defaults.ts` 的 `APP_VERSION`、tag `vX.Y.Z`。
4. **官网是独立 pnpm 项目**：`website/` 不在根 workspace，安装/构建必须在该目录执行并带 `--ignore-workspace`。

## 现有机制边界

- `.github/workflows/website.yml`：只在 `main` 分支的 `website/**` 改动时构建并部署 GitHub Pages。
- `.github/workflows/publish.yml`：只在 `v*` tag 上校验版本、跑测试并发布 npm。
- 没有任何步骤检查「新版本是否写了官网更新日志」或「官网正文是否跟着代码更新」，本 skill 就是这条缺失流程。

## 执行流程

### 1. 收集版本与变更

```bash
node -p "require('./packages/hotpot-agent/package.json').version"
git describe --tags --abbrev=0
git log --oneline --no-merges <lastTag>..HEAD
ls docs/changelog
```

要求：

- 新版本号与两份版本常量一致；如果只准备发版、尚未改版本号，先按发布流程同步版本号。
- 逐条阅读范围内的提交和 `docs/changelog/` 设计记录，按「编排 / 审批 / Web / 安全 / 基础设施 / Benchmark / 官网」归类。
- 只保留用户能观察到的行为、配置项、命令、UI 和性能/成本变化。

### 2. 写官网更新日志

编辑 `website/docs/changelog.md`，在文件顶部、上一版本之前插入：

```markdown
## vX.Y.Z（YYYY-MM-DD）

一句话概括本版本主题。

### 编排

- ...

### 审批

- ...
```

规则：

- 日期用发版当天日期。
- 同一能力只写一次，避免「编排」和「Web」重复描述同一修复。
- 破坏性变更、默认值变化、配置改名必须显式写出迁移方式。
- 纯文档措辞、内部重命名、测试补充不单列条目，除非影响用户行为。

### 3. 同步官网正文

对照以下来源逐页检查 `website/docs/`：

- 根 `README.md` / `README.en.md`
- 各包 `README.md`、`AGENTS.md`
- `docs/PRD.md`、`docs/changelog/`、`docs/improvement-report-*.md`
- 当前代码里的枚举、默认值、CLI 参数、REST 路径、目录结构

重点检查：

| 页面 | 易过时内容 |
|------|------------|
| `website/docs/index.md` | 首页特性卡、效果数字、架构图、命令示例 |
| `website/docs/guide/getting-started.md` | 安装命令、配置示例、快捷键 |
| `website/docs/guide/configuration.md` | 权限枚举与默认值、项目级白名单字段 |
| `website/docs/guide/cli.md` / `web.md` | 子命令、端口、交互流程 |
| `website/docs/advanced/*.md` | 事件名、依赖方向、并发上限、遥测字段、benchmark 数字 |

已知易错点：

- 权限三档是 `readonly / ask-on-dangerous / full`，Web 文案是「只读 / 危险操作询问 / 完全权限」；`workspace` 已废弃，不得再作为权限档位出现。
- 工作区（workspace）仍是独立功能实体，但和权限档位不是一回事，不要因为权限改名而删掉工作区文档。
- 项目级 `.hotpot/settings.json` 只允许覆盖 `mainAgentTier` / `maxParallelTasks` / `planMaxRevisions`；`permission` 只从用户级读取。

如果改动涉及根 `README.md` 或 `README.en.md`，两份必须同步修改，保持内容一致。

### 4. 构建校验

```bash
cd website
pnpm install --ignore-workspace --frozen-lockfile   # 依赖未装时才需要
RSPRESS_BASE=/hotpot-agent/ pnpm build
```

确认构建成功，且 `website/doc_build/changelog.html` 包含新版本号。构建产物不提交。

### 5. 提交、打 tag、推送

```bash
git add website packages/hotpot-agent/package.json packages/telemetry/src/defaults.ts
git commit -m "chore: release vX.Y.Z"
git push origin main
git tag vX.Y.Z
git push origin main --tags
```

顺序要求：

- 官网改动和版本号必须在同一个提交里，且进入 `main` 后才打 tag。
- 推送 `main` 会触发 website workflow；推送 tag 会触发 publish workflow。两个都要确认成功。
- 如果 tag 已经推错，不要强推覆盖 tag；按项目发布约定处理并说明。

## 验收清单

- [ ] `website/docs/changelog.md` 顶部有 `vX.Y.Z（发版日期）`。
- [ ] 更新日志只包含真实、用户可感知的变化。
- [ ] 首页特性卡与当前代码一致，没有 `工作区` 权限档位这类旧文案。
- [ ] `guide/` 与 `advanced/` 中的命令、枚举、默认值、路径和数字已核对。
- [ ] `RSPRESS_BASE=/hotpot-agent/ pnpm build` 通过，产物含新日志。
- [ ] 版本号两处一致，tag 与版本一致。
- [ ] website 与 publish 两个 GitHub Actions 均成功。

## Red Flags

| 想法 | 现实 |
|------|------|
| 「先打 tag，官网回头再补」 | tag 触发发布后官网仍停留在旧版本，用户看到的首屏和文档会与包不一致 |
| 「只加更新日志就算同步」 | 首页、配置、CLI 文档同样会过时；更新日志不能替代正文核对 |
| 「把 docs/changelog 整段搬过去」 | 设计文档面向维护者，官网要写用户能感知的行为和迁移方式 |
| 「workspace 只是改个名字，不用查」 | 旧权限档位会直接误导用户配置；必须全局搜索确认没有残留 |
| 「官网构建慢，跳过」 | 构建失败会在 CI 才暴露，tag 已经推出去，回滚成本更高 |
