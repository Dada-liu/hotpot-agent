// `pnpm bench` 的参数解析：与执行逻辑分离，测试不触发真实跑批。
// 约定：第一条位置参数是 suite（swebench | custom），其余均为 --flag value；
// 未知参数、缺值、非法枚举一律抛 UsageError，由 cli.ts 打印用法并以非 0 退出。

import type { ModelTier } from "@hotpot/core";
import { CUSTOM_TASK_DOMAINS, type CustomTaskDomain } from "./custom/task.ts";

export const DEFAULT_DATASET = "princeton-nlp/SWE-bench_Lite";
export const DEFAULT_SPLIT = "test";
export const DEFAULT_EVAL_HOST = "macmini";
export const DEFAULT_MAX_WORKERS = 1;
export const DEFAULT_INSTANCES_FILE = "instances.jsonl";

export const BENCH_USAGE = `Usage: pnpm bench <swebench|custom> [options]

Suites:
  swebench   Generate patches for SWE-bench instances, then run the official harness.
  custom     Run the offline seeded domain tasks (finance, software, self-media).

Common options:
  --output <dir>            Output directory (default: ./benchmark-runs/<timestamp>)
  --model-tier <tier>       Model tier: high | medium | low (default: settings.mainAgentTier)
  --help                    Show this help.

swebench options:
  --instances-file <file>   Instance JSONL exported by scripts/export_instances.py
                            (default: instances.jsonl)
  --dataset <name>          Dataset name (default: ${DEFAULT_DATASET})
  --split <name>            Dataset split (default: ${DEFAULT_SPLIT})
  --limit <n>               Keep at most n instances after selection
  --instance-ids <ids>      Comma-separated instance ids (keeps the given order)
  --seed <n>                Selection seed (default: 0)
  --eval-mode <mode>        local | remote (default: local)
  --eval-host <host>        SSH host for remote evaluation (default: ${DEFAULT_EVAL_HOST})
  --max-workers <n>         Official harness workers (default: ${DEFAULT_MAX_WORKERS})
  --workspace-root <dir>    Worktree root (default: <output>/workspaces)

custom options:
  --domain <domain>         finance | software | self-media (default: all tasks)
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

export type BenchCommand = { suite: "help" } | SwebenchCommand | CustomCommand;

export function parseBenchArgs(argv: string[]): BenchCommand {
	if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
		return { suite: "help" };
	}

	const suite = argv[0];
	if (suite !== "swebench" && suite !== "custom") {
		throw new UsageError(`unknown suite: ${suite ?? ""}`);
	}

	if (suite === "custom") {
		return parseCustom(argv.slice(1));
	}
	return parseSwebench(argv.slice(1));
}

function parseSwebench(args: string[]): SwebenchCommand {
	const command: SwebenchCommand = {
		suite: "swebench",
		instancesFile: DEFAULT_INSTANCES_FILE,
		dataset: DEFAULT_DATASET,
		split: DEFAULT_SPLIT,
		seed: 0,
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
			case "--instance-ids":
				command.instanceIds = parseIds(iter.value(flag, inlineValue));
				break;
			case "--seed":
				command.seed = parseInteger(flag, iter.value(flag, inlineValue));
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
