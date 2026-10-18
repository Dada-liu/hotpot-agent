# docs/

项目文档目录。所有需求、架构、实现探讨先落到这里，确认后才写代码（md 即代码）。

## 内容说明

- `PRD.md` — 定稿产品需求文档（项目唯一权威需求来源）
- `archive/` — 探讨过程归档：需求细化、总体架构（含 core/orchestrator 模块目录约定）、三层编排设计、里程碑（PRD 的细节依据）
- `superpowers/plans/` — 实现计划（按里程碑生成，如 M1 计划）
- 实现细节下沉到各包 README，如 [packages/telemetry/README.md](../packages/telemetry/README.md)（M5.1 遥测客户端：事件白名单、脱敏、上报链路）。

阅读顺序：`PRD.md` → `archive/01` → `archive/02` → `archive/03` → `archive/04`。
