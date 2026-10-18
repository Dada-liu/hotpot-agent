# src/models/

档位模型解析：`ModelRef` → 模型信息 + 协议适配器 + 凭证。

- `resolveModel(ref)`：优先用 `@hotpot/ai` 的 `findModel` 目录；未命中时按 provider 名推断协议（anthropic → anthropic-messages，其余 → openai-completions）。
- 未知模型使用保守的 `contextWindow` 默认值，定价记 0（未知即不可计费），并输出告警。
- `index.ts` 是本特性的对外出口。
