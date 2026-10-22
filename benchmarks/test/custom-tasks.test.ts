// 自建种子任务测试：JSON 全部可按 CustomTask 解析、id 唯一，
// 且每题的正确产物能通过自带校验脚本（校验脚本必须与题面口径一致）。
// 负例覆盖金融、软件两域：未产出/桩实现时校验必须失败，避免「空跑也通过」。

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CustomTask, loadCustomTasks, runCommand } from "../src/index.ts";

const TASKS_DIR = join(process.cwd(), "benchmarks/src/custom/tasks");

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
	it("三类域各有至少一题，全部可解析且 id 唯一", async () => {
		const tasks = await loadCustomTasks(TASKS_DIR);
		expect(tasks.length).toBeGreaterThanOrEqual(3);
		expect(new Set(tasks.map((task) => task.id)).size).toBe(tasks.length);
		// 三类域（金融 / 软件开发 / 自媒体）每类至少一题
		for (const domain of ["finance", "software", "self-media"] as const) {
			expect(tasks.some((task) => task.domain === domain)).toBe(true);
		}
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

	it("software-pos-cart：正确实现通过校验，桩实现与不舍入均失败", async () => {
		const task = await findTask("software-pos-cart");
		await writeWorkspace(task, {
			"data.js": [
				"export const PRODUCTS = [",
				'  { id: "a1", name: "Apple", price: 0.5 },',
				'  { id: "b2", name: "Bread", price: 0.2 },',
				'  { id: "c3", name: "Coffee", price: 0.1 },',
				'  { id: "d4", name: "Tea", price: 0.2 },',
				"];",
				"",
			].join("\n"),
			"cart.js": [
				"const round2 = (value) => Math.round(value * 100) / 100;",
				"",
				"function findProduct(products, id) {",
				"  const product = products.find((item) => item.id === id);",
				'  if (!product) throw new Error("unknown product");',
				"  return product;",
				"}",
				"",
				"function assertQty(qty, allowZero) {",
				"  if (!Number.isInteger(qty) || qty < 0 || (!allowZero && qty === 0)) {",
				'    throw new Error("invalid qty");',
				"  }",
				"}",
				"",
				"export function addItem(cart, products, id, qty = 1) {",
				"  assertQty(qty, false);",
				"  findProduct(products, id);",
				"  const existing = cart.find((item) => item.id === id);",
				"  if (existing) {",
				"    return cart.map((item) => (item.id === id ? { ...item, qty: item.qty + qty } : item));",
				"  }",
				"  return [...cart, { id, qty }];",
				"}",
				"",
				"export function setQty(cart, products, id, qty) {",
				"  findProduct(products, id);",
				"  assertQty(qty, true);",
				"  if (qty === 0) return cart.filter((item) => item.id !== id);",
				"  return cart.map((item) => (item.id === id ? { ...item, qty } : item));",
				"}",
				"",
				"export function removeItem(cart, id) {",
				"  return cart.filter((item) => item.id !== id);",
				"}",
				"",
				"export function cartTotal(cart, products) {",
				"  return round2(",
				"    cart.reduce((sum, item) => sum + findProduct(products, item.id).price * item.qty, 0),",
				"  );",
				"}",
				"",
				"export function checkout(cart, products, paid) {",
				"  const total = cartTotal(cart, products);",
				'  if (paid < total) throw new Error("insufficient payment");',
				"  return { total, change: round2(paid - total) };",
				"}",
				"",
			].join("\n"),
			"index.html": [
				"<!doctype html>",
				'<html lang="en">',
				'<head><meta charset="utf-8"><title>POS</title></head>',
				"<body>",
				'<ul id="product-list"></ul>',
				'<div id="cart"></div>',
				'<p>Total: <span id="total">0</span></p>',
				'<button id="checkout">Checkout</button>',
				'<script type="module" src="./data.js"></script>',
				'<script type="module" src="./cart.js"></script>',
				"</body>",
				"</html>",
				"",
			].join("\n"),
		});
		expect(await validate(task)).toBe(0);

		// 负例 1：桩实现必须失败
		const stub = task.workspace.files["cart.js"];
		await writeFile(join(dir, "cart.js"), stub, "utf8");
		expect(await validate(task)).not.toBe(0);

		// 负例 2：total/change 不做分位舍入时，0.1+0.2 用例必须失败
		const unrounded = (await readFile(join(dir, "cart.js"), "utf8"))
			.replace(
				"  return round2(\n    cart.reduce((sum, item) => sum + findProduct(products, item.id).price * item.qty, 0),\n  );",
				"  return cart.reduce((sum, item) => sum + findProduct(products, item.id).price * item.qty, 0);",
			)
			.replace(
				"return { total, change: round2(paid - total) };",
				"return { total, change: paid - total };",
			);
		await writeFile(join(dir, "cart.js"), unrounded, "utf8");
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
