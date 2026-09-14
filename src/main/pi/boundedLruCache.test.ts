import assert from "node:assert/strict";
import { test } from "vitest";

import { BoundedLruCache } from "./boundedLruCache";

/**
 * 有界缓存的驱逐契约：归档缓存按估算字节上限驱逐，否则本次运行碰过的每个会话
 * 都会把整份归档永久钉在堆上；顺序必须是「最久未用」，否则热点条目会被误逐。
 */

test("超过容量后按最久未用驱逐，命中会刷新使用顺序", () => {
	const cache = new BoundedLruCache<string, number>(3, () => 1);

	cache.set("a", 1);
	cache.set("b", 2);
	cache.set("c", 3);
	assert.equal(cache.get("a"), 1, "命中 a，a 成为最近使用");

	cache.set("d", 4);

	assert.equal(cache.get("b"), undefined, "b 最久未用，应被驱逐");
	assert.equal(cache.get("a"), 1);
	assert.equal(cache.get("c"), 3);
	assert.equal(cache.get("d"), 4);
});

test("单条超过上限时仍保留最新一条（缓存不会被大条目清空）", () => {
	const cache = new BoundedLruCache<string, number>(10, (value) => value);

	cache.set("big", 1000);

	assert.equal(cache.get("big"), 1000);
});
