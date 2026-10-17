// steer/queue 双队列：next-turn（followup，turn 结束消费）与 next-step（steer/inject，step 顶部经
// LoopConfig.pollInbox 注入）。设计见 docs/archive/03-agent-orchestration.md 第 7 节。
// 每次变更动词先更新内存队列，再追加一条 inbox/spliced 事件（queue + 该队列全量快照）；
// foldInbox 从持久化事件流顺序转换出两队列最终状态，供崩溃恢复重建内存队列
// （createInbox 的 seed 选项直接消费 foldInbox 的返回，播种不追加新快照）。
// foldInbox 是纯函数、无 IO；变更动词的落盘走 createInbox 闭包的 session 句柄，append 本身带 fsync。

import { randomUUID } from "node:crypto";
import type {
	InboxMessage,
	InboxQueue,
	Session,
	SessionEvent,
} from "@hotpot/core";

export interface Inbox {
	// next-turn 排队（FIFO，turn 结束后消费）
	followup(content: string): Promise<void>;
	// next-step 排队并唤醒（经 pollInbox 下步注入）
	steer(content: string): Promise<void>;
	// next-step 排队不唤醒
	inject(content: string): Promise<void>;
	// 调 opts.onCancel（CLI 侧接 AbortController）
	cancel(): void;
	// 取出并清空 next-turn
	drainNextTurn(): Promise<InboxMessage[]>;
	// 取出并清空 next-step（供 LoopConfig.pollInbox）
	pollNextStep(): Promise<string[]>;
}

export interface InboxState {
	nextTurn: InboxMessage[];
	nextStep: InboxMessage[];
}

// 按消息 id 去重：同 id 重复出现不重复入队，保留首次出现的位置（FIFO 次序稳定）
function dedupeById(messages: InboxMessage[]): InboxMessage[] {
	const seen = new Set<string>();
	const out: InboxMessage[] = [];
	for (const m of messages) {
		if (seen.has(m.id)) {
			continue;
		}
		seen.add(m.id);
		out.push(m);
	}
	return out;
}

export function createInbox(
	session: Session,
	agentId: string,
	opts?: { onCancel?: () => void; seed?: InboxState },
): Inbox {
	// seed 存在时以 foldInbox 的结果初始化两队列（崩溃恢复路径）：快照代表的
	// 意图已在上次变更动词时落盘，播种只重建内存队列，不追加 inbox/spliced。
	// 拷贝数组避免与调用方共享引用（drain 会整体替换队列）
	const state: InboxState = opts?.seed
		? {
				nextTurn: [...opts.seed.nextTurn],
				nextStep: [...opts.seed.nextStep],
			}
		: { nextTurn: [], nextStep: [] };

	// 变更动词共用路径：入队（同 id 去重）→ 落盘该队列全量快照
	async function splice(queue: InboxQueue, content: string): Promise<void> {
		const target = queue === "next-turn" ? state.nextTurn : state.nextStep;
		const message: InboxMessage = { id: randomUUID(), content };
		if (!target.some((m) => m.id === message.id)) {
			target.push(message);
		}
		await session.append({
			type: "inbox/spliced",
			id: randomUUID(),
			ts: new Date().toISOString(),
			agentId,
			queue,
			messages: [...target],
		});
	}

	// steer 与 inject 的数据路径完全一致（都进 next-step，都落盘快照）；
	// 区别仅在于唤醒语义——steer 期望打断当前等待、让主 agent 尽快消费 next-step。
	// M2 不做进程内唤醒，唤醒由 CLI 在 turn 空闲时处理（Task 11），故两者实现相同。
	return {
		followup(content: string): Promise<void> {
			return splice("next-turn", content);
		},
		steer(content: string): Promise<void> {
			return splice("next-step", content);
		},
		inject(content: string): Promise<void> {
			return splice("next-step", content);
		},
		cancel(): void {
			// 不做队列变更：cancel 语义是中断当前 turn（CLI 侧 AbortController），
			// 已排队的消息是否保留由调用方决定
			opts?.onCancel?.();
		},
		async drainNextTurn(): Promise<InboxMessage[]> {
			const drained = state.nextTurn;
			state.nextTurn = [];
			// 刻意不落盘：快照只在显式变更动词时写入。drain 是运行时本地消费，
			// 持久化快照代表用户意图——崩溃后重新转换应恢复到变更后的队列。
			// 副作用：已 drain 但尚未处理的消息崩溃后会重现，M2 最小实现可接受。
			return drained;
		},
		async pollNextStep(): Promise<string[]> {
			const drained = state.nextStep;
			state.nextStep = [];
			// 不落盘，理由同 drainNextTurn
			return drained.map((m) => m.content);
		},
	};
}

// 从持久化事件流转换出两队列最终状态（崩溃恢复用）。
// 逐条处理 inbox/spliced：以快照整体替换对应队列（last write wins），并按消息 id 去重。
// 无 agentId 参数：转换全部 inbox 事件，不过滤——按 agent 隔离是调用方的职责
// （调用方只会把自己会话的事件传进来）；非 inbox 事件直接忽略。
export function foldInbox(events: SessionEvent[]): InboxState {
	const state: InboxState = { nextTurn: [], nextStep: [] };
	for (const e of events) {
		if (e.type !== "inbox/spliced") {
			continue;
		}
		if (e.queue === "next-turn") {
			state.nextTurn = dedupeById(e.messages);
		} else {
			state.nextStep = dedupeById(e.messages);
		}
	}
	return state;
}
