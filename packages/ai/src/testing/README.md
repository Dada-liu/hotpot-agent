# src/testing/

随包源码发布的测试工具目录，供下游包（`core`、`cli`）在自己的测试里复用，避免多处重复实现 fake 适配器。

- `scripted-adapter.ts` — `scriptedAdapter(script: StreamEvent[][]): LlmAdapter`。脚本每个元素是一轮 `streamChat` 调用要回放的完整事件序列，按调用次序消费；脚本耗尽后再调用会在迭代时抛出 `script exhausted` 错误（异步 rejection，与真实适配器的失败方式一致）。
- `record-replay.ts` — `createRecordingAdapter(inner, file)` / `createReplayAdapter(file)`。录制格式为每轮一行 `{"request": ChatRequest, "events": StreamEvent[]}`；回放按调用顺序消费，耗尽后在迭代时抛出 `replay adapter exhausted`。
  - 录制文件是本地测试 fixture，不提交含真实用户 prompt/回复的录制；如需共享，先脱敏或改用 `scriptedAdapter` 手写事件序列。
  - 录制只在一轮完整消费后落盘：中途 abort 的半轮不会写入。
