// UI 事件协议（M3 定稿，web 包 protocol.ts 逐字照抄）：所有事件带 seq，
// 由 server 每会话一条 emit 管道在 emit 时刻分配，单调递增。
// - log：durable 会话事件，只由 tailer 路径产出（客户端按 event.id 去重）
// - delta：主流式文本增量（仅 server 驱动回合时产出，agentId 固定 "main"）
// - turn/plan/spawn/approval：瞬态事件，来自 turn 迭代器与审批桥
// createWireHub 是会话内的事件总线：emit 分配 seq 并留存 ring buffer；
// 订阅方重放走 buffer()，断线重连增量走 tailAfter()。

import type { SessionEvent } from "@hotpot/core";

export type WireEvent =
	| { seq: number; kind: "log"; event: SessionEvent }
	| { seq: number; kind: "delta"; agentId: string; text: string }
	| {
			seq: number;
			kind: "turn";
			phase: "start" | "end";
			stopReason?: string;
			error?: string;
	  }
	| {
			seq: number;
			kind: "plan";
			phase: "drafted" | "approved" | "denied" | "revision_exhausted";
			plan?: string;
	  }
	| {
			seq: number;
			kind: "spawn";
			agentId: string;
			role: "worker" | "task";
			tier: string;
			task: string;
			parentAgentId: string;
	  }
	| {
			seq: number;
			kind: "approval";
			requestId: string;
			approvalType: "tool" | "plan";
			summary: string;
			detail?: string;
			plan?: string;
	  };

// emit 入参：协议事件去掉 seq（seq 由 hub 在 emit 时刻分配）
type SansSeq<T> = T extends unknown ? Omit<T, "seq"> : never;
export type WireEventInput = SansSeq<WireEvent>;

export interface WireHub {
	// 分配 seq 并留 buffer；返回带 seq 的完整事件
	emit(event: WireEventInput): WireEvent;
	// 当前 buffer 全量（seq 升序），供订阅重放
	buffer(): WireEvent[];
	// seq 是否仍在留存窗口内
	hasSeq(seq: number): boolean;
	// 增量：返回 seq 之后的留存事件；seq 早于窗口（中间事件已被淘汰）返回 null，
	// 调用方需降级为全量重放
	tailAfter(seq: number): WireEvent[] | null;
	// 重放专用：与 emit 共享 seq 单调分配（seq 与 live 流连续），
	// 但不入 ring buffer、不广播——SSE 全量日志重放经此把 durable 事件
	// 重新包装为 wire 事件发给单个订阅者，不污染其他订阅者的 buffer/广播
	replay(event: WireEventInput): WireEvent;
}

const DEFAULT_CAPACITY = 2000;

export function createWireHub(opts?: { capacity?: number }): WireHub {
	const capacity = opts?.capacity ?? DEFAULT_CAPACITY;
	let lastSeq = 0;
	const buf: WireEvent[] = [];

	function emit(event: WireEventInput): WireEvent {
		lastSeq += 1;
		const full: WireEvent = { seq: lastSeq, ...event };
		buf.push(full);
		if (buf.length > capacity) {
			buf.shift(); // 超出上限丢最旧
		}
		return full;
	}

	function buffer(): WireEvent[] {
		return [...buf];
	}

	function hasSeq(seq: number): boolean {
		return buf.length > 0 && seq >= (buf[0]?.seq ?? 0) && seq <= lastSeq;
	}

	function tailAfter(seq: number): WireEvent[] | null {
		if (seq >= lastSeq) return [];
		const oldest = buf[0];
		if (oldest === undefined) return [];
		if (seq < oldest.seq - 1) return null; // seq+1 已被淘汰，增量不完整
		return buf.filter((e) => e.seq > seq);
	}

	function replay(event: WireEventInput): WireEvent {
		lastSeq += 1;
		return { seq: lastSeq, ...event };
	}

	return { emit, buffer, hasSeq, tailAfter, replay };
}
