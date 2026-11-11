// 测试用并发闸门：让脚本化适配器的「峰值并发」可观测。
//
// 脚本适配器的流事件是同步连发的，消费方一个微任务队列内就能把整条流耗尽；
// 真实适配器有网络延迟，同批启动的流会长时间同时在飞。不设闸门时观测到的
// 峰值并发恒为 1，断言就失去了意义。闸门的做法：被观测的流进入生成器后先
// 不产出事件，等到期望数量的流同时在飞，再一起回放。
//
// 判据必须是「峰值」而不是「当前在飞数」。用当前值会踩两个坑：
//
//  1) 最后到达的那个流进入时就已经满足条件，它不会等待，而是立刻回放并结束，
//     计数当场减回去；先到的流醒来时看到的是回落后的计数，于是白等一轮。
//     峰值单调不减，先到的流确认「确实同时开过 8 个」即可放行。
//  2) 不区分流类型时（把 main/worker 也算进来）峰值会虚高：worker 的流在工具
//     执行期间一直挂着没关闭，8 个 task 只要 7 个在飞、加上 worker 就能凑到 8，
//     于是漏掉真正的并发缺口。所以只统计 role=task 这类被观测的流。
//
// 这里是**没有墙钟超时**的等待，这是刻意的。task 流进入 streamChat 之前要先落盘
// agent_spawn 与 user_msg，每次 append 都是 open/write/fsync/close（见
// packages/core/src/session/store.ts 的崩溃语义），而 fsync 走 libuv 线程池——
// 默认只有 4 个线程，8 个 task 的 16 次 fsync 按 4 条一批排队。实测空载单次
// ~13ms、第 8 个流比第 1 个晚到 190ms，机器过载时晚到秒级。
//
// 历代写法都栽在「等多久」上：
//   - 固定 100ms：空载勉强，稍一加压就先到的流提前放行，断言随负载在 4~7 抖；
//   - 静默 1000ms：过载时相邻两个流间隔超过 1 秒，仍然提前放行，实测又出现 6/8。
// 任何墙钟阈值都能被更大的负载击穿，而它击穿的方式是「伪装成通过」——峰值被
// 冻结在放行那一刻，测试报一个假的并发数。所以正常路径不设超时：调用方都用
// Promise.all 一次性启动整批任务，「峰值达到期望值」是必然事件。真凑不满就是
// 产品缺陷（池没开满、或 maxParallelTasks 小于期望），让它一直等到 vitest 的
// 用例超时，报「Test timed out」——慢，但不会说谎。
//
// 等待是事件驱动的（enter 时唤醒），不轮询：8 个等待者一起 setImmediate 空转会
// 抢事件循环，压力测试下把同批用例从 375ms 拖到 4500ms。
export interface ConcurrencyCounter {
	enter(): void;
	leave(): void;
	/** 当前在飞的流数 */
	current(): number;
	/** 历史峰值（单调不减） */
	peak(): number;
	/**
	 * 等到峰值达到 expected 后放行；signal 中止时提前返回（任务被 cancel 的
	 * 用例本来就测不到满并发）。没有超时兜底，理由见文件头。
	 */
	waitForPeak(expected: number, signal: AbortSignal): Promise<void>;
}

export function createConcurrencyCounter(): ConcurrencyCounter {
	let active = 0;
	let high = 0;
	// 只有并发数上升才可能让等待者达标，故 enter 时唤醒
	const listeners = new Set<() => void>();
	const notify = (): void => {
		for (const listener of [...listeners]) {
			listener();
		}
	};

	async function waitForPeak(
		expected: number,
		signal: AbortSignal,
	): Promise<void> {
		while (high < expected && !signal.aborted) {
			await new Promise<void>((resolve) => {
				let settled = false;
				const finish = (): void => {
					if (settled) {
						return;
					}
					settled = true;
					listeners.delete(finish);
					signal.removeEventListener("abort", finish);
					resolve();
				};
				listeners.add(finish);
				signal.addEventListener("abort", finish, { once: true });
			});
		}
	}

	return {
		enter() {
			active += 1;
			if (active > high) {
				high = active;
			}
			notify();
		},
		leave() {
			active -= 1;
		},
		current: () => active,
		peak: () => high,
		waitForPeak,
	};
}
