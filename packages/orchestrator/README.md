# @hotpot/orchestrator

三层 agent 编排，位于 core 之上。

本包做什么（M2 计划）：

- 主 agent：对话入口，负责难度评估与档位（tier）路由。
- 从 agent（worker）：承接主 agent 拆出的执行单元，支持并行拆分。
- 子 agent（task）：执行原子任务，无进一步拆分。
- plan 审批：执行计划先审批后落地。
- steer/queue 双队列：steer 队列注入中途指令，queue 队列排队后续任务。

当前状态：M2 进行中，本包仅为脚手架（package.json / AGENTS.md / README.md / 空入口 / 冒烟测试），Task 5 起填充实现。
