import assert from "node:assert/strict";
import { test } from "vitest";
import {
	consumePendingUrl,
	navigateTo,
	subscribeNavigate,
} from "./browserNavigation";

/**
 * 内置浏览器外部导航的真实契约测试（直测 browserNavigation.ts）。
 *
 * 历史版本在测试文件里内联复现一份订阅机制再断言，等于给副本发绿灯——
 * 真实 BrowserPanel 的契约可以随意破坏。这里改为导入生产模块本身。
 *
 * 每个用例自行消费 pendingUrl 收尾，避免模块级单例状态串场。
 */

test("subscriber receives navigation immediately", () => {
	const seen: string[] = [];
	const unsubscribe = subscribeNavigate((url) => seen.push(url));
	navigateTo("https://one.example/");
	assert.deepEqual(seen, ["https://one.example/"]);
	// 已投递的 URL 不应残留：否则面板卸载再挂载会把它重放成新 tab。
	assert.equal(consumePendingUrl(), null);
	unsubscribe();
});

test("without a subscriber the url is queued for the next mount", () => {
	navigateTo("https://two.example/");
	assert.equal(consumePendingUrl(), "https://two.example/");
	assert.equal(consumePendingUrl(), null, "consume must clear the queue");
});

test("unsubscribe stops delivery", () => {
	const seen: string[] = [];
	const unsubscribe = subscribeNavigate((url) => seen.push(url));
	unsubscribe();
	// 退订后没有订阅者，URL 转入队列而不是投递。
	navigateTo("https://three.example/");
	assert.deepEqual(seen, []);
	assert.equal(consumePendingUrl(), "https://three.example/");
});

test("every subscriber receives the navigation", () => {
	const first: string[] = [];
	const second: string[] = [];
	const offFirst = subscribeNavigate((url) => first.push(url));
	const offSecond = subscribeNavigate((url) => second.push(url));
	navigateTo("https://four.example/");
	assert.deepEqual(first, ["https://four.example/"]);
	assert.deepEqual(second, ["https://four.example/"]);
	offFirst();
	offSecond();
});

test("subscribing again after unsubscribe does not replay the delivered url", () => {
	const first: string[] = [];
	const offFirst = subscribeNavigate((url) => first.push(url));
	navigateTo("https://five.example/");
	offFirst();
	// 模拟抽屉关闭再打开：重新挂载时队列应为空。
	assert.equal(consumePendingUrl(), null);
	const second: string[] = [];
	const offSecond = subscribeNavigate((url) => second.push(url));
	assert.deepEqual(second, [], "remount must not replay the previous navigation");
	offSecond();
	assert.deepEqual(first, ["https://five.example/"]);
});
