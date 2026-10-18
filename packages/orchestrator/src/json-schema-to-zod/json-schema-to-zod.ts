// JSON Schema → zod 子集转换（M4 Feature⑦ MCP 桥接用）。
// 只支持 MCP 工具 inputSchema 的常见子集：object/properties/required、enum、
// string/number/integer/boolean、array/items；additionalProperties 忽略
// （zod object 缺省 strip 未知键，不拒绝，语义等价「不额外约束」）。
// 「不拦」原则：遇到不支持的结构性关键字（anyOf/oneOf/allOf/$ref/not）或未知
// type 一律回退 z.unknown() 放行任意输入——声明层尽量保真，转换不了就把校验
// 交还 MCP server，桥接层绝不把合法调用拦死。zod v4 的 z.enum 对空数组与非
// 字符串成员会产出 never schema（实测），enum 分支做了守卫。

import { z } from "zod";

type JsonSchemaObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonSchemaObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonSchemaToZod(schema: unknown): z.ZodType<unknown> {
	if (!isObject(schema)) {
		return z.unknown();
	}
	// 结构性关键字超出子集：整体回退（不逐字段降级，半套约束会误导模型）
	if (
		"$ref" in schema ||
		"anyOf" in schema ||
		"oneOf" in schema ||
		"allOf" in schema ||
		"not" in schema
	) {
		return z.unknown();
	}
	// enum 可独立于 type 出现；成员必须全是非空字符串，否则回退
	if ("enum" in schema) {
		return enumToZod(schema.enum);
	}
	const type = schema.type;
	if (type === undefined) {
		// 部分 server 省略 type: "object" 只给 properties：按对象处理，否则回退
		return "properties" in schema ? objectToZod(schema) : z.unknown();
	}
	switch (type) {
		case "string":
			return z.string();
		case "number":
			return z.number();
		case "integer":
			return z.number().int();
		case "boolean":
			return z.boolean();
		case "array":
			return arrayToZod(schema);
		case "object":
			return objectToZod(schema);
		default:
			return z.unknown();
	}
}

function enumToZod(values: unknown): z.ZodType<unknown> {
	if (
		!Array.isArray(values) ||
		values.length === 0 ||
		!values.every((v) => typeof v === "string" && v.length > 0)
	) {
		return z.unknown();
	}
	return z.enum(values as [string, ...string[]]);
}

function arrayToZod(schema: JsonSchemaObject): z.ZodType<unknown> {
	// items 缺失或非对象：元素放行任意值
	if (!isObject(schema.items)) {
		return z.array(z.unknown());
	}
	return z.array(jsonSchemaToZod(schema.items));
}

function objectToZod(schema: JsonSchemaObject): z.ZodType<unknown> {
	const properties = schema.properties;
	if (!isObject(properties)) {
		// 无 properties 的对象：passthrough 保住入参（strip 会丢键）
		return z.object({}).passthrough();
	}
	const required = Array.isArray(schema.required)
		? new Set(schema.required.filter((v) => typeof v === "string"))
		: new Set<string>();
	const shape: Record<string, z.ZodType<unknown>> = {};
	for (const [key, propSchema] of Object.entries(properties)) {
		const field = jsonSchemaToZod(propSchema);
		shape[key] = required.has(key) ? field : field.optional();
	}
	return z.object(shape);
}
