/*
 * OmpDeck 手机端最小 Service Worker。
 * - 安装时预缓存应用外壳（HTML/manifest/图标），断网时导航仍能启动；
 * - 导航请求网络优先，保证桌面端升级后手机不会长期停留在旧 HTML；
 * - 哈希静态资源缓存优先（文件名变即缓存键变），首次联网后离线可用；
 * - /api/ 与带 ?token= 的请求永不写入 Cache Storage。
 */
const CACHE_NAME = "ompdeck-shell-v2";
const SHELL_ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE_NAME);
			await Promise.all(
				SHELL_ASSETS.map((asset) => cache.add(asset).catch(() => undefined)),
			);
			await self.skipWaiting();
		})(),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
			await self.clients.claim();
		})(),
	);
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
	// 首次扫码 URL 带 ?token=，不把令牌写进 Cache Storage。
	if (url.searchParams.has("token")) return;

	if (request.mode === "navigate") {
		event.respondWith(
			(async () => {
				try {
					const response = await fetch(request);
					if (response.ok) {
						const cache = await caches.open(CACHE_NAME);
						await cache.put("./index.html", response.clone());
					}
					return response;
				} catch (error) {
					const cached =
						(await caches.match(request)) ||
						(await caches.match("./index.html")) ||
						(await caches.match("./"));
					if (cached) return cached;
					throw error;
				}
			})(),
		);
		return;
	}

	event.respondWith(
		(async () => {
			const cached = await caches.match(request);
			if (cached) return cached;
			const response = await fetch(request);
			if (response.ok) {
				const cache = await caches.open(CACHE_NAME);
				await cache.put(request, response.clone());
			}
			return response;
		})(),
	);
});
