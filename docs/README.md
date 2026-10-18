# docs/

项目文档目录。所有需求、架构、实现探讨先落到这里，确认后才写代码（md 即代码）。

## 内容说明

- `PRD.md` — 定稿产品需求文档（项目唯一权威需求来源）
- `archive/` — 探讨过程归档：需求细化、总体架构（含 core/orchestrator 模块目录约定）、三层编排设计、里程碑、M5 遥测与 benchmarks（PRD 的细节依据）
- `benchmark-authoring.md` — 自建 benchmark 题目沉淀流程（筛选历史会话 → 脱敏 → 题目化 → 校验脚本 → 回归）
- `superpowers/plans/` — 实现计划（按里程碑生成，如 M1 计划）
- 实现细节下沉到各包 README，如 [packages/telemetry/README.md](../packages/telemetry/README.md)（M5.1 遥测客户端：事件白名单、脱敏、上报链路）、[packages/benchmarks/README.md](../packages/benchmarks/README.md)（M5 benchmark runner：SWE-bench 官方评测、自建三题）。

阅读顺序：`PRD.md` → `archive/01` → `archive/02` → `archive/03` → `archive/04` → `archive/05` → `benchmark-authoring.md`。
