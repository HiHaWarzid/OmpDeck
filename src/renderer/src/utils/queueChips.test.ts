import { describe, expect, it } from "vitest";
import { buildQueueRows } from "./queueChips";

describe("buildQueueRows", () => {
	it("按 steering → followUp 顺序拼接，保留各自顺序", () => {
		const rows = buildQueueRows(
			{ steering: ["steer A", "steer B"], followUp: ["follow"] },
			undefined,
		);
		expect(rows.map((row) => [row.kind, row.text])).toEqual([
			["queued", "steer A"],
			["queued", "steer B"],
			["queued", "follow"],
		]);
		expect(rows[2]).toMatchObject({ kind: "queued", queue: "followUp" });
	});

	it("缺省队列视为空，未知投递提示排在最后", () => {
		const rows = buildQueueRows(undefined, [
			{ id: "u1", text: "maybe delivered", error: "IPC 断开" },
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "uncertain",
			text: "maybe delivered",
			error: "IPC 断开",
		});
	});

	it("重复文本不会产生重复 key", () => {
		const rows = buildQueueRows({ steering: ["same", "same"], followUp: [] });
		expect(new Set(rows.map((row) => row.key)).size).toBe(2);
	});
});
