// `pnpm bench` 的参数解析：与执行逻辑分离，测试不触发真实跑批。
// 约定：第一条位置参数是 suite（swebench | custom），其余均为 --flag value；
// 未知参数、缺值、非法枚举一律抛 UsageError，由 cli.ts 打印用法并以非 0 退出。

import type { ModelTier } from "@hotpot/core";
import { CUSTOM_TASK_DOMAINS, type CustomTaskDomain } from "./custom/task.ts";
import { parseShard, type ShardSpec } from "./shard.ts";
import { DEFAULT_SUITE_NAME } from "./suites.ts";

export const DEFAULT_DATASET = "SWE-bench/SWE-bench_Lite";
export const DEFAULT_SPLIT = "test";
export const DEFAULT_EVAL_HOST = "macmini";
export const DEFAULT_MAX_WORKERS = 1;
export const DEFAULT_INSTANCES_FILE = "instances.jsonl";
// 默认跑 3 次：单次通过率在 10 题上的方差是 ±1~2 题（10~20pp），
// 不重复就分不清「功能有效」和「这次运气好」。
export const DEFAULT_REPEAT = 3;

export const BENCH_USAGE = `Usage: pnpm bench <swebench|custom|merge|doctor> [options]

Suites:
  swebench   Generate patches for SWE-bench instances, then run the official harness.
  custom     Run the offline seeded domain tasks (finance, software, self-media).
  merge      Merge sharded runs into one comparable report.
  doctor     Preflight the machine before a long run (no model calls, no tokens).

Common options:
  --output <dir>            Output directory (default: ./benchmark-runs/<timestamp>)
  --model-tier <tier>       Model tier: high | medium | low (default: settings.mainAgentTier)
  --help                    Show this help.

swebench options:
  --instances-file <file>   Instance JSONL exported by scripts/export_instances.py
                            (default: instances.jsonl)
  --dataset <name>          Dataset name (default: ${DEFAULT_DATASET})
  --split <name>            Dataset split (default: ${DEFAULT_SPLIT})
  --repeat <k>              Attempts per instance, k >= 1 (default: ${DEFAULT_REPEAT})
                            Runs report the per-attempt pass rate plus its spread.
  --limit <n>               Keep at most n instances after selection
  --instance-ids <ids>      Comma-separated instance ids (keeps the given order)
  --seed <n>                Selection seed (default: 0)
  --shard <i/n>             Run only shard i of n (interleaved; 1-based)
  --resume                  Continue a previous run in --output, skip finished attempts
  --eval-mode <mode>        local | remote (default: local)
  --eval-host <host>        SSH host for remote evaluation (default: ${DEFAULT_EVAL_HOST})
  --max-workers <n>         Official harness workers (default: ${DEFAULT_MAX_WORKERS})
  --workspace-root <dir>    Worktree root (default: <output>/workspaces)

  Without --limit or --instance-ids, the ${DEFAULT_SUITE_NAME} suite is used (10 fixed instances).
  Keep its instance file exported once; the suite only pins which ids to run.

custom options:
  --domain <domain>         finance | software | self-media (default: all tasks)

merge options:
  <dir> [<dir> ...]         Shard output directories (all must be comparable)
  --output <dir>            Where to write the merged report (required)

doctor options:
  --instances-file <file>   Check the instance file that the run will use
  --eval-mode <mode>        Check local (python/docker) or remote (ssh/tmux) prerequisites
  --eval-host <host>        SSH host to probe in remote mode
  --offline                 Skip every network probe
`;

export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

export interface SwebenchCommand {
	suite: "swebench";
	output?: string;
	modelTier?: ModelTier;
	instancesFile: string;
	dataset: string;
	split: string;
	limit?: number;
	instanceIds?: string[];
	seed: number;
	// 每个实例重复跑几次：同一 runId 下保留每次尝试，用来估计波动
	repeat: number;
	// 分片：只跑 n 份里的第 i 份；manifest 会记下父集合哈希，供 merge 判定
	shard?: ShardSpec;
	// 续跑：复用 --output 里已完成的题，不重跑也不重评测
	resume: boolean;
	evalMode: "local" | "remote";
	evalHost: string;
	maxWorkers: number;
	workspaceRoot?: string;
}

export interface CustomCommand {
	suite: "custom";
	output?: string;
	modelTier?: ModelTier;
	domain?: CustomTaskDomain;
}

export interface MergeCommand {
	suite: "merge";
	dirs: string[];
	output: string;
}

export interface DoctorCommand {
	suite: "doctor";
	instancesFile: string;
	evalMode: "local" | "remote";
	evalHost: string;
	modelTier?: ModelTier;
	output?: string;
	offline: boolean;
}

export type BenchCommand =
	| { suite: "help" }
	| SwebenchCommand
	| CustomCommand
	| MergeCommand
	| DoctorCommand;

export function parseBenchArgs(argv: string[]): BenchCommand {
	if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
		return { suite: "help" };
	}

	const suite = argv[0];
	switch (suite) {
		case "swebench":
			return parseSwebench(argv.slice(1));
		case "custom":
			return parseCustom(argv.slice(1));
		case "merge":
			return parseMerge(argv.slice(1));
		case "doctor":
			return parseDoctor(argv.slice(1));
		default:
			throw new UsageError(`unknown suite: ${suite ?? ""}`);
	}
}

function parseSwebench(args: string[]): SwebenchCommand {
	const command: SwebenchCommand = {
		suite: "swebench",
		instancesFile: DEFAULT_INSTANCES_FILE,
		dataset: DEFAULT_DATASET,
		split: DEFAULT_SPLIT,
		seed: 0,
		repeat: DEFAULT_REPEAT,
		resume: false,
		evalMode: "local",
		evalHost: DEFAULT_EVAL_HOST,
		maxWorkers: DEFAULT_MAX_WORKERS,
	};

	const iter = new OptionIterator(args);
	while (iter.hasNext()) {
		const { flag, inlineValue } = iter.next();
		switch (flag) {
			case "--output":
				command.output = iter.value(flag, inlineValue);
				break;
			case "--model-tier":
				command.modelTier = parseModelTier(iter.value(flag, inlineValue));
				break;
			case "--instances-file":
				command.instancesFile = iter.value(flag, inlineValue);
				break;
			case "--dataset":
				command.dataset = iter.value(flag, inlineValue);
				break;
			case "--split":
				command.split = iter.value(flag, inlineValue);
				break;
			case "--limit":
				command.limit = parsePositiveInt(flag, iter.value(flag, inlineValue));
				break;
			case "--repeat":
				command.repeat = parsePositiveInt(flag, iter.value(flag, inlineValue));
				break;
			case "--instance-ids":
				command.instanceIds = parseIds(iter.value(flag, inlineValue));
				break;
			case "--seed":
				command.seed = parseInteger(flag, iter.value(flag, inlineValue));
				break;
			case "--shard":
				command.shard = parseShardArg(iter.value(flag, inlineValue));
				break;
			case "--resume":
				// 布尔开关：显式拒绝 "--resume=true" 这种写法，避免静默忽略
				if (inlineValue !== undefined) {
					throw new UsageError("--resume does not take a value");
				}
				command.resume = true;
				break;
			case "--eval-mode": {
				const value = iter.value(flag, inlineValue);
				if (value !== "local" && value !== "remote") {
					throw new UsageError(`--eval-mode must be local or remote`);
				}
				command.evalMode = value;
				break;
			}
			case "--eval-host":
				command.evalHost = iter.value(flag, inlineValue);
				break;
			case "--max-workers":
				command.maxWorkers = parsePositiveInt(
					flag,
					iter.value(flag, inlineValue),
				);
				break;
			case "--workspace-root":
				command.workspaceRoot = iter.value(flag, inlineValue);
				break;
			case "--domain":
				throw new UsageError("--domain is only valid for the custom suite");
			default:
				throw new UsageError(`unknown option: ${flag}`);
		}
	}
	return command;
}

function parseCustom(args: string[]): CustomCommand {
	const command: CustomCommand = { suite: "custom" };

	const iter = new OptionIterator(args);
	while (iter.hasNext()) {
		const { flag, inlineValue } = iter.next();
		switch (flag) {
			case "--output":
				command.output = iter.value(flag, inlineValue);
				break;
			case "--model-tier":
				command.modelTier = parseModelTier(iter.value(flag, inlineValue));
				break;
			case "--domain": {
				const value = iter.value(flag, inlineValue);
				if (!isCustomDomain(value)) {
					throw new UsageError(
						`--domain must be one of: ${CUSTOM_TASK_DOMAINS.join(", ")}`,
					);
				}
				command.domain = value;
				break;
			}
			default:
				throw new UsageError(`unknown option: ${flag}`);
		}
	}
	return command;
}

// merge 的参数形状与跑批不同：位置参数是「要合并的目录」，不是 suite 名。
// 所以单独解析，不套 OptionIterator（它把所有非 --flag 都当错误）。
function parseMerge(args: string[]): MergeCommand {
	const dirs: string[] = [];
	let output: string | undefined;
	let index = 0;
	while (index < args.length) {
		const raw = args[index];
		if (raw === undefined) {
			break;
		}
		if (raw === "--output") {
			const value = args[index + 1];
			if (value === undefined || value.startsWith("--")) {
				throw new UsageError("--output requires a value");
			}
			output = value;
			index += 2;
			continue;
		}
		if (raw.startsWith("--output=")) {
			const value = raw.slice("--output=".length);
			if (value === "") {
				throw new UsageError("--output requires a value");
			}
			output = value;
			index += 1;
			continue;
		}
		if (raw.startsWith("--")) {
			throw new UsageError(`unknown option: ${raw}`);
		}
		dirs.push(raw);
		index += 1;
	}
	if (dirs.length === 0) {
		throw new UsageError("merge requires at least one run directory");
	}
	if (output === undefined) {
		throw new UsageError("merge requires --output <dir>");
	}
	return { suite: "merge", dirs, output };
}

function parseDoctor(args: string[]): DoctorCommand {
	const command: DoctorCommand = {
		suite: "doctor",
		instancesFile: DEFAULT_INSTANCES_FILE,
		evalMode: "local",
		evalHost: DEFAULT_EVAL_HOST,
		offline: false,
	};

	const iter = new OptionIterator(args);
	while (iter.hasNext()) {
		const { flag, inlineValue } = iter.next();
		switch (flag) {
			case "--instances-file":
				command.instancesFile = iter.value(flag, inlineValue);
				break;
			case "--eval-mode": {
				const value = iter.value(flag, inlineValue);
				if (value !== "local" && value !== "remote") {
					throw new UsageError("--eval-mode must be local or remote");
				}
				command.evalMode = value;
				break;
			}
			case "--eval-host":
				command.evalHost = iter.value(flag, inlineValue);
				break;
			case "--model-tier":
				command.modelTier = parseModelTier(iter.value(flag, inlineValue));
				break;
			case "--output":
				command.output = iter.value(flag, inlineValue);
				break;
			case "--offline":
				if (inlineValue !== undefined) {
					throw new UsageError("--offline does not take a value");
				}
				command.offline = true;
				break;
			default:
				throw new UsageError(`unknown option: ${flag}`);
		}
	}
	return command;
}

class OptionIterator {
	private readonly args: string[];
	private index = 0;

	constructor(args: string[]) {
		this.args = args;
	}

	hasNext(): boolean {
		return this.index < this.args.length;
	}

	next(): { flag: string; inlineValue?: string } {
		const raw = this.args[this.index];
		this.index += 1;
		if (raw === undefined) {
			throw new UsageError("unexpected end of arguments");
		}
		if (!raw.startsWith("--")) {
			throw new UsageError(`unexpected argument: ${raw}`);
		}
		const separator = raw.indexOf("=");
		if (separator === -1) {
			return { flag: raw };
		}
		return {
			flag: raw.slice(0, separator),
			inlineValue: raw.slice(separator + 1),
		};
	}

	value(flag: string, inlineValue?: string): string {
		if (inlineValue !== undefined) {
			if (inlineValue === "") {
				throw new UsageError(`${flag} requires a value`);
			}
			return inlineValue;
		}
		const value = this.args[this.index];
		if (value === undefined || value.startsWith("--")) {
			throw new UsageError(`${flag} requires a value`);
		}
		this.index += 1;
		return value;
	}
}

function parseModelTier(value: string): ModelTier {
	if (value === "high" || value === "medium" || value === "low") {
		return value;
	}
	throw new UsageError("--model-tier must be high, medium or low");
}

// shard.ts 抛普通 Error（它不依赖 CLI 层），这里统一翻译成 UsageError
function parseShardArg(value: string): ShardSpec {
	try {
		return parseShard(value);
	} catch (err) {
		throw new UsageError(err instanceof Error ? err.message : String(err));
	}
}

function parseIds(value: string): string[] {
	const ids = value
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id !== "");
	if (ids.length === 0) {
		throw new UsageError("--instance-ids requires at least one id");
	}
	return ids;
}

function parsePositiveInt(flag: string, value: string): number {
	const parsed = parseInteger(flag, value);
	if (parsed < 1) {
		throw new UsageError(`${flag} must be a positive integer`);
	}
	return parsed;
}

function parseInteger(flag: string, value: string): number {
	if (!/^-?\d+$/.test(value)) {
		throw new UsageError(`${flag} must be an integer`);
	}
	return Number(value);
}

function isCustomDomain(value: string): value is CustomTaskDomain {
	return (CUSTOM_TASK_DOMAINS as readonly string[]).includes(value);
}
