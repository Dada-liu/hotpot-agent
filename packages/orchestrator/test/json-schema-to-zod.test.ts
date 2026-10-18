// jsonSchemaToZod 子集转换测试：
// - 基本类型（string/number/integer/boolean）与对象（properties/required/嵌套）
// - enum 合法/空数组/非字符串成员（zod v4 会产 never schema，必须守卫回退 unknown）
// - array/items（含 items 缺失与嵌套不支持的元素）
// - 结构性回退：anyOf/oneOf/allOf/$ref/not、未知 type、非对象 schema → z.unknown() 放行
// - 「不拦」原则：回退结果对任意输入 parse 成功，绝不把合法调用拦死

import { describe, expect, it } from "vitest";
import { jsonSchemaToZod } from "../src/json-schema-to-zod.ts";

describe("jsonSchemaToZod 基本类型", () => {
	it("string/number/integer/boolean 各自校验类型", () => {
		expect(jsonSchemaToZod({ type: "string" }).safeParse("a").success).toBe(
			true,
		);
		expect(jsonSchemaToZod({ type: "string" }).safeParse(1).success).toBe(
			false,
		);
		expect(jsonSchemaToZod({ type: "number" }).safeParse(1.5).success).toBe(
			true,
		);
		expect(jsonSchemaToZod({ type: "number" }).safeParse("1").success).toBe(
			false,
		);
		// integer 拒绝小数
		expect(jsonSchemaToZod({ type: "integer" }).safeParse(1).success).toBe(
			true,
		);
		expect(jsonSchemaToZod({ type: "integer" }).safeParse(1.5).success).toBe(
			false,
		);
		expect(jsonSchemaToZod({ type: "boolean" }).safeParse(true).success).toBe(
			true,
		);
		expect(jsonSchemaToZod({ type: "boolean" }).safeParse(0).success).toBe(
			false,
		);
	});

	it("enum 字符串成员收敛取值，非成员拒绝", () => {
		const schema = jsonSchemaToZod({ type: "string", enum: ["a", "b"] });
		expect(schema.safeParse("a").success).toBe(true);
		expect(schema.safeParse("c").success).toBe(false);
	});

	it("独立 enum（无 type）同样生效", () => {
		const schema = jsonSchemaToZod({ enum: ["x", "y"] });
		expect(schema.safeParse("x").success).toBe(true);
		expect(schema.safeParse("z").success).toBe(false);
	});
});

describe("jsonSchemaToZod 对象与数组", () => {
	it("properties/required：必填缺失拒绝，可选缺失放行", () => {
		const schema = jsonSchemaToZod({
			type: "object",
			properties: {
				name: { type: "string" },
				count: { type: "integer" },
			},
			required: ["name"],
		});
		expect(schema.safeParse({ name: "n" }).success).toBe(true);
		expect(schema.safeParse({ name: "n", count: 1 }).success).toBe(true);
		expect(schema.safeParse({ count: 1 }).success).toBe(false);
		expect(schema.safeParse({ name: 1 }).success).toBe(false);
	});

	it("嵌套对象与数组按子集递归转换", () => {
		const schema = jsonSchemaToZod({
			type: "object",
			properties: {
				items: {
					type: "array",
					items: {
						type: "object",
						properties: { id: { type: "integer" } },
						required: ["id"],
					},
				},
			},
			required: ["items"],
		});
		expect(schema.safeParse({ items: [{ id: 1 }] }).success).toBe(true);
		expect(schema.safeParse({ items: [{}] }).success).toBe(false);
		expect(schema.safeParse({ items: "x" }).success).toBe(false);
	});

	it("array 无 items：元素放行任意值", () => {
		const schema = jsonSchemaToZod({ type: "array" });
		expect(schema.safeParse([1, "a", {}]).success).toBe(true);
		expect(schema.safeParse("not-array").success).toBe(false);
	});

	it("object 无 properties：任意对象放行（passthrough 不丢键）", () => {
		const schema = jsonSchemaToZod({ type: "object" });
		const parsed = schema.parse({ anything: 1 });
		expect(parsed).toEqual({ anything: 1 });
	});

	it("缺 type 但有 properties：仍按对象处理", () => {
		const schema = jsonSchemaToZod({
			properties: { a: { type: "string" } },
			required: ["a"],
		});
		expect(schema.safeParse({ a: "x" }).success).toBe(true);
		expect(schema.safeParse({}).success).toBe(false);
	});
});

describe("jsonSchemaToZod 结构性回退（不拦原则）", () => {
	it("anyOf/oneOf/allOf/$ref/not 回退 z.unknown()：任意输入放行", () => {
		for (const unsupported of [
			{ anyOf: [{ type: "string" }, { type: "number" }] },
			{ oneOf: [{ type: "string" }, { type: "number" }] },
			{ allOf: [{ type: "string" }] },
			{ $ref: "#/definitions/Foo" },
			{ not: { type: "string" } },
		]) {
			const schema = jsonSchemaToZod(unsupported);
			expect(schema.safeParse("anything").success).toBe(true);
			expect(schema.safeParse(42).success).toBe(true);
		}
	});

	it("未知 type 回退 z.unknown()", () => {
		const schema = jsonSchemaToZod({ type: "null" });
		expect(schema.safeParse(null).success).toBe(true);
		expect(schema.safeParse("x").success).toBe(true);
	});

	it("非对象 schema（null/字符串/数组）回退 z.unknown()", () => {
		for (const junk of [null, "string-schema", [1, 2], 42]) {
			const schema = jsonSchemaToZod(junk);
			expect(schema.safeParse({ any: "thing" }).success).toBe(true);
		}
	});

	it("enum 空数组/非字符串成员回退 z.unknown()（zod v4 裸用会产 never）", () => {
		for (const badEnum of [[], ["a", 1], [1, 2], [""]]) {
			const schema = jsonSchemaToZod({ type: "string", enum: badEnum });
			expect(schema.safeParse("anything").success).toBe(true);
			expect(schema.safeParse(42).success).toBe(true);
		}
	});

	it("对象内某字段不支持：该字段放行，其余字段仍按子集校验", () => {
		const schema = jsonSchemaToZod({
			type: "object",
			properties: {
				filter: { anyOf: [{ type: "string" }, { type: "number" }] },
				limit: { type: "integer" },
			},
			required: ["filter", "limit"],
		});
		// filter 回退 unknown 放行任意值；limit 仍校验 integer
		expect(schema.safeParse({ filter: { complex: 1 }, limit: 5 }).success).toBe(
			true,
		);
		expect(schema.safeParse({ filter: "x", limit: "5" }).success).toBe(false);
	});
});
