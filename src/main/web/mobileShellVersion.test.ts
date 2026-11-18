import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentRuntimeState, AgentTab, SendPromptResult } from "../../shared/types";
import {
	MOBILE_SHELL_VERSION,
	MOBILE_SHELL_VERSION_TOKEN,
	applyMobileShellVersion,
} from "../../shared/mobileShell";
import mobileHtml from "../../renderer/public/mobile.html?raw";
import serviceWorkerJs from "../../renderer/public/sw.js?raw";
import { WebServiceManager } from "./WebServiceManager";

/**
 * 手机外壳的缓存失效契约：
 *
 * `mobile.html` 的三个 `?v=` 与 `sw.js` 的 `CACHE_NAME` 必须同进同退。漏改一次
 * 就会把「新的 mobile.js + 旧的 mobile-state.js」推给手机——历史上正是这种组合
 * 逼出 mobile.js 里的特性探测道歉。现在版本号只有一个来源（shared/mobileShell），
 * 静态文件里只剩占位符，这里守住两件事：
 *
 * 1. 静态文件里不许再出现字面版本数字（否则单一来源立刻退化成两处手改）；
 * 2. Main 进程读文件后真的替换了，且 html 与 sw.js 拿到的是同一个数字。
 */

/** 只从源码里数版本位，不复制实现：出现字面数字就说明有人绕过了占位符。 */
const VERSIONED_ATTR = /\?v=([^"'`\s>]*)/g;
const CACHE_NAME_LINE = /const CACHE_NAME = "([^"]+)"/;

describe("手机外壳版本号单一来源", () => {
	test("mobile.html 的每个 ?v= 都是占位符", () => {
		const values = Array.from(mobileHtml.matchAll(VERSIONED_ATTR), (match) => match[1]);
		// 三个脚本/样式标签都要带版本位；少一个说明标签被改坏，测试也要跟着响。
		expect(values).toHaveLength(3);
		expect(values).toEqual([
			MOBILE_SHELL_VERSION_TOKEN,
			MOBILE_SHELL_VERSION_TOKEN,
			MOBILE_SHELL_VERSION_TOKEN,
		]);
	});

	test("sw.js 的 CACHE_NAME 带占位符而不是字面数字", () => {
		const cacheName = CACHE_NAME_LINE.exec(serviceWorkerJs)?.[1];
		expect(cacheName).toBe(`ompdeck-shell-v${MOBILE_SHELL_VERSION_TOKEN}`);
	});

	test("替换后不再残留占位符，且 html 与 sw.js 的版本一致", () => {
		const html = applyMobileShellVersion(mobileHtml);
		const sw = applyMobileShellVersion(serviceWorkerJs);
		expect(html).not.toContain(MOBILE_SHELL_VERSION_TOKEN);
		expect(sw).not.toContain(MOBILE_SHELL_VERSION_TOKEN);

		const htmlVersions = new Set(Array.from(html.matchAll(VERSIONED_ATTR), (m) => m[1]));
		const cacheVersion = CACHE_NAME_LINE.exec(sw)?.[1]?.replace("ompdeck-shell-v", "");
		// 两边必须落到同一个数字：否则手机会换掉 HTML 的缓存键，却继续命中旧 CACHE_NAME。
		expect(htmlVersions).toEqual(new Set([MOBILE_SHELL_VERSION]));
		expect(cacheVersion).toBe(MOBILE_SHELL_VERSION);
	});

	test("不含占位符的文本原样返回（桌面 bundle 不该为此多复制一遍）", () => {
		const text = "const a = 1;";
		expect(applyMobileShellVersion(text)).toBe(text);
	});
});

/** 借临时 listen(0) 取一个空闲端口后立即释放（与 webServiceLifecycle.test.ts 同一手法）。 */
async function freePort(): Promise<number> {
	const probe = createHttpServer();
	const listening = Promise.withResolvers<void>();
	probe.once("error", listening.reject);
	probe.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = probe.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const closed = Promise.withResolvers<void>();
	probe.close(() => closed.resolve());
	await closed.promise;
	return port;
}

const stubRuntimeState = async () => ({}) as unknown as AgentRuntimeState;

type WebDeps = ConstructorParameters<typeof WebServiceManager>[0];

const deps: WebDeps = {
	listProjects: () => [],
	listAgents: () => [],
	listSessions: async () => [],
	getMessages: () => [],
	createAgent: async () => ({}) as unknown as AgentTab,
	sendPrompt: async () => ({}) as unknown as SendPromptResult,
	stopAgent: async () => {},
	abortAgent: async () => {},
	sendUiResponse: async () => {},
	respondTrustRequest: async () => {},
	getHistoryPage: async () => ({ messages: [], nextCursor: null, hasMore: false }),
	listTrustRequests: () => [],
	persistWebToken: async () => {},
	runtimeState: stubRuntimeState,
	cycleModel: stubRuntimeState,
	availableModels: async () => [],
	setModel: stubRuntimeState,
	refreshModels: stubRuntimeState,
	cycleThinking: stubRuntimeState,
	setThinking: stubRuntimeState,
	availableThinkingLevels: async () => [],
	setFastMode: stubRuntimeState,
	setSlowMode: stubRuntimeState,
	setAutoCompaction: stubRuntimeState,
	setTodos: stubRuntimeState,
	abortAndRestoreQueue: async () => ({ steering: [], followUp: [] }),
	removeQueuedMessage: async () => ({ removed: false }),
	promoteQueuedMessage: async () => ({ promoted: false }),
};

describe("手机外壳经真实服务下发时已是替换后的版本", () => {
	test("mobile.html 与 sw.js 返回的版本号一致且为真实数字", async () => {
		const manager = new WebServiceManager(deps, 50, {
			// 默认根目录是构建产物旁的 `../renderer`；vitest 下要指到源码里的 public。
			rendererRoot: join(import.meta.dirname, "../../renderer/public"),
		});
		const port = await freePort();
		await manager.applySettings({
			webServiceEnabled: true,
			webServiceHost: "127.0.0.1",
			webServicePort: port,
			webServiceToken: "",
			webServiceTokenGeneratedAt: 0,
			webServiceTokenExpiresAt: null,
			webServiceTokenTtlDays: 0,
		});
		const bound = manager.getStatus(false);
		try {
			// 用手机 UA 请求，保证命中 mobile.html 外壳而不是走桌面入口。
			const headers = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile" };
			const [htmlResponse, swResponse] = await Promise.all([
				fetch(`http://127.0.0.1:${bound.port}/`, { headers }),
				fetch(`http://127.0.0.1:${bound.port}/sw.js`),
			]);
			const html = await htmlResponse.text();
			const sw = await swResponse.text();

			expect(html).not.toContain(MOBILE_SHELL_VERSION_TOKEN);
			expect(sw).not.toContain(MOBILE_SHELL_VERSION_TOKEN);
			// 响应体必须自报版本：客户端据此换缓存键，缺了就等于回到手改年代。
			expect(html).toContain(`mobile.js?v=${MOBILE_SHELL_VERSION}`);
			expect(html).toContain(`mobile-state.js?v=${MOBILE_SHELL_VERSION}`);
			expect(sw).toContain(`ompdeck-shell-v${MOBILE_SHELL_VERSION}`);
			// sw.js 必须每次回源，否则新的 CACHE_NAME 永远到不了已安装的 Worker。
			expect(swResponse.headers.get("cache-control")).toBe("no-store");
		} finally {
			await manager.stop();
		}
	});
});
