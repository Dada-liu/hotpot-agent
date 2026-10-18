import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	ApprovalChain,
	type ApprovalDecision,
	type ApprovalRequest,
} from "../src/approval/chain.ts";
import { editTool } from "../src/tools/edit.ts";
import { readTool } from "../src/tools/read.ts";
import type { ToolContext } from "../src/tools/tool.ts";
import { writeTool } from "../src/tools/write.ts";

// 全部读写落在临时目录内，保证测试 hermetic；approval 注入固定决策的 handler 并记录请求
let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "hotpot-fs-"));
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

function makeCtx(decision?: ApprovalDecision): {
	ctx: ToolContext;
	requests: ApprovalRequest[];
} {
	const requests: ApprovalRequest[] = [];
	const approval = new ApprovalChain();
	if (decision !== undefined) {
		approval.use(async (req) => {
			requests.push(req);
			return decision;
		});
	}
	return {
		ctx: {
			cwd: dir,
			signal: new AbortController().signal,
			approval,
			agentId: "main",
			session: {
				id: "fs-test-session",
				filePath: `${dir}/session.jsonl`,
				append: async () => {},
			},
		},
		requests,
	};
}

describe("readTool.execute", () => {
	it("读取小文件：content 带 1-based 行号，格式为 `行号\\t内容`", async () => {
		await writeFile(join(dir, "small.txt"), "alpha\nbeta\ngamma\n");
		const { ctx } = makeCtx();

		const out = await readTool.execute({ path: "small.txt" }, ctx);

		expect(out.isError).toBeFalsy();
		expect(out.content).toBe("1\talpha\n2\tbeta\n3\tgamma");
	});

	it("路径相对 ctx.cwd 解析", async () => {
		await mkdir(join(dir, "nested"), { recursive: true });
		await writeFile(join(dir, "nested", "rel.txt"), "hello\n");
		const { ctx } = makeCtx();

		const out = await readTool.execute({ path: "nested/rel.txt" }, ctx);

		expect(out.isError).toBeFalsy();
		expect(out.content).toBe("1\thello");
	});

	it("offset/limit 分页：offset 2、limit 2 返回第 2-3 行且行号正确", async () => {
		await writeFile(join(dir, "paged.txt"), "l1\nl2\nl3\nl4\nl5\n");
		const { ctx } = makeCtx();

		const out = await readTool.execute(
			{ path: "paged.txt", offset: 2, limit: 2 },
			ctx,
		);

		expect(out.isError).toBeFalsy();
		// 窗口之后还有内容时必须带截断提示与续读 offset
		expect(out.content).toBe(
			"2\tl2\n3\tl3\n[truncated: showing lines 2-3 of 5; call again with offset=4 to read more]",
		);
	});

	it("默认 limit 2000：2100 行文件截断到第 2000 行并提示用 offset 继续", async () => {
		const lines = Array.from({ length: 2100 }, (_, i) => `row${i + 1}`);
		await writeFile(join(dir, "big.txt"), `${lines.join("\n")}\n`);
		const { ctx } = makeCtx();

		const out = await readTool.execute({ path: "big.txt" }, ctx);

		expect(out.isError).toBeFalsy();
		expect(out.content).toContain("2000\trow2000");
		expect(out.content).not.toContain("row2001");
		expect(out.content).toContain("truncated");
		expect(out.content).toContain("offset");
	});

	it("含 NUL 字节的文件被拒绝：isError 且提示是二进制文件", async () => {
		await writeFile(join(dir, "bin.dat"), "ab\0cd");
		const { ctx } = makeCtx();

		const out = await readTool.execute({ path: "bin.dat" }, ctx);

		expect(out.isError).toBe(true);
		expect(out.content).toContain("binary");
	});

	it("文件不存在：isError 且不抛出", async () => {
		const { ctx } = makeCtx();

		const out = await readTool.execute({ path: "missing.txt" }, ctx);

		expect(out.isError).toBe(true);
	});

	it("offset 超出文件末尾：isError 并给出总行数", async () => {
		await writeFile(join(dir, "short.txt"), "only\nthree\nlines\n");
		const { ctx } = makeCtx();

		const out = await readTool.execute({ path: "short.txt", offset: 10 }, ctx);

		expect(out.isError).toBe(true);
		expect(out.content).toContain("3 lines");
	});

	it("isConcurrencySafe 为 true（只读，可并行）", () => {
		expect(readTool.isConcurrencySafe).toBe(true);
	});
});

describe("writeTool.execute", () => {
	it("写入新文件：父目录递归创建，不写 approval 请求", async () => {
		const { ctx, requests } = makeCtx("deny");

		const out = await writeTool.execute(
			{ path: "fresh/sub/new.txt", content: "hello world" },
			ctx,
		);

		expect(out.isError).toBeFalsy();
		expect(await readFile(join(dir, "fresh", "sub", "new.txt"), "utf8")).toBe(
			"hello world",
		);
		// 新文件不触发现有文件的覆盖审批，即使 approval 链会 deny
		expect(requests).toHaveLength(0);
	});

	it("目标已存在且审批 deny：不写、isError，approval 请求 kind 为 write 且 summary 含路径", async () => {
		await writeFile(join(dir, "exists.txt"), "old");
		const { ctx, requests } = makeCtx("deny");

		const out = await writeTool.execute(
			{ path: "exists.txt", content: "new" },
			ctx,
		);

		expect(out.isError).toBe(true);
		expect(out.content).toContain("denied");
		expect(await readFile(join(dir, "exists.txt"), "utf8")).toBe("old");
		expect(requests).toHaveLength(1);
		expect(requests[0].kind).toBe("write");
		expect(requests[0].summary).toContain("exists.txt");
	});

	it("目标已存在且审批 allow：覆盖成功", async () => {
		await writeFile(join(dir, "overwrite.txt"), "old");
		const { ctx, requests } = makeCtx("allow");

		const out = await writeTool.execute(
			{ path: "overwrite.txt", content: "new" },
			ctx,
		);

		expect(out.isError).toBeFalsy();
		expect(await readFile(join(dir, "overwrite.txt"), "utf8")).toBe("new");
		expect(requests).toHaveLength(1);
	});

	it("isConcurrencySafe 为 false（有副作用，同批串行）", () => {
		expect(writeTool.isConcurrencySafe).toBe(false);
	});
});

describe("editTool.execute", () => {
	it("唯一匹配：精确替换并写回", async () => {
		await writeFile(join(dir, "edit.txt"), "foo bar baz\n");
		const { ctx } = makeCtx();

		const out = await editTool.execute(
			{ path: "edit.txt", old_string: "bar", new_string: "qux" },
			ctx,
		);

		expect(out.isError).toBeFalsy();
		expect(await readFile(join(dir, "edit.txt"), "utf8")).toBe("foo qux baz\n");
	});

	it("old_string 出现 0 次：isError 提示未找到，并建议先 read", async () => {
		await writeFile(join(dir, "nomatch.txt"), "actual content\n");
		const { ctx } = makeCtx();

		const out = await editTool.execute(
			{ path: "nomatch.txt", old_string: "missing", new_string: "x" },
			ctx,
		);

		expect(out.isError).toBe(true);
		expect(out.content).toContain("not found");
		expect(out.content).toMatch(/read the file/i);
		// 未找到时不改动文件
		expect(await readFile(join(dir, "nomatch.txt"), "utf8")).toBe(
			"actual content\n",
		);
	});

	it("old_string 出现多次且无 replace_all：isError 提示不唯一并给出出现次数", async () => {
		await writeFile(join(dir, "dup.txt"), "a x b x c\n");
		const { ctx } = makeCtx();

		const out = await editTool.execute(
			{ path: "dup.txt", old_string: "x", new_string: "y" },
			ctx,
		);

		expect(out.isError).toBe(true);
		expect(out.content).toContain("2");
		expect(await readFile(join(dir, "dup.txt"), "utf8")).toBe("a x b x c\n");
	});

	it("replace_all=true：全部替换", async () => {
		await writeFile(join(dir, "all.txt"), "a x b x c\n");
		const { ctx } = makeCtx();

		const out = await editTool.execute(
			{ path: "all.txt", old_string: "x", new_string: "y", replace_all: true },
			ctx,
		);

		expect(out.isError).toBeFalsy();
		expect(await readFile(join(dir, "all.txt"), "utf8")).toBe("a y b y c\n");
	});

	it("CRLF 文件：old_string 含 \\r\\n 精确匹配，写回后未改动的行仍是 CRLF", async () => {
		await writeFile(join(dir, "crlf.txt"), "a\r\nb\r\nc\r\n");
		const { ctx } = makeCtx();

		const out = await editTool.execute(
			{ path: "crlf.txt", old_string: "a\r\nb", new_string: "x\r\ny" },
			ctx,
		);

		expect(out.isError).toBeFalsy();
		expect(await readFile(join(dir, "crlf.txt"), "utf8")).toBe(
			"x\r\ny\r\nc\r\n",
		);
	});

	it("new_string 含 $ 特殊模式（$$、$&、$`、$'）时逐字节写回，不做模式展开", async () => {
		// JS 的 string.replace 即使 pattern 是字符串，replacement 里的
		// $$、$&、$`、$' 仍会被展开；函数式 replacer 才不做任何模式解释
		await writeFile(join(dir, "dollar.txt"), "PREFIX SUFFIX\n");
		const { ctx } = makeCtx();
		const newString = "cost=$$, match=$&, before=$`, after=$'";

		const out = await editTool.execute(
			{ path: "dollar.txt", old_string: "PREFIX", new_string: newString },
			ctx,
		);

		expect(out.isError).toBeFalsy();
		expect(await readFile(join(dir, "dollar.txt"), "utf8")).toBe(
			`${newString} SUFFIX\n`,
		);
	});

	it("replace_all=true 时同样不解释 $ 模式", async () => {
		await writeFile(join(dir, "dollar-all.txt"), "x a x b x\n");
		const { ctx } = makeCtx();

		const out = await editTool.execute(
			{
				path: "dollar-all.txt",
				old_string: "x",
				new_string: "$$&$&",
				replace_all: true,
			},
			ctx,
		);

		expect(out.isError).toBeFalsy();
		expect(await readFile(join(dir, "dollar-all.txt"), "utf8")).toBe(
			"$$&$& a $$&$& b $$&$&\n",
		);
	});

	it("isConcurrencySafe 为 false（有副作用，同批串行）", () => {
		expect(editTool.isConcurrencySafe).toBe(false);
	});
});
