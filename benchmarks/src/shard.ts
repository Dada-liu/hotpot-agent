// 分片：把「一波跑完 300 题」拆成「n 波各跑一部分」。
// 以前这件事靠跑批机器上的 run-lite300.sh，脚本不在仓库里——同一份结果没人能复现，
// 也没人知道分片之间是否真的覆盖了全集。这里把它变成确定性函数：
//
// - 分片规则固定为「按下标交错」（idx % count === index），同一份 selection 与同一组
//   参数永远得到同一子集；交错而不是切块，是因为实例按 seed 洗过牌，
//   交错能让每个分片都保留全集的仓库/难度构成。
// - 每个分片在 manifest 里记下父集合的 idsHash（parentIdsHash）与 shard 参数：
//   只有共享同一个父集合的分片才允许 merge，否则拼出来的「一轮」根本对不上。

export interface ShardSpec {
	// 0 基下标：对外展示为 1..count
	index: number;
	count: number;
}

// 接受 "2/3" 这种写法（1 基），返回 0 基的 spec。
// 非法输入抛普通 Error：参数层（cli-args）负责转成 UsageError 并打印用法。
export function parseShard(value: string): ShardSpec {
	const match = /^(\d+)\s*\/\s*(\d+)$/.exec(value.trim());
	if (match === null) {
		throw new Error(`shard must look like <index>/<count>, got "${value}"`);
	}
	const index = Number(match[1]);
	const count = Number(match[2]);
	if (!Number.isInteger(count) || count < 1) {
		throw new Error(`shard count must be a positive integer, got ${count}`);
	}
	if (!Number.isInteger(index) || index < 1 || index > count) {
		throw new Error(`shard index must be within 1..${count}, got ${index}`);
	}
	return { index: index - 1, count };
}

export function formatShard(spec: ShardSpec): string {
	return `${spec.index + 1}/${spec.count}`;
}

// 交错取片：空 spec 表示不分片，原样返回副本。
export function applyShard<T>(items: readonly T[], spec?: ShardSpec): T[] {
	if (spec === undefined) {
		return [...items];
	}
	if (spec.count === 1) {
		return [...items];
	}
	return items.filter((_, position) => position % spec.count === spec.index);
}
