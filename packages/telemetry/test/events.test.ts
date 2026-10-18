import { describe, expect, it } from "vitest";
import { telemetryBatchSchema } from "../src/events.ts";

const base = {
	schemaVersion: 1 as const,
	kind: "user" as const,
	appVersion: "0.0.0",
	installId: "00000000-0000-4000-8000-000000000000",
	events: [],
};

describe("telemetryBatchSchema", () => {
	it("accepts a minimal batch", () => {
		expect(telemetryBatchSchema.parse(base)).toEqual(base);
	});

	it("rejects unknown envelope fields", () => {
		expect(() => telemetryBatchSchema.parse({ ...base, extra: 1 })).toThrow();
	});

	it("rejects an unknown event type", () => {
		expect(() =>
			telemetryBatchSchema.parse({
				...base,
				events: [
					{ eventId: "e1", ts: "2026-01-01T00:00:00.000Z", type: "nope" },
				],
			}),
		).toThrow();
	});

	it("rejects more than 500 events", () => {
		expect(() =>
			telemetryBatchSchema.parse({
				...base,
				events: Array.from({ length: 501 }, (_, i) => ({
					eventId: `e${i}`,
					ts: "2026-01-01T00:00:00.000Z",
					type: "session_end",
					sessionId: "s",
					durationMs: 1,
					turns: 0,
					errors: 0,
				})),
			}),
		).toThrow();
	});
});
