import assert from "node:assert/strict";
import test from "node:test";
import {
	extractVersionedBaseFromRequestUrl,
	hasApiVersionPath,
	needsSessionBaseUrlVersionHint,
	suggestNormalizedBaseUrl,
} from "../src/main/config/baseUrlPath.ts";

test("hasApiVersionPath detects /v1 /v1beta /api", () => {
	assert.equal(hasApiVersionPath("https://api.openai.com/v1"), true);
	assert.equal(hasApiVersionPath("https://api.openai.com/v1/"), true);
	assert.equal(hasApiVersionPath("https://generativelanguage.googleapis.com/v1beta"), true);
	assert.equal(hasApiVersionPath("http://localhost:11434/api"), true);
	assert.equal(hasApiVersionPath("https://proxy.example.com"), false);
	assert.equal(hasApiVersionPath("https://proxy.example.com/openai"), false);
});

test("extractVersionedBaseFromRequestUrl strips endpoint suffix", () => {
	assert.equal(
		extractVersionedBaseFromRequestUrl("https://api.openai.com/v1/chat/completions"),
		"https://api.openai.com/v1",
	);
	assert.equal(
		extractVersionedBaseFromRequestUrl("https://host.example/proxy/v1/models"),
		"https://host.example/proxy/v1",
	);
	assert.equal(
		extractVersionedBaseFromRequestUrl(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent?key=x",
		),
		"https://generativelanguage.googleapis.com/v1beta",
	);
	assert.equal(
		extractVersionedBaseFromRequestUrl("https://host.example/models"),
		null,
	);
});

test("only rewrite when versioned path actually worked", () => {
	// 根路径 /models 成功 → 不改写
	assert.equal(
		needsSessionBaseUrlVersionHint("https://proxy.example.com", "https://proxy.example.com/models"),
		false,
	);
	assert.equal(
		suggestNormalizedBaseUrl("https://proxy.example.com", "https://proxy.example.com/models"),
		null,
	);

	// /v1 成功 → 自动补 /v1
	assert.equal(
		needsSessionBaseUrlVersionHint(
			"https://proxy.example.com",
			"https://proxy.example.com/v1/chat/completions",
		),
		true,
	);
	assert.equal(
		suggestNormalizedBaseUrl(
			"https://proxy.example.com",
			"https://proxy.example.com/v1/chat/completions",
		),
		"https://proxy.example.com/v1",
	);

	// 已有 /v1 → 不改
	assert.equal(
		suggestNormalizedBaseUrl(
			"https://proxy.example.com/v1",
			"https://proxy.example.com/v1/models",
		),
		null,
	);
});

test("google root base suggests v1beta when request used it", () => {
	assert.equal(
		suggestNormalizedBaseUrl(
			"https://generativelanguage.googleapis.com",
			"https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent",
			"google-generative-ai",
		),
		"https://generativelanguage.googleapis.com/v1beta",
	);
});

test("puppyrouter gateway base keeps single /v1 across model fetch", () => {
	// 官方 Codex 线路：base URL 含 /v1、不能再补、不能再追加 /responses。
	// 检测请求落在 {base}/v1/models，会话请求落在 {base}/v1/responses。
	assert.equal(
		hasApiVersionPath("https://puppyrouter.com/v1"),
		true,
	);
	assert.equal(
		extractVersionedBaseFromRequestUrl("https://puppyrouter.com/v1/models"),
		"https://puppyrouter.com/v1",
	);
	assert.equal(
		extractVersionedBaseFromRequestUrl("https://puppyrouter.com/v1/responses"),
		"https://puppyrouter.com/v1",
	);
	// 已配置完整 /v1 的 baseUrl 不再被改写
	assert.equal(
		needsSessionBaseUrlVersionHint(
			"https://puppyrouter.com/v1",
			"https://puppyrouter.com/v1/models",
		),
		false,
	);
	assert.equal(
		suggestNormalizedBaseUrl(
			"https://puppyrouter.com/v1",
			"https://puppyrouter.com/v1/models",
		),
		null,
	);
});
