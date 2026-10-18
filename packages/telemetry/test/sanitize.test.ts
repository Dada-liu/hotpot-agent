import { describe, expect, it } from "vitest";
import { sanitizeErrorMessage } from "../src/sanitize.ts";

describe("sanitizeErrorMessage", () => {
	it("replaces absolute paths", () => {
		expect(sanitizeErrorMessage("ENOENT: open /Users/alice/project/a.ts")).toBe(
			"ENOENT: open <path>",
		);
		expect(sanitizeErrorMessage("cannot read /home/alice/a.ts")).toBe(
			"cannot read <path>",
		);
	});
	it("strips URL query and fragment", () => {
		expect(
			sanitizeErrorMessage(
				"GET https://example.com/x?token=secret#frag failed",
			),
		).toBe("GET https://example.com/x failed");
	});
	it("replaces emails", () => {
		expect(sanitizeErrorMessage("contact a@b.com")).toBe("contact <email>");
	});
	it("replaces paths carried in non-web scheme URLs", () => {
		const vscode = sanitizeErrorMessage("vscode://file/Users/alice/secret.ts");
		expect(vscode).not.toContain("/Users/alice");
		expect(vscode).toBe("<path>");

		const custom = sanitizeErrorMessage("error:///Users/alice/secret.ts");
		expect(custom).not.toContain("/Users/alice");
		expect(custom).toBe("<path>");
	});
	it("removes code blocks", () => {
		expect(sanitizeErrorMessage("boom\n```ts\nsecret()\n```")).toContain(
			"<code>",
		);
		expect(sanitizeErrorMessage("boom\n```ts\nsecret()\n```")).not.toContain(
			"secret",
		);
	});
	it("caps the message", () => {
		expect(sanitizeErrorMessage("x".repeat(600)).length).toBe(500);
	});
});
