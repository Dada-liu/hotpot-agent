// 测试用脚本适配器：streamChat 第 N 次调用回放 script[N] 的 StreamEvent 序列
// 供 core/cli 的循环测试复用（Ruling 3：Task 10 创建，Task 11/12 消费）；不触碰网络

import type { ChatRequest, LlmAdapter, StreamEvent } from "../types.ts";

export function scriptedAdapter(script: StreamEvent[][]): LlmAdapter {
	let call = 0;
	return {
		api: "scripted",
		streamChat(
			_req: ChatRequest,
			_signal: AbortSignal,
		): AsyncIterable<StreamEvent> {
			const round = script[call];
			call += 1;
			return (async function* (): AsyncGenerator<StreamEvent> {
				if (!round) {
					// 在迭代时抛错而非调用时同步抛，与真实适配器的失败方式一致
					throw new Error(
						`scriptedAdapter: script exhausted after ${script.length} round(s)`,
					);
				}
				for (const event of round) {
					yield event;
				}
			})();
		},
	};
}
