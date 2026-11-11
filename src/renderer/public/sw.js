/*
 * OmpDeck 手机端最小 Service Worker。
 * - 安装时预缓存应用外壳（HTML/manifest/图标），断网时导航仍能启动；
 * - 导航请求网络优先，保证桌面端升级后手机不会长期停留在旧 HTML；
 * - 带 ?v= 版本号的静态资源缓存优先，升级时由版本号换键，首次联网后离线可用；
 * - /api/ 与带 ?token= 的请求永不写入 Cache Storage。
 */
const CACHE_NAME = "ompdeck-shell-v18";
const SHELL_ASSETS = [
	"./",
	"./index.html",
	"./mobile.html",
	"./mobile.js",
	"./mobile.css",
	"./mobile-state.js",
	"./manifest.webmanifest",
	"./icon-192.png",
	"./icon-512.png",
];

function isMobileRequest(request) {
	const url = new URL(request.url);
	return (
		url.searchParams.get("mobile") === "1" ||
		/Android|iPhone|iPad|iPod|Mobile/i.test(request.headers.get("user-agent") || "") ||
		request.headers.get("sec-ch-ua-mobile") === "?1"
	);
}

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
		// 显式请求桌面版时不要把响应写进手机壳缓存，避免离线打开手机页变成桌面 bundle。
		const desktopRequested =
			url.pathname.endsWith("/index.html") || url.searchParams.get("desktop") === "1";
		const shell =
			!desktopRequested && isMobileRequest(request) ? "./mobile.html" : "./index.html";
		event.respondWith(
			(async () => {
				try {
					const response = await fetch(request);
					if (response.ok) {
						const cache = await caches.open(CACHE_NAME);
						await cache.put(shell, response.clone());
					}
					return response;
				} catch (error) {
					const cached =
						(await caches.match(request)) ||
						(await caches.match(shell)) ||
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
			try {
				const response = await fetch(request);
				if (response.ok) {
					const cache = await caches.open(CACHE_NAME);
					await cache.put(request, response.clone());
				}
				return response;
			} catch (error) {
				// HTML 里带 ?v=N 的静态资源，预缓存使用无查询串路径；只在断网时回退，
				// 否则升级版本号后仍会命中旧的无查询串缓存。
				const versionless = url.searchParams.has("v")
					? await caches.match(new URL(url.pathname, self.location.origin).href)
					: undefined;
				if (versionless) return versionless;
				throw error;
			}
		})(),
	);
});
