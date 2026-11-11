// doctor 的价值在于「十秒内说清能不能跑」，所以测试重点：
// 该 fail 的必须 fail 并给出修复命令；离线模式不能偷偷联网；
// 报告渲染要能直接贴进 issue。
//
// 外部探针全部注入假实现，测试不 exec docker/python/ssh、不联网。

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "@hotpot/core";
import { describe, expect, it } from "vitest";
import {
	type DoctorCheck,
	type DoctorDeps,
	type DoctorReport,
	formatDoctorReport,
	runDoctor,
} from "../src/doctor.ts";

function makeSettings(overrides: { apiKey?: string } = {}): Settings {
	const model = (tier: string) => ({
		provider: "test",
		model: `test-${tier}`,
		apiKey: overrides.apiKey ?? "test-key",
	});
	return {
		mainAgentTier: "high",
		models: {
			high: model("high"),
			medium: model("medium"),
			low: model("low"),
		},
		telemetry: { enabled: true, endpoint: "http://127.0.0.1:9/telemetry" },
	} as unknown as Settings;
}

interface ProbeCall {
	command: string;
	args: string[];
}

function makeDeps(
	override: Partial<DoctorDeps> & { calls?: ProbeCall[] } = {},
): DoctorDeps {
	const calls = override.calls ?? [];
	return {
		runCommand: (command, args) => {
			calls.push({ command, args: [...args] });
			// df：第二行第 4 列是可用 KB（1 TB）
			if (command === "df") {
				return Promise.resolve({
					code: 0,
					stdout:
						"Filesystem 1024-blocks Used Available Capacity\n/dev/disk1 100 1 1000000000 1%\n",
					stderr: "",
					timedOut: false,
				});
			}
			return Promise.resolve({
				code: 0,
				stdout: "ok",
				stderr: "",
				timedOut: false,
			});
		},
		fetchImpl: () => Promise.resolve(new Response(null, { status: 200 })),
		collectFacts: () =>
			Promise.resolve({
				packageVersion: "0.0.0-test",
				git: { commit: "deadbeefdeadbeef", dirty: false },
				node: "v22.0.0",
				platform: "test",
			}),
		...override,
	};
}

async function makeInstancesFile(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "bench-doctor-"));
	const file = join(dir, "instances.jsonl");
	await writeFile(
		file,
		`${JSON.stringify({
			instance_id: "django__django-11099",
			repo: "django/django",
			base_commit: "abc",
			problem_statement: "fix it",
			FAIL_TO_PASS: ["t"],
			PASS_TO_PASS: [],
			version: "1",
		})}\n`,
	);
	return file;
}

describe("runDoctor", () => {
	it("离线模式不联网，且覆盖本地条件", async () => {
		const instancesFile = await makeInstancesFile();
		const outputDir = await mkdtemp(join(tmpdir(), "bench-doctor-out-"));
		const calls: ProbeCall[] = [];
		let fetched = 0;
		const report = await runDoctor(
			{
				cwd: process.cwd(),
				settings: makeSettings(),
				modelTier: "high",
				instancesFile,
				evalMode: "local",
				evalHost: "unused",
				outputDir,
				checkNetwork: false,
			},
			makeDeps({
				calls,
				fetchImpl: () => {
					fetched += 1;
					return Promise.resolve(new Response(null, { status: 200 }));
				},
			}),
		);
		const names = report.checks.map((check) => check.name);
		expect(names).toContain("model tier high");
		expect(names).toContain("instances");
		expect(names).toContain("output dir");
		expect(names).toContain("disk");
		expect(names).toContain("swebench harness");
		expect(names).toContain("docker");
		expect(names).not.toContain("hf endpoint");
		expect(fetched).toBe(0);
		expect(report.checks.find((c) => c.name === "instances")?.status).toBe(
			"ok",
		);
		expect(report.checks.find((c) => c.name === "disk")?.detail).toContain(
			"953.7 GB",
		);
		expect(calls.map((call) => call.command)).toEqual([
			"df",
			"python3",
			"docker",
		]);
	});

	it("缺 docker 时 fail，并给出可直接执行的修复命令", async () => {
		const instancesFile = await makeInstancesFile();
		const outputDir = await mkdtemp(join(tmpdir(), "bench-doctor-out-"));
		const report = await runDoctor(
			{
				cwd: process.cwd(),
				settings: makeSettings(),
				modelTier: "high",
				instancesFile,
				evalMode: "local",
				evalHost: "unused",
				outputDir,
				checkNetwork: false,
			},
			makeDeps({
				runCommand: (command) => {
					if (command === "docker") {
						return Promise.resolve({
							code: 1,
							stdout: "",
							stderr: "Cannot connect to the Docker daemon",
							timedOut: false,
						});
					}
					if (command === "df") {
						return Promise.resolve({
							code: 0,
							stdout:
								"Filesystem 1024-blocks Used Available Capacity\n/dev/disk1 100 1 1000000000 1%\n",
							stderr: "",
							timedOut: false,
						});
					}
					return Promise.resolve({
						code: 0,
						stdout: "ok",
						stderr: "",
						timedOut: false,
					});
				},
			}),
		);
		const docker = report.checks.find((c) => c.name === "docker");
		expect(docker?.status).toBe("fail");
		expect(docker?.fix).toContain("Docker Desktop");
		expect(report.failed).toBe(1);
	});

	it("apiKey 指向未设置的环境变量时直接 fail，并给出 export 命令", async () => {
		const instancesFile = await makeInstancesFile();
		const outputDir = await mkdtemp(join(tmpdir(), "bench-doctor-out-"));
		const report = await runDoctor(
			{
				cwd: process.cwd(),
				settings: makeSettings({ apiKey: "$BENCH_TEST_MISSING_KEY" }),
				modelTier: "high",
				instancesFile,
				evalMode: "local",
				evalHost: "unused",
				outputDir,
				checkNetwork: false,
			},
			makeDeps(),
		);
		const tier = report.checks.find((c) => c.name === "model tier high");
		expect(tier?.status).toBe("fail");
		expect(tier?.fix).toContain("BENCH_TEST_MISSING_KEY");
	});

	it("题目文件不存在时 fail 并指向导出脚本", async () => {
		const outputDir = await mkdtemp(join(tmpdir(), "bench-doctor-out-"));
		const report = await runDoctor(
			{
				cwd: process.cwd(),
				settings: makeSettings(),
				modelTier: "high",
				instancesFile: join(outputDir, "nope.jsonl"),
				evalMode: "local",
				evalHost: "unused",
				outputDir,
				checkNetwork: false,
			},
			makeDeps(),
		);
		const instances = report.checks.find((c) => c.name === "instances");
		expect(instances?.status).toBe("fail");
		expect(instances?.fix).toContain("export_instances.py");
	});

	it("远端模式检查 ssh 与 tmux，缺 tmux 只提醒", async () => {
		const instancesFile = await makeInstancesFile();
		const outputDir = await mkdtemp(join(tmpdir(), "bench-doctor-out-"));
		const report = await runDoctor(
			{
				cwd: process.cwd(),
				settings: makeSettings(),
				modelTier: "high",
				instancesFile,
				evalMode: "remote",
				evalHost: "macmini",
				outputDir,
				checkNetwork: false,
			},
			makeDeps({
				runCommand: (command, args) => {
					if (command === "df") {
						return Promise.resolve({
							code: 0,
							stdout:
								"Filesystem 1024-blocks Used Available Capacity\n/dev/disk1 100 1 1000000000 1%\n",
							stderr: "",
							timedOut: false,
						});
					}
					const isTmuxProbe = args.includes("command -v tmux || true");
					return Promise.resolve({
						code: 0,
						stdout: isTmuxProbe ? "" : "ok",
						stderr: "",
						timedOut: false,
					});
				},
			}),
		);
		expect(report.checks.find((c) => c.name === "ssh macmini")?.status).toBe(
			"ok",
		);
		expect(
			report.checks.find((c) => c.name === "tmux on macmini")?.status,
		).toBe("warn");
		expect(report.checks.map((c) => c.name)).not.toContain("docker");
	});

	it("遥测 endpoint 不可达只提醒，不阻塞跑批", async () => {
		const instancesFile = await makeInstancesFile();
		const outputDir = await mkdtemp(join(tmpdir(), "bench-doctor-out-"));
		const report = await runDoctor(
			{
				cwd: process.cwd(),
				settings: makeSettings(),
				modelTier: "high",
				instancesFile,
				evalMode: "remote",
				evalHost: "macmini",
				outputDir,
				checkNetwork: true,
			},
			makeDeps({
				fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
			}),
		);
		const telemetry = report.checks.find((c) => c.name === "telemetry");
		expect(telemetry?.status).toBe("warn");
		expect(telemetry?.detail).toContain("ECONNREFUSED");
	});
});

describe("formatDoctorReport", () => {
	const report: DoctorReport = {
		checks: [
			{ name: "model tier high", status: "ok", detail: "test/test-high" },
			{
				name: "docker",
				status: "fail",
				detail: "docker daemon 不可用",
				fix: "启动 Docker Desktop",
			},
		] satisfies DoctorCheck[],
		failed: 1,
		warned: 0,
	};

	it("渲染状态、修复建议与结论行", () => {
		const text = formatDoctorReport(report);
		expect(text).toContain("[ok] model tier high: test/test-high");
		expect(text).toContain("fix: 启动 Docker Desktop");
		expect(text).toContain("1 项必须修复后才能跑");
	});

	it("全部通过时不出现「必须修复」", () => {
		const text = formatDoctorReport({ checks: [], failed: 0, warned: 2 });
		expect(text).not.toContain("必须修复");
		expect(text).toContain("2 项提醒");
	});
});
