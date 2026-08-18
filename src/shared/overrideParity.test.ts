import { describe, expect, it, vi } from "vitest";
import { ipcTable, type IpcOpEntry } from "./ipc";
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
 *
 * 注意：本测试当前「预期红灯」——previewApi / browserApi 尚未提供 clipboard.writeText，
 * 该失败正是 Wave 2 的修复范围；preload 层必须全绿。
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
			// 【预期红灯】previewApi / browserApi 当前缺 clipboard.writeText
			// （browserApi 经 ...base 继承 previewApi 的缺口），preload 必须全绿
			const failures = checkOverridePresence(surface());
			// 失败详情直接进断言消息：即便 diff 折叠数组，也能看到具体缺了哪个成员
			expect(failures, `${name} 层覆盖缺口：${failures.join(" | ")}`).toEqual([]);
		});
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