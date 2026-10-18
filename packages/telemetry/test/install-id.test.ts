import { chmodSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateInstallId } from "../src/install-id.ts";

const homes: string[] = [];

async function makeHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "hotpot-telemetry-"));
	homes.push(home);
	return home;
}

afterEach(async () => {
	await Promise.all(
		homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
	);
});

describe("loadOrCreateInstallId", () => {
	it("returns the same UUID on repeated calls", async () => {
		const home = await makeHome();
		const first = loadOrCreateInstallId({ home, kind: "user" });
		const second = loadOrCreateInstallId({ home, kind: "user" });
		expect(second).toBe(first);
		expect(first).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("persists the UUID under <home>/telemetry/install-id", async () => {
		const home = await makeHome();
		const id = loadOrCreateInstallId({ home, kind: "user" });
		const path = join(home, "telemetry", "install-id");
		expect((await readFile(path, "utf8")).trim()).toBe(id);
	});

	it("uses a separate file and ID for the benchmark kind", async () => {
		const home = await makeHome();
		const first = loadOrCreateInstallId({ home, kind: "user" });
		const benchmark = loadOrCreateInstallId({ home, kind: "benchmark" });
		expect(benchmark).not.toBe(first);
		expect(benchmark).toMatch(/^[0-9a-f-]{36}$/);
		const path = join(home, "telemetry", "benchmark-install-id");
		expect((await readFile(path, "utf8")).trim()).toBe(benchmark);
		// benchmark 独立存盘，不覆盖用户态 ID
		expect(loadOrCreateInstallId({ home, kind: "user" })).toBe(first);
	});

	it("regenerates and rewrites an invalid file", async () => {
		const home = await makeHome();
		const path = join(home, "telemetry", "install-id");
		const original = loadOrCreateInstallId({ home, kind: "user" });

		await writeFile(path, "not-a-uuid");
		const regenerated = loadOrCreateInstallId({ home, kind: "user" });
		expect(regenerated).toMatch(/^[0-9a-f-]{36}$/);
		expect(regenerated).not.toBe(original);
		// 新 ID 已写回文件，下一次调用直接复用
		expect((await readFile(path, "utf8")).trim()).toBe(regenerated);
		expect(loadOrCreateInstallId({ home, kind: "user" })).toBe(regenerated);
	});

	it("defaults to the user kind", async () => {
		const home = await makeHome();
		expect(loadOrCreateInstallId({ home })).toBe(
			loadOrCreateInstallId({ home, kind: "user" }),
		);
	});

	it("returns a fresh UUID instead of throwing when the home is read-only", async () => {
		const home = await makeHome();
		chmodSync(home, 0o500);
		try {
			let id = "";
			expect(() => {
				id = loadOrCreateInstallId({ home, kind: "user" });
			}).not.toThrow();
			expect(id).toMatch(/^[0-9a-f-]{36}$/);
			// 写不进去就不落盘，但绝不能因此拒绝服务
			await expect(
				readFile(join(home, "telemetry", "install-id"), "utf8"),
			).rejects.toThrow();
		} finally {
			chmodSync(home, 0o700);
		}
	});

	it("returns the persisted UUID when the home is read-only", async () => {
		const home = await makeHome();
		const id = loadOrCreateInstallId({ home, kind: "user" });
		chmodSync(home, 0o500);
		try {
			expect(loadOrCreateInstallId({ home, kind: "user" })).toBe(id);
		} finally {
			chmodSync(home, 0o700);
		}
	});
});
