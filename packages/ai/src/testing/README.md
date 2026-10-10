# src/testing/

随包源码发布的测试工具目录，供下游包（`core`、`cli`）在自己的测试里复用，避免多处重复实现 fake 适配器。

- `scripted-adapter.ts` — `scriptedAdapter(script: StreamEvent[][]): LlmAdapter`。脚本每个元素是一轮 `streamChat` 调用要回放的完整事件序列，按调用次序消费；脚本耗尽后再调用会在迭代时抛出 `script exhausted` 错误（异步 rejection，与真实适配器的失败方式一致）。
