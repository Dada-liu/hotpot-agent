# docs/archive/

设计探讨过程归档（2026-10-10 定稿）。前 4 份文档是 `docs/PRD.md` 的细节依据，需求变更时先改这里对应的章节，再同步 PRD.md；`05` 汇总 M5 遥测与 benchmarks 的落地方式。

## 文件说明

- `01-requirements.md` — 需求细化：目标量化、Goals/Non-goals/Anti-goals、P0/P1/P2 功能清单与验收标准、已确认决议
- `02-architecture.md` — 总体架构：技术选型、分层与包划分、数据流、JSONL 会话格式、配置体系、pi/dsh 借鉴与取舍
- `03-agent-orchestration.md` — 三层 agent 编排：难度评估与模型路由、plan 审批、并行拆分规则、上下文隔离、steer/queue
- `04-roadmap.md` — M1-M5 里程碑与验收标准、M4 扩展功能 14 项排序
- `05-m5-telemetry-benchmarks.md` — M5 遥测事件白名单、后台部署、benchmark 操作手册、主机分工与失败恢复
