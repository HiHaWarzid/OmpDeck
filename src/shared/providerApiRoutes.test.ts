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

describe("lookupBuiltinApiRoute (opencode-go)", () => {
	// 参考 https://opencode.ai/docs/go Endpoints 表。
	// 三种端点形态按 model id 区分：chat-completions 默认，responses / anthropic-messages 命中后走对应路由。

	it("默认走 openai-completions(deepseek-v4.1-flash 在 Go 上仍为 chat completions)", () => {
		expect(lookupBuiltinApiRoute("opencode-go", "deepseek-v4.1-flash")).toBe(
			"openai-completions",
		);
	});

	it("grok / gpt-6 / gpt-5.6 / muse-spark-* 走 openai-responses", () => {
		expect(lookupBuiltinApiRoute("opencode-go", "grok-4.7")).toBe("openai-responses");
		expect(lookupBuiltinApiRoute("opencode-go", "grok-4.6")).toBe("openai-responses");
		expect(lookupBuiltinApiRoute("opencode-go", "gpt-6-luna")).toBe("openai-responses");
		expect(lookupBuiltinApiRoute("opencode-go", "gpt-5.6-luna")).toBe("openai-responses");
		expect(lookupBuiltinApiRoute("opencode-go", "muse-spark-1.3-contributor")).toBe(
			"openai-responses",
		);
	});

	it("claude-haiku / minimax-* / qwen3.8 / qwen3.7 走 anthropic-messages", () => {
		expect(lookupBuiltinApiRoute("opencode-go", "claude-haiku-5-5")).toBe(
			"anthropic-messages",
		);
		expect(lookupBuiltinApiRoute("opencode-go", "minimax-m3")).toBe("anthropic-messages");
		expect(lookupBuiltinApiRoute("opencode-go", "minimax-m2.7")).toBe(
			"anthropic-messages",
		);
		expect(lookupBuiltinApiRoute("opencode-go", "qwen3.8-max")).toBe(
			"anthropic-messages",
		);
		expect(lookupBuiltinApiRoute("opencode-go", "qwen3.7-plus")).toBe(
			"anthropic-messages",
		);
	});

	it("其余未列出的模型回退到默认 openai-completions", () => {
		expect(lookupBuiltinApiRoute("opencode-go", "kimi-k3")).toBe(
			"openai-completions",
		);
		expect(lookupBuiltinApiRoute("opencode-go", "longcat-2.0")).toBe(
			"openai-completions",
		);
		expect(lookupBuiltinApiRoute("opencode-go", "mimo-v2.6-flash")).toBe(
			"openai-completions",
		);
	});

	it("非 opencode-go provider 返回 undefined（调用方回退到用户 api 字段）", () => {
		expect(lookupBuiltinApiRoute("opencode", "deepseek-v4.1-flash")).toBeUndefined();
		expect(lookupBuiltinApiRoute("anthropic", "claude-haiku-5-5")).toBeUndefined();
	});
});
