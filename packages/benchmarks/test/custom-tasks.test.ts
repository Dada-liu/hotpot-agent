// 三题种子任务测试：JSON 全部可按 CustomTask 解析、id 唯一，
// 且每题的正确产物能通过自带校验脚本（校验脚本必须与题面口径一致）。
// 负例覆盖金融与软件两题：未产出/桩实现时校验必须失败，避免「空跑也通过」。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CustomTask, loadCustomTasks, runCommand } from "../src/index.ts";

const TASKS_DIR = join(process.cwd(), "packages/benchmarks/src/custom/tasks");

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "hotpot-bench-tasks-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeWorkspace(task: CustomTask, extra: Record<string, string>) {
	for (const [relative, content] of Object.entries({
		...task.workspace.files,
		...extra,
	})) {
		await writeFile(join(dir, relative), content);
	}
}

async function validate(task: CustomTask): Promise<number> {
	const result = await runCommand("bash", ["-c", task.validation.command], {
		cwd: dir,
		timeoutMs: 30000,
	});
	return result.code;
}

describe("seeded custom tasks", () => {
	it("三题都能解析且 id 唯一", async () => {
		const tasks = await loadCustomTasks(TASKS_DIR);
		expect(tasks).toHaveLength(3);
		expect(new Set(tasks.map((task) => task.id)).size).toBe(3);
		expect(tasks.map((task) => task.domain).sort()).toEqual([
			"finance",
			"self-media",
			"software",
		]);
	});

	it("finance：正确的 returns.json 通过校验，缺失时失败", async () => {
		const task = await findTask("finance-daily-returns");
		await writeWorkspace(task, {
			"returns.json": JSON.stringify({
				returns: [
					{ date: "2024-01-03", return: 0.02 },
					{ date: "2024-01-04", return: -0.02 },
					{ date: "2024-01-05", return: 0.030412 },
				],
			}),
		});
		expect(await validate(task)).toBe(0);

		await rm(join(dir, "returns.json"), { force: true });
		expect(await validate(task)).not.toBe(0);
	});

	it("software：实现 slugify 后通过校验，桩实现失败", async () => {
		const task = await findTask("software-slugify");
		await writeWorkspace(task, {
			"slug.js": [
				"export function slugify(input) {",
				"  return input",
				"    .toLowerCase()",
				'    .replace(/[^a-z0-9]+/g, "-")',
				'    .replace(/^-+|-+$/g, "");',
				"}",
				"",
			].join("\n"),
		});
		expect(await validate(task)).toBe(0);

		await writeFile(
			join(dir, "slug.js"),
			"export function slugify() { throw new Error('not implemented'); }\n",
			"utf8",
		);
		expect(await validate(task)).not.toBe(0);
	});

	it("self-media：符合结构的 plan.json 通过校验", async () => {
		const task = await findTask("self-media-plan");
		await writeWorkspace(task, {
			"plan.json": JSON.stringify({
				title: "Weekend camping gear checklist",
				hook: "Don't buy anything before watching this.",
				outline: [
					"Pick a campsite",
					"Choose a tent",
					"Pack cooking gear",
					"Plan the route",
				],
				hashtags: ["#camping", "#outdoors", "#gear"],
			}),
		});
		expect(await validate(task)).toBe(0);
	});
});

async function findTask(id: string): Promise<CustomTask> {
	const tasks = await loadCustomTasks(TASKS_DIR);
	const task = tasks.find((candidate) => candidate.id === id);
	if (task === undefined) {
		throw new Error(`missing seeded task ${id}`);
	}
	return task;
}
