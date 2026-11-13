import { describe, expect, it, vi } from "vitest";
import { ipcTable, webRouteUrl, webRoutes, type IpcOpEntry, type WebRestRoute } from "./ipc";
import type { PiDesktopApi } from "./api";
import { buildApi, type IpcBridge } from "../preload/buildApi";
import { createMockApiBase } from "../renderer/src/mockApiBase";
import { createPreviewApi } from "../renderer/src/previewApi";
import { createBrowserApi } from "../renderer/src/browserApi";

/**
 * override 成员奇偶守卫（生成式）：
 *
 * ipcTable 里标了 `override: true` 的成员不走通道表生成器（buildApi / createMockApiBase
 * 都明确跳过它们），而是由各实现层的覆盖对象手工再提供一份：
 *   - preload 的 apiOverrides（webUtils / sendSync / fire-and-forget）
 *   - renderer 的 previewApi（预览模式假实现）
 *   - renderer 的 browserApi（浏览器模式，base 继承 previewApi）
 *
 * 本测试从表结构本身推导 override 成员集合，逐一断言每个实现层都补齐了这些成员——
 * 表里新增 override 标记而某层漏补时，这里就是第一道运行时防线
 * （如 clipboard.writeText 曾只进了 preload apiOverrides、漏了 previewApi）。
 */

/** 推导 override 成员键（"命名空间.成员"），从表结构出发，不写死名单。 */
function collectOverrideKeys(): string[] {
	const keys: string[] = [];
	for (const [namespace, members] of Object.entries(ipcTable)) {
		for (const [member, entry] of Object.entries(members)) {
			if ((entry as IpcOpEntry).override) keys.push(`${namespace}.${member}`);
		}
	}
	return keys.sort();
}

/** 全部表成员键（正向下断言只覆盖 override 子集，负向控制用）。 */
function collectAllKeys(): string[] {
	const keys: string[] = [];
	for (const [namespace, members] of Object.entries(ipcTable)) {
		for (const member of Object.keys(members)) keys.push(`${namespace}.${member}`);
	}
	return keys.sort();
}

/** 从 api 表面取成员（缺命名空间/缺成员都收敛为 undefined，便于统一报错）。 */
function getMember(surface: unknown, namespace: string, member: string): unknown {
	if (typeof surface !== "object" || surface === null) return undefined;
	const ns = (surface as Record<string, unknown>)[namespace];
	if (typeof ns !== "object" || ns === null) return undefined;
	return (ns as Record<string, unknown>)[member];
}

/**
 * 编译期守卫：override 成员在 PiDesktopApi 里的声明形态只能是函数或 boolean
 * （perf.enabled 是唯一 boolean），其它形态（string/object/…）直接 typecheck 失败。
 * 运行时只校验「存在且形态合法」，具体每个成员该是函数还是 boolean 由本守卫兜底。
 */
type OverrideShapeOk = {
	[Ns in keyof PiDesktopApi]: {
		[M in keyof PiDesktopApi[Ns]]: (typeof ipcTable)[Ns] extends Record<M, unknown>
			? (typeof ipcTable)[Ns][M] extends { override: true }
				? PiDesktopApi[Ns][M] extends (...args: never[]) => unknown
					? true
					: PiDesktopApi[Ns][M] extends boolean
						? true
						: false
				: true
			: true;
	}[keyof PiDesktopApi[Ns]];
}[keyof PiDesktopApi];
type ExpectTrue<T extends true> = T;
type _overrideShapeGuard = ExpectTrue<OverrideShapeOk>;

const OVERRIDE_KEYS = collectOverrideKeys();
const ALL_KEYS = collectAllKeys();

/** 生成器假 bridge：buildApi 只建闭包不触达 IPC，注入空实现即可安全调用。 */
const fakeBridge: IpcBridge = {
	invoke: async () => undefined,
	send: () => undefined,
	sendSync: () => undefined,
	on: () => undefined,
	removeListener: () => undefined,
};

/**
 * electron mock：preload/index.ts 模块级就把合并后的 api 交给
 * contextBridge.exposeInMainWorld。apiOverrides 字面量未导出，这里从
 * 真实暴露面（window.piDesktop 的等价物）抓取——比检查字面量更强，
 * 保证的是渲染层实际能拿到的东西。
 */
const electronMock = vi.hoisted(() => {
	const state: { exposedApi: unknown } = { exposedApi: undefined };
	return {
		state,
		contextBridge: {
			exposeInMainWorld: vi.fn((_key: string, api: unknown) => {
				state.exposedApi = api;
			}),
		},
		ipcRenderer: {
			invoke: vi.fn(() => Promise.resolve(undefined)),
			send: vi.fn(),
			sendSync: vi.fn(() => []),
			on: vi.fn(),
			removeListener: vi.fn(),
		},
		webUtils: { getPathForFile: vi.fn(() => "") },
	};
});

vi.mock("electron", () => electronMock);

// 副作用导入：触发 preload 模块求值，把真实 api 灌进 electronMock.state.exposedApi。
// 必须在 vi.mock 之后（vitest 会把 mock 提升到所有 import 之前）。
import "../preload/index";

/** 三个实现层的表面提供器（函数延迟求值，避免测试间共享可变状态）。 */
const LAYERS = [
	{
		name: "preload（apiOverrides → window.piDesktop）",
		surface: () => electronMock.state.exposedApi,
	},
	{ name: "previewApi（createPreviewApi）", surface: () => createPreviewApi() },
	{ name: "browserApi（createBrowserApi）", surface: () => createBrowserApi() },
] as const;

/** 对某个层表面跑正向探测：返回所有 override 成员缺失/形态非法的失败消息。 */
function checkOverridePresence(surface: unknown): string[] {
	const failures: string[] = [];
	for (const key of OVERRIDE_KEYS) {
		const [namespace, member] = key.split(".");
		const value = getMember(surface, namespace, member);
		if (value === undefined) {
			failures.push(`override 成员缺失: ${key}（typeof undefined）`);
			continue;
		}
		// 形态合法集由 _overrideShapeGuard 在编译期锁定为 function | boolean
		const kind = typeof value;
		if (kind !== "function" && kind !== "boolean") {
			failures.push(`override 成员形态非法: ${key}（typeof ${kind}，期望 function|boolean）`);
		}
	}
	return failures;
}

describe("override 成员 × 实现层奇偶守卫（表驱动）", () => {
	describe.each(LAYERS)("$name", ({ name, surface }) => {
		it(`补齐表里全部 ${OVERRIDE_KEYS.length} 个 override 成员（${OVERRIDE_KEYS.join("、")}）`, () => {
			const failures = checkOverridePresence(surface());
			// 失败详情直接进断言消息：即便 diff 折叠数组，也能看到具体缺了哪个成员
			expect(failures, `${name} 层覆盖缺口：${failures.join(" | ")}`).toEqual([]);
		});
	});
});
/** 推导 web 能力成员键（"命名空间.成员"），从表结构出发，不写死名单。 */
function collectWebKeys(): string[] {
	const keys: string[] = [];
	for (const [namespace, members] of Object.entries(ipcTable)) {
		for (const [member, entry] of Object.entries(members)) {
			if ((entry as IpcOpEntry).web) keys.push(`${namespace}.${member}`);
		}
	}
	return keys.sort();
}

const WEB_KEYS = collectWebKeys();

/** 取表条目（"ns.member"）；表结构由 satisfies IpcTable 保证成员齐备。 */
function entryFor(key: string): IpcOpEntry | undefined {
	const [namespace, member] = key.split(".");
	return (ipcTable as unknown as Record<string, Record<string, IpcOpEntry>>)[namespace]?.[member];
}

/**
 * 轮询型 web 成员：没有独立 REST 端点，浏览器端复用 /api/state 轮询。
 * 新增 web 成员时若不在这里显式归类、也没有 route，守卫会红——不允许「忘了接」。
 */
const POLL_WEB_KEYS = ["agents.list", "agents.onMessages", "agents.onState", "projects.list"];

/** 守卫探针：实参 + 期望路径参数/查询/请求体 + 假响应，逐项与 webRoutes 描述符对账。 */
type WebProbe = {
	args: unknown[];
	params?: Record<string, string>;
	query?: Record<string, string>;
	body?: unknown;
	/** 假响应体；缺省 { ok: true }，仅用于 void 端点的传输层确认。 */
	response?: Record<string, unknown>;
};

const GUARD_AGENT = "guard-agent";
const GUARD_PROJECT = "guard-project";
const GUARD_RUNTIME_STATE = { modelName: "guard", provider: "guard", modelId: "guard" };

const WEB_STATE_RESPONSE = { projects: [], agents: [], messagesByAgent: {} };

const WEB_PROBES: Record<string, WebProbe> = {
	"projects.list": { args: [] },
	"sessions.list": {
		args: [GUARD_PROJECT],
		params: { projectId: GUARD_PROJECT },
		response: { sessions: [] },
	},
	"sessions.readMessageFullText": {
		args: [GUARD_AGENT, "guard-message", "guard-entry"],
		params: { agentId: GUARD_AGENT, messageId: "guard-message" },
		query: { entryId: "guard-entry" },
		response: { text: "guard full text" },
	},
	"agents.getMessages": {
		args: [GUARD_AGENT],
		params: { agentId: GUARD_AGENT },
		response: { messages: [] },
	},
	"agents.abortAndRestoreQueue": {
		args: [GUARD_AGENT],
		params: { agentId: GUARD_AGENT },
		response: { restoredText: "", hadQueue: false },
	},
	"agents.removeQueuedMessage": {
		args: [GUARD_AGENT, "guard message", "steering"],
		params: { agentId: GUARD_AGENT },
		body: { message: "guard message", queue: "steering" },
		response: { removed: true },
	},
	"agents.promoteQueuedMessage": {
		args: [GUARD_AGENT, "guard message"],
		params: { agentId: GUARD_AGENT },
		body: { message: "guard message" },
		response: { promoted: true },
	},
	"agents.sendUiResponse": {
		args: [GUARD_AGENT, "guard-request", { value: "guard" }],
		params: { agentId: GUARD_AGENT },
		body: { requestId: "guard-request", value: "guard" },
	},
	"agents.respondTrustRequest": {
		args: ["guard-request", "trust-session"],
		params: { requestId: "guard-request" },
		body: { choice: "trust-session" },
	},
	"agents.list": { args: [] },
	"agents.create": {
		args: [{ projectId: GUARD_PROJECT, title: "guard" }],
		body: { projectId: GUARD_PROJECT, title: "guard" },
		response: { agent: { id: GUARD_AGENT } },
	},
	"agents.historyPage": {
		args: [{ agentId: GUARD_AGENT, before: "cursor", limit: 5 }],
		params: { agentId: GUARD_AGENT },
		query: { before: "cursor", limit: "5" },
		response: { messages: [], nextCursor: null, hasMore: false },
	},
	"agents.stop": { args: [GUARD_AGENT], params: { agentId: GUARD_AGENT } },
	"agents.prompt": {
		args: [{ agentId: GUARD_AGENT, message: "guard prompt" }],
		params: { agentId: GUARD_AGENT },
		body: { agentId: GUARD_AGENT, message: "guard prompt" },
		response: { result: { accepted: true } },
	},
	"agents.abort": { args: [GUARD_AGENT], params: { agentId: GUARD_AGENT } },
	"agents.runtimeState": {
		args: [GUARD_AGENT],
		params: { agentId: GUARD_AGENT },
		response: { state: GUARD_RUNTIME_STATE },
	},
	"agents.cycleModel": {
		args: [GUARD_AGENT],
		params: { agentId: GUARD_AGENT },
		response: { state: GUARD_RUNTIME_STATE },
	},
	"agents.availableModels": {
		args: [GUARD_AGENT],
		params: { agentId: GUARD_AGENT },
		response: { models: [] },
	},
	"agents.setModel": {
		args: [GUARD_AGENT, "guard-provider", "guard-model"],
		params: { agentId: GUARD_AGENT },
		body: { provider: "guard-provider", modelId: "guard-model" },
		response: { state: GUARD_RUNTIME_STATE },
	},
	"agents.refreshModels": {
		args: [GUARD_AGENT],
		params: { agentId: GUARD_AGENT },
		response: { state: GUARD_RUNTIME_STATE },
	},
	"agents.cycleThinking": {
		args: [GUARD_AGENT],
		params: { agentId: GUARD_AGENT },
		response: { state: GUARD_RUNTIME_STATE },
	},
	"agents.setThinking": {
		args: [GUARD_AGENT, "high"],
		params: { agentId: GUARD_AGENT },
		body: { level: "high" },
		response: { state: GUARD_RUNTIME_STATE },
	},
	"agents.availableThinkingLevels": {
		args: [GUARD_AGENT],
		params: { agentId: GUARD_AGENT },
		response: { levels: ["off", "high"] },
	},
	"agents.setFastMode": {
		args: [GUARD_AGENT, true],
		params: { agentId: GUARD_AGENT },
		body: { enabled: true },
		response: { state: GUARD_RUNTIME_STATE },
	},
	"agents.setSlowMode": {
		args: [GUARD_AGENT, false],
		params: { agentId: GUARD_AGENT },
		body: { enabled: false },
		response: { state: GUARD_RUNTIME_STATE },
	},
	"agents.setAutoCompaction": {
		args: [GUARD_AGENT, true],
		params: { agentId: GUARD_AGENT },
		body: { enabled: true },
		response: { state: GUARD_RUNTIME_STATE },
	},
	"agents.setTodos": {
		args: [GUARD_AGENT, [{ title: "guard" }]],
		params: { agentId: GUARD_AGENT },
		body: { phases: [{ title: "guard" }] },
		response: { state: GUARD_RUNTIME_STATE },
	},
	"agents.onState": { args: [() => undefined] },
	"agents.onMessages": { args: [() => undefined] },
};

describe("web 能力列 × browserApi 奇偶守卫（表驱动）", () => {
	it(`全部 ${WEB_KEYS.length} 个 web 成员都有守卫探针（新增 web 成员必须显式归类）`, () => {
		expect(Object.keys(WEB_PROBES).sort()).toEqual(WEB_KEYS);
	});

	it("web 成员要么挂 webRoutes 端点，要么显式归入 /api/state 轮询", () => {
		const failures: string[] = [];
		for (const key of WEB_KEYS) {
			const hasRoute = Boolean(entryFor(key)?.route);
			const polled = POLL_WEB_KEYS.includes(key);
			if (hasRoute === polled) failures.push(key);
		}
		expect(failures, `web 成员缺路由或归类冲突: ${failures.join(" | ")}`).toEqual([]);
	});

	it("ipcTable.route 与 webRoutes 同名条目是同一对象，且没有被孤立的路由", () => {
		const failures: string[] = [];
		for (const [namespace, members] of Object.entries(ipcTable)) {
			for (const [member, entry] of Object.entries(members)) {
				const route = (entry as IpcOpEntry).route;
				if (!route) continue;
				const expected = (webRoutes as unknown as Record<string, Record<string, WebRestRoute>>)[
					namespace
				]?.[member];
				if (route !== expected) failures.push(`${namespace}.${member}`);
			}
		}
		const referenced = new Set<IpcOpEntry["route"]>();
		for (const members of Object.values(ipcTable)) {
			for (const entry of Object.values(members)) {
				const route = (entry as IpcOpEntry).route;
				if (route) referenced.add(route);
			}
		}
		for (const [namespace, members] of Object.entries(
			webRoutes as unknown as Record<string, Record<string, WebRestRoute>>,
		)) {
			for (const [member, route] of Object.entries(members)) {
				if (!referenced.has(route)) failures.push(`${namespace}.${member}（webRoutes 孤立条目）`);
			}
		}
		expect(failures, `路由与成员未对齐: ${failures.join(" | ")}`).toEqual([]);
	});

	it("web 能力列非空且是表成员的真子集", () => {
		expect(WEB_KEYS.length).toBeGreaterThan(0);
		expect(WEB_KEYS.length).toBeLessThan(ALL_KEYS.length);
	});

	// 行为探针：直接调用 browserApi 成员并拦截 fetch，断言「请求确实由共享路由表派生」。
	// 原来的实现拿 createBrowserApi() 与另一次 createPreviewApi() 做引用比较——
	// 两次调用必然产生不同闭包，比较恒为 false，等于空断言；只有真实调用链能证明
	// 成员没有继承 preview/mock 的 async () => undefined 兜底。
	it.each(Object.entries(WEB_PROBES))("%s 的 browserApi 实现经由共享路由表发请求", async (key, probe) => {
		const [namespace, member] = key.split(".");
		const value = getMember(createBrowserApi(), namespace, member);
		expect(typeof value, `browserApi.${key} 应为可调用实现`).toBe("function");

		const route = entryFor(key)?.route;
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				calls.push({ url: String(input), init });
				// 变更类端点在路由调用之后还会拉 /api/state：那个请求必须拿到合法聚合载荷，
				// 否则 refreshState 会抛「Invalid web service state payload」，把探针的失败
				// 伪装成被测成员的问题。按 URL 分流，而不是按 URL 顺序猜。
				const isStatePoll = String(input).includes("/api/state");
				const payload =
					!isStatePoll && route && probe.response ? probe.response : WEB_STATE_RESPONSE;
				return { ok: true, status: 200, statusText: "OK", json: async () => payload } as unknown as Response;
			}),
		);
		// browserApi 在轮询/连接广播时走 window；node 测试环境没有 window，按需补最小桩。
		vi.stubGlobal("window", {
			dispatchEvent: vi.fn(),
			setInterval: vi.fn(() => 1),
			clearInterval: vi.fn(),
		});

		let unsubscribe: (() => void) | undefined;
		try {
			const returned = await (value as (...args: unknown[]) => unknown)(...probe.args);
			if (typeof returned === "function") unsubscribe = returned as () => void;

			expect(
				calls.length,
				`browserApi.${key} 未发任何请求（疑似继承 preview/mock 的 no-op 兜底）`,
			).toBeGreaterThan(0);

			if (!route) {
				expect(probe.params, `${key} 是轮询型，不应声明路径参数`).toBeUndefined();
				expect(calls[0].url, `${key} 应轮询 /api/state`).toBe("/api/state");
				return;
			}

			expect(calls[0].url.split("?")[0], `${key} 路径应派生自 webRoutes`).toBe(
				webRouteUrl(route, probe.params ?? {}),
			);
			expect(calls[0].init?.method ?? "GET", `${key} method 应派生自 webRoutes`).toBe(route.method);
			if (probe.body === undefined) {
				expect(calls[0].init?.body, `${key} 不应带请求体`).toBeUndefined();
			} else {
				expect(JSON.parse(String(calls[0].init?.body)), `${key} 请求体字段名漂移`).toEqual(
					probe.body,
				);
			}
			if (probe.query) {
				const search = new URLSearchParams(calls[0].url.split("?")[1] ?? "");
				expect(Object.fromEntries(search)).toEqual(probe.query);
			}
			if (route.result === undefined) {
				expect(returned, `${key} 应返回 void`).toBeUndefined();
			} else if (route.result === "body") {
				expect(returned).toEqual(probe.response);
			} else {
				expect(returned).toEqual((probe.response ?? {})[route.result.field]);
			}
		} finally {
			unsubscribe?.();
			vi.unstubAllGlobals();
		}
	});
});

describe("负向控制：非 override 成员不要求存在于覆盖对象", () => {
	it("正向要求集严格是表成员的真子集（只要求 override 标记的成员）", () => {
		expect(OVERRIDE_KEYS.length).toBeGreaterThan(0);
		expect(OVERRIDE_KEYS.length).toBeLessThan(ALL_KEYS.length);
	});

	it("生成器（buildApi / createMockApiBase）本身不含任何 override 成员——它们只靠覆盖对象供给", () => {
		// 防「假绿」：如果哪个生成器开始顺手生成 override 成员，正向断言会形同虚设
		const generators = {
			"buildApi(fakeBridge)": buildApi(fakeBridge),
			"createMockApiBase()": createMockApiBase(),
		};
		for (const [generatorName, generated] of Object.entries(generators)) {
			for (const key of OVERRIDE_KEYS) {
				const [namespace, member] = key.split(".");
				const value = getMember(generated, namespace, member);
				expect(value, `${generatorName} 不应生成 ${key}（由覆盖对象提供）`).toBeUndefined();
			}
		}
	});

	it("每个实现层表面里非 override 成员齐备（由生成器提供，覆盖对象可安心缺省它们）", () => {
		// 静态已知集合：Object.fromEntries 收敛成 Record 做成员判定（集合本身不在测试中变更）
		const overrideSet: Record<string, true> = Object.fromEntries(OVERRIDE_KEYS.map((key) => [key, true]));
		for (const { name, surface } of LAYERS) {
			for (const key of ALL_KEYS) {
				if (overrideSet[key]) continue;
				const [namespace, member] = key.split(".");
				const value = getMember(surface(), namespace, member);
				expect(value, `${name} 表面缺少非 override 成员 ${key}`).toBeDefined();
			}
		}
	});

	it("preload 测试前提自检：electron mock 已捕获真实暴露面", () => {
		const exposed = electronMock.state.exposedApi;
		expect(typeof exposed, "preload 模块应通过 contextBridge.exposeInMainWorld 暴露 api").toBe("object");
		expect(exposed).not.toBeNull();
	});
});