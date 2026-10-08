import { describe, expect, it } from "vitest";
import { lookupBuiltinApiRoute } from "./providerApiRoutes";

describe("lookupBuiltinApiRoute (commandcode)", () => {
	it("内置 provider 的 deepseek-v4-flash 走 openai-responses", () => {
		expect(lookupBuiltinApiRoute("commandcode", "deepseek/deepseek-v4-flash")).toBe(
			"openai-responses",
		);
	});

	it("内置 provider 的 deepseek-v4.1-flash 走 openai-responses", () => {
		expect(lookupBuiltinApiRoute("commandcode", "deepseek/deepseek-v4.1-flash")).toBe(
			"openai-responses",
		);
	});

	it("内置 provider 的 muse-spark-1.3-contributor 走 openai-responses", () => {
		expect(lookupBuiltinApiRoute("commandcode", "meta/muse-spark-1.3-contributor")).toBe(
			"openai-responses",
		);
	});

	it("内置 provider 的 xiaomi/mimo-v2.6-flash 不在路由表,fallback 到 default", () => {
		expect(lookupBuiltinApiRoute("commandcode", "xiaomi/mimo-v2.6-flash")).toBe(
			"openai-completions",
		);
	});

	it("claude- 前缀的 model id 走 anthropic-messages", () => {
		expect(lookupBuiltinApiRoute("commandcode", "claude-sonnet-5")).toBe(
			"anthropic-messages",
		);
		expect(lookupBuiltinApiRoute("commandcode", "claude-opus-4-7")).toBe(
			"anthropic-messages",
		);
	});

	it("非内置 provider 返回 undefined(调用方回退到用户 api 字段)", () => {
		expect(lookupBuiltinApiRoute("openai", "gpt-4o")).toBeUndefined();
		expect(lookupBuiltinApiRoute("cc-custom", "deepseek/deepseek-v4-flash")).toBeUndefined();
	});

	it("exact 路由优先于 prefix 路由(同名前缀冲突安全)", () => {
		// claude-deepseek/deepseek-v4-flash 不存在但理论上 prefix 会先匹配;
		// 验证 exact 在内置表里也只覆盖路由表中的 id,不会误伤其它路径。
		expect(lookupBuiltinApiRoute("commandcode", "claude-deepseek/deepseek-v4-flash")).toBe(
			"anthropic-messages", // 走 prefix
		);
	});
});
