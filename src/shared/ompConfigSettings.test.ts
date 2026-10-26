import { describe, expect, it } from "vitest";
import {
	diffOmpSettings,
	ompSettingsPatchFromPackage,
	pickOmpSettings,
	readOmpPath,
	readShowThinkingSetting,
	setEnabledModelSelected,
	writeOmpPath,
} from "./ompConfigSettings";

describe("readOmpPath", () => {
	it("walks nested keys and returns undefined for missing paths", () => {
		const root = { retry: { maxRetries: 0 }, enabledModels: [] };
		expect(readOmpPath(root, "retry.maxRetries")).toBe(0);
		expect(readOmpPath(root, "retry.baseDelayMs")).toBeUndefined();
		expect(readOmpPath(root, "retry.maxRetries.deep")).toBeUndefined();
		// 数组 / 标量不可穿越，不能抛错
		expect(readOmpPath(root, "enabledModels.0")).toBeUndefined();
	});
});

describe("writeOmpPath", () => {
	it("writes and removes without mutating the source draft", () => {
		const root = { retry: { maxRetries: 3 }, keep: true };
		const written = writeOmpPath(root, "retry.baseDelayMs", 500);
		expect(written).toEqual({ retry: { maxRetries: 3, baseDelayMs: 500 }, keep: true });
		expect(root).toEqual({ retry: { maxRetries: 3 }, keep: true });

		const removed = writeOmpPath(written, "retry.baseDelayMs", undefined);
		expect(removed).toEqual(root);
		expect(root).toEqual({ retry: { maxRetries: 3 }, keep: true });
	});

	it("prunes parents emptied by a removal and replaces non-mapping nodes", () => {
		expect(writeOmpPath({ retry: { maxRetries: 3 } }, "retry.maxRetries", undefined)).toEqual(
			{},
		);
		expect(writeOmpPath({ retry: 1 }, "retry.maxRetries", 3)).toEqual({
			retry: { maxRetries: 3 },
		});
	});
});

describe("readShowThinkingSetting", () => {
	it("maps hideThinkingBlock to the desktop showThinking flag", () => {
		expect(readShowThinkingSetting({ hideThinkingBlock: true })).toBe(false);
		expect(readShowThinkingSetting({ hideThinkingBlock: false })).toBe(true);
		expect(readShowThinkingSetting({})).toBeUndefined();
		expect(readShowThinkingSetting({ hideThinkingBlock: "true" })).toBeUndefined();
	});
});

describe("setEnabledModelSelected", () => {
	it("keeps path-scoped entries instead of rebuilding the list from ids", () => {
		const scoped = { path: "packages/api", models: ["openai/gpt-4o"] };
		const baseline = { enabledModels: [scoped, "anthropic/claude-sonnet-4-5"] };

		const removed = setEnabledModelSelected(
			baseline.enabledModels,
			"anthropic/claude-sonnet-4-5",
			false,
		);
		expect(removed).toEqual([scoped]);
		expect(diffOmpSettings(baseline, { enabledModels: removed })).toEqual({
			set: [{ path: "enabledModels", value: [scoped] }],
			unset: [],
		});

		const added = setEnabledModelSelected(baseline.enabledModels, "google/gemini-2.5-pro", true);
		expect(added).toEqual([scoped, "anthropic/claude-sonnet-4-5", "google/gemini-2.5-pro"]);
	});
});

describe("diffOmpSettings", () => {
	it("returns an empty patch when nothing changed", () => {
		const baseline = {
			enabledModels: ["a/b"],
			retry: { maxRetries: 3 },
			compaction: { enabled: true },
			modelRoles: { default: "x/y" },
		};
		expect(diffOmpSettings(baseline, structuredClone(baseline))).toEqual({ set: [], unset: [] });
	});

	it("only reports editable keys that changed", () => {
		const patch = diffOmpSettings(
			{
				enabledModels: ["a/b"],
				retry: { maxRetries: 3, baseDelayMs: 500 },
				modelRoles: { default: "x/y" },
			},
			{
				enabledModels: ["a/b", "c/d"],
				retry: { maxRetries: 3, baseDelayMs: 900 },
				// 非可编辑键即使变了也不提交
				modelRoles: { default: "z/w" },
			},
		);
		expect(patch.set).toEqual([
			{ path: "enabledModels", value: ["a/b", "c/d"] },
			{ path: "retry.baseDelayMs", value: 900 },
		]);
		expect(patch.unset).toEqual([]);
	});

	it("treats a removed key as unset and a removed sub-tree as per-key unsets", () => {
		const patch = diffOmpSettings(
			{
				compaction: { enabled: false, reserveTokens: 8192, keepRecentTokens: 25000 },
			},
			{},
		);
		expect(patch.set).toEqual([]);
		expect(patch.unset).toEqual([
			"compaction.enabled",
			"compaction.reserveTokens",
			"compaction.keepRecentTokens",
		]);
	});

	it("does not equate distinct types or numbers", () => {
		const patch = diffOmpSettings(
			{ compaction: { enabled: true }, retry: { maxRetries: 3 } },
			{ compaction: { enabled: 1 }, retry: { maxRetries: 4 } },
		);
		expect(patch.set).toEqual([
			{ path: "retry.maxRetries", value: 4 },
			{ path: "compaction.enabled", value: 1 },
		]);
	});
});

describe("export/import projection", () => {
	it("pickOmpSettings keeps nested shape and drops non-editable keys", () => {
		const picked = pickOmpSettings({
			enabledModels: ["a/b"],
			retry: { maxRetries: 5, jitter: true },
			auth: { broker: { token: "secret" } },
		});
		expect(picked).toEqual({ enabledModels: ["a/b"], retry: { maxRetries: 5 } });
	});

	it("ompSettingsPatchFromPackage only sets keys present in the package", () => {
		const patch = ompSettingsPatchFromPackage({
			compaction: { keepRecentTokens: 1234 },
			auth: { broker: { token: "secret" } },
		});
		expect(patch).toEqual({ set: [{ path: "compaction.keepRecentTokens", value: 1234 }] });
	});
});
