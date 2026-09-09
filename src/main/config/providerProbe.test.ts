import { describe, expect, it } from "vitest";
import {
	buildModelsRequest,
	buildTestRequest,
	connectionErrorMessage,
	extractHttpErrorDetail,
	googleModelPath,
	normalizeApiType,
	normalizeRequestHeaders,
	parseModelsResponse,
	parseTestResponse,
	redactDiagnostics,
	withAnthropicSdkUserAgent,
	withOpenAiSdkUserAgent,
} from "./providerProbe";

describe("normalizeApiType", () => {
	it("normalizes legacy aliases to pi registry names", () => {
		expect(normalizeApiType("anthropic")).toBe("anthropic-messages");
		expect(normalizeApiType("openai-chat-completions")).toBe("openai-completions");
		expect(normalizeApiType(undefined)).toBe("openai-completions");
		expect(normalizeApiType("google-generative-ai")).toBe("google-generative-ai");
	});
});

describe("buildModelsRequest", () => {
	it("emits primary only when ensureVersionPath already yields /v1/models", () => {
		const requests = buildModelsRequest("https://puppyrouter.com/v1", "sk-test", "openai-responses");
		expect(requests.map((r) => r.url)).toEqual(["https://puppyrouter.com/v1/models"]);
	});

	it("emits primary + fallback when baseUrl lacks a version path", () => {
		const requests = buildModelsRequest("https://puppyrouter.com", "sk-test", "openai-responses");
		expect(requests.map((r) => r.url)).toEqual([
			"https://puppyrouter.com/v1/models",
			"https://puppyrouter.com/models",
		]);
	});

	it("keeps the anthropic /models fallback for versioned baseUrls", () => {
		const requests = buildModelsRequest("https://x.test/v1", "k", "anthropic-messages");
		expect(requests.map((r) => r.url)).toEqual(["https://x.test/v1/models", "https://x.test/models"]);
	});

	it("injects SDK default UA and honors provider custom UA override", () => {
		const def = buildModelsRequest("https://puppyrouter.com/v1", "sk-test", "openai-responses");
		expect(def[0].headers["User-Agent"]).toBe("OpenAI/JS 6.26.0");
		const override = buildModelsRequest(
			"https://puppyrouter.com/v1",
			"sk-test",
			"openai-responses",
			{ "User-Agent": "PuppyRouter/1.0" },
		);
		expect(override[0].headers["User-Agent"]).toBe("PuppyRouter/1.0");
		expect(override[0].headers.Authorization).toBe("Bearer ***".replace("***", "sk-test"));
	});
});

describe("buildTestRequest", () => {
	it("builds minimal chat payloads per dialect", () => {
		const openai = buildTestRequest("https://x.test", "k", "m", "openai-completions");
		expect(openai.url).toBe("https://x.test/v1/chat/completions");
		expect(JSON.parse(openai.body).max_tokens).toBe(1);
		const gemini = buildTestRequest("https://x.test", "k", "m", "google-generative-ai");
		expect(gemini.url).toContain("generateContent?key=k");
	});
});

describe("parseModelsResponse", () => {
	it("reads data array and strips models/ prefix only for Gemini", () => {
		expect(parseModelsResponse({ data: [{ id: "a" }, { id: "" }] })).toEqual([{ id: "a", name: "a" }]);
		expect(
			parseModelsResponse({ data: [{ id: "models/gemini-2.0" }] }, "google-generative-ai"),
		).toEqual([{ id: "gemini-2.0", name: "gemini-2.0" }]);
	});
});

describe("parseTestResponse", () => {
	it("extracts openai chat snippet and tokens", () => {
		const parsed = parseTestResponse(
			{ model: "m", choices: [{ text: "hi" }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
			"fallback",
			"openai-completions",
		);
		expect(parsed).toEqual({ model: "m", snippet: "hi", tokens: { input: 1, output: 2 } });
	});

	it("falls back to empty-response copy when content is missing", () => {
		const parsed = parseTestResponse({}, "fallback", "anthropic-messages");
		expect(parsed.snippet).toBe("(空响应)");
		expect(parsed.model).toBe("fallback");
	});
});

describe("connectionErrorMessage", () => {
	it("selects the non-alarming timeout copy for AbortError", () => {
		const msg = connectionErrorMessage(Object.assign(new Error("x"), { name: "AbortError" }), 45);
		expect(msg).toContain("请求超时（45 秒）");
		expect(msg).toContain("不一定代表");
	});

	it("passes through non-abort errors and stringifies unknowns", () => {
		expect(connectionErrorMessage(new Error("boom"), 45)).toBe("boom");
		expect(connectionErrorMessage("plain", 45)).toBe("plain");
	});
});

describe("headers and redaction helpers", () => {
	it("normalizes headers and drops blanks", () => {
		expect(normalizeRequestHeaders({ " ": "x", ok: "1", bad: 2 as never })).toEqual({ ok: "1" });
	});
	it("injects Anthropic SDK UA only when missing", () => {
		const anthropic = withAnthropicSdkUserAgent({});
		expect(anthropic["User-Agent"]).toBe("anthropic-sdk-typescript/0.27.3");
		const openai = withOpenAiSdkUserAgent({ "user-agent": "custom" });
		expect(openai["user-agent"]).toBe("custom");
	});

	it("redacts the api key from diagnostics", () => {
		expect(redactDiagnostics("Bearer sk-test ok", "sk-test")).toBe("Bearer *** ok");
	});

	it("extracts HTTP error detail suffix", () => {
		expect(extractHttpErrorDetail({ error: { message: "blocked" } })).toBe(" — blocked");
		expect(extractHttpErrorDetail({})).toBe("");
	});

	it("prefixes bare gemini model ids", () => {
		expect(googleModelPath("gemini-2.0")).toBe("models/gemini-2.0");
		expect(googleModelPath("models/gemini-2.0")).toBe("models/gemini-2.0");
	});
});
