// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { GitStatus, type GitResource, type GitResourceGroups } from "../../../shared/types";
import {
	createGitStatusResource,
	GIT_POLL_INTERVAL_MS,
	type GitStatusSource,
} from "./gitStatusResource";

/**
 * Git 状态资源 module 的行为契约。
 *
 * 这些断言钉住的是面板此前散在 300 行 effect 里的四条隐式规则（可见性、焦点、
 * 单飞、陈旧守卫）。它们全都是「坏了也只表现为列表偶尔不更新 / 后台狂 spawn git」的
 * 类型，没有界面断言能抓到，所以必须直接对着 module 的接口测。
 */

/** 显式类型：不暴露 vi.fn 的推断形状，测试只依赖 module 侧声明的接口。 */
type FakeGitSource = {
	status: Mock<GitStatusSource["status"]>;
	branches: Mock<GitStatusSource["branches"]>;
	probe: Mock<GitStatusSource["probe"]>;
};

function groupsWith(path: string): GitResourceGroups {
	const resource: GitResource = {
		path,
		status: GitStatus.MODIFIED,
		letter: "M",
	};
	return { merge: [], index: [], workingTree: [resource], untracked: [] };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function createSource(): FakeGitSource {
	return {
		status: vi.fn<GitStatusSource["status"]>(async () => groupsWith("a.ts")),
		branches: vi.fn<GitStatusSource["branches"]>(async () => ({
			current: "main",
			branches: ["main"],
		})),
		probe: vi.fn<GitStatusSource["probe"]>(async () => ({
			gitAvailable: true,
			isRepo: true,
		})),
	};
}

/** jsdom 的 visibilityState 只读，测试里替换实例属性来控制文档可见性。 */
function setDocumentHidden(hidden: boolean): void {
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		get: () => (hidden ? "hidden" : "visible"),
	});
}

let element: HTMLDivElement;

beforeEach(() => {
	vi.useFakeTimers();
	setDocumentHidden(false);
	element = document.createElement("div");
	document.body.appendChild(element);
});

afterEach(() => {
	vi.useRealTimers();
	element.remove();
});

function createResource(source: GitStatusSource) {
	return createGitStatusResource({
		git: () => source,
		projectId: "p1",
		initialBranchInfo: { current: "main", branches: ["main"] },
	});
}

describe("gitStatusResource 轮询调度", () => {
	it("install 立即补一次，之后每 30s 兜底；dispose 后不再有请求与监听", async () => {
		const source = createSource();
		const resource = createResource(source);
		const dispose = resource.install(element);
		await vi.advanceTimersByTimeAsync(0);

		// 首次挂载：sync 立刻拉 status + branches（不等 30s）。
		expect(source.status).toHaveBeenCalledTimes(1);
		expect(source.branches).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(GIT_POLL_INTERVAL_MS - 1);
		// 30s 之内不许再拉（契约：30s 兜底，不许「顺手」改得更频繁）。
		expect(source.status).toHaveBeenCalledTimes(1);
		expect(source.branches).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(source.status).toHaveBeenCalledTimes(2);
		expect(source.branches).toHaveBeenCalledTimes(2);

		// dispose 之后即使再推进几个周期、再触发焦点/可见性事件，也不许再 spawn git。
		dispose();
		expect(vi.getTimerCount()).toBe(0);
		const statusCalls = source.status.mock.calls.length;
		const branchCalls = source.branches.mock.calls.length;
		setDocumentHidden(true);
		document.dispatchEvent(new Event("visibilitychange"));
		setDocumentHidden(false);
		document.dispatchEvent(new Event("visibilitychange"));
		window.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(GIT_POLL_INTERVAL_MS * 4);
		expect(source.status).toHaveBeenCalledTimes(statusCalls);
		expect(source.branches).toHaveBeenCalledTimes(branchCalls);
	});

	it("文档不可见时不拉取；重新可见与窗口聚焦都会立即补一次", async () => {
		setDocumentHidden(true);
		const source = createSource();
		const resource = createResource(source);
		const dispose = resource.install(element);
		await vi.advanceTimersByTimeAsync(GIT_POLL_INTERVAL_MS * 2);
		expect(source.status).not.toHaveBeenCalled();
		expect(source.branches).not.toHaveBeenCalled();

		setDocumentHidden(false);
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);
		expect(source.status).toHaveBeenCalledTimes(1);

		// 焦点事件同样要求「即刻刷新」，而不是等下一个 30s。
		window.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(0);
		expect(source.status).toHaveBeenCalledTimes(2);
		dispose();
	});

	it("面板被 CSS 隐藏时（checkVisibility 为 false）定时器不拉取", async () => {
		const source = createSource();
		const resource = createResource(source);
		Object.defineProperty(element, "checkVisibility", {
			configurable: true,
			value: () => false,
		});
		const dispose = resource.install(element);
		await vi.advanceTimersByTimeAsync(0);
		const statusCalls = source.status.mock.calls.length;

		await vi.advanceTimersByTimeAsync(GIT_POLL_INTERVAL_MS * 3);
		expect(source.status).toHaveBeenCalledTimes(statusCalls);
		dispose();
	});
});

describe("gitStatusResource 单飞与变更门", () => {
	it("在途的静默拉取被合并：并发触发只发一次 IPC", async () => {
		const source = createSource();
		const resource = createResource(source);
		const gate = deferred<GitResourceGroups>();
		source.status.mockImplementationOnce(() => gate.promise);

		const first = resource.refresh({ silent: true });
		const second = resource.refresh({ silent: true });
		expect(source.status).toHaveBeenCalledTimes(1);

		gate.resolve(groupsWith("done.ts"));
		await first;
		await second;
		expect(resource.getSnapshot().groups.workingTree[0].path).toBe("done.ts");
	});

	it("mutation 期间的静默拉取被丢弃；mutation 结束后恢复", async () => {
		const source = createSource();
		const resource = createResource(source);
		const gate = deferred<void>();

		const running = resource.runMutation({ run: () => gate.promise });
		expect(resource.getSnapshot().mutating).toBe(true);

		await resource.refresh({ silent: true });
		expect(source.status).not.toHaveBeenCalled();

		gate.resolve();
		expect(await running).toEqual({ kind: "ok", value: undefined });
		expect(resource.getSnapshot().mutating).toBe(false);
		// 成功路径自己刷一次（默认 refresh: "status"），之后轮询照常恢复。
		expect(source.status).toHaveBeenCalledTimes(1);
		await resource.refresh({ silent: true });
		expect(source.status).toHaveBeenCalledTimes(2);
	});

	it("门被占时第二次 mutation 直接 skipped，且不执行、不亮 spinner", async () => {
		const source = createSource();
		const resource = createResource(source);
		const gate = deferred<void>();
		const second = vi.fn(async () => undefined);

		const first = resource.runMutation({ run: () => gate.promise });
		expect(await resource.runMutation({ run: second })).toEqual({ kind: "skipped" });
		// 关键：第二次连 run 都不该跑，否则 stage/commit 会交叉改写工作区。
		expect(second).not.toHaveBeenCalled();

		gate.resolve();
		await first;
		expect(resource.getSnapshot().mutating).toBe(false);
	});

	it("旧项目跑完的 mutation 收尾不能解锁新项目的门", async () => {
		const source = createSource();
		const resource = createResource(source);
		const gate = deferred<GitResourceGroups>();

		const stale = resource.runMutation({ run: () => gate.promise });
		resource.setProject("p2");
		expect(resource.getSnapshot().mutating).toBe(false);

		const freshGate = deferred<void>();
		const fresh = resource.runMutation({ run: () => freshGate.promise });
		expect(resource.getSnapshot().mutating).toBe(true);

		gate.resolve(groupsWith("p1.ts"));
		// 迟到的旧收尾必须是 no-op，否则新项目的 stage/commit 会在锁被放开的瞬间交叉执行。
		expect(await stale).toEqual({ kind: "stale" });
		expect(resource.getSnapshot().mutating).toBe(true);

		freshGate.resolve();
		await fresh;
		expect(resource.getSnapshot().mutating).toBe(false);
	});

	it("成功按刷新策略落地；失败把干净 message 写进快照并通知调用方", async () => {
		const source = createSource();
		const resource = createResource(source);
		const notice = vi.fn();

		await resource.runMutation({
			run: async () => undefined,
			refresh: "status+branches",
		});
		// status+branches：提交后分支栏不能等下一次轮询。
		expect(source.status).toHaveBeenCalledTimes(1);
		expect(source.branches).toHaveBeenCalledTimes(1);

		source.status.mockClear();
		const failed = await resource.runMutation({
			run: async () => {
				throw new Error("nothing to commit");
			},
			refresh: "none",
			onNotice: notice,
		});
		expect(failed).toEqual({ kind: "failed", errorMessage: "nothing to commit" });
		expect(resource.getSnapshot().error).toBe("nothing to commit");
		expect(notice).toHaveBeenCalledWith("nothing to commit");
		// 失败可能「一半已应用」（stageAll 成功、commit 失败）：要在门释放后补一次静默刷新，
		// 否则面板会停在改动前的分组上最多 30s。静默刷新不写 error/loading，
		// 因此上面刚落的错误文案必须还在，且不能出现 loading 闪回。
		expect(source.status).toHaveBeenCalledTimes(1);
		expect(resource.getSnapshot().error).toBe("nothing to commit");
		expect(resource.getSnapshot().loading).toBe(false);
		// 失败补偿刷新不改变成功路径语义：refresh "none" 成功时仍然一次读取都不发。
		source.status.mockClear();
		await resource.runMutation({ run: async () => undefined, refresh: "none" });
		expect(source.status).not.toHaveBeenCalled();
	});

	it("切走再切回同一项目，旧 mutation 结果仍然作废", async () => {
		const source = createSource();
		const resource = createResource(source);
		const gate = deferred<void>();

		const running = resource.runMutation({ run: () => gate.promise });
		resource.setProject("p2");
		resource.setProject("p1");
		gate.resolve();

		// 项目 id 一样，但世代号已经变了：只看 id 会把旧结果当成新项目的。
		expect(await running).toEqual({ kind: "stale" });
	});

	it("项目已切走时失败既不写快照也不弹提示", async () => {
		const source = createSource();
		const resource = createResource(source);
		let reject!: (error: Error) => void;
		const gate = new Promise<void>((_resolve, rej) => {
			reject = rej;
		});
		const notice = vi.fn();

		const running = resource.runMutation({ run: () => gate, onNotice: notice });
		resource.setProject("p2");
		reject(new Error("p1 exploded"));

		// 旧项目的错误写进新项目快照就是串味：用户会看到与自己无关的报错。
		expect(await running).toEqual({ kind: "stale" });
		expect(resource.getSnapshot().error).toBeNull();
		expect(notice).not.toHaveBeenCalled();
	});
});

describe("gitStatusResource 陈旧守卫", () => {
	it("项目切换后，旧项目迟到的 status 响应被丢弃", async () => {
		const source = createSource();
		const resource = createResource(source);
		const late = deferred<GitResourceGroups>();
		source.status.mockImplementationOnce(() => late.promise);
		source.status.mockImplementation(async () => groupsWith("p2.ts"));

		void resource.refresh();
		resource.setProject("p2");
		await vi.advanceTimersByTimeAsync(0);
		expect(source.status).toHaveBeenLastCalledWith("p2");
		expect(resource.getSnapshot().groups.workingTree[0].path).toBe("p2.ts");

		// 旧请求晚到：不能把 p2 的列表覆盖成 p1 的。
		late.resolve(groupsWith("p1.ts"));
		await vi.advanceTimersByTimeAsync(0);
		expect(resource.getSnapshot().groups.workingTree[0].path).toBe("p2.ts");
	});

	it("静默响应落地时保留旧引用（内容未变不触发重渲染）", async () => {
		const source = createSource();
		const resource = createResource(source);
		await resource.refresh();
		const before = resource.getSnapshot().groups;

		await resource.refresh({ silent: true });
		expect(resource.getSnapshot().groups).toBe(before);
	});

	it("内容未变时整份快照引用不变（useSyncExternalStore 才不会重渲染资源树）", async () => {
		const source = createSource();
		const resource = createResource(source);
		await resource.refresh();
		await resource.refreshBranches();
		const before = resource.getSnapshot();
		const listener = vi.fn();
		resource.subscribe(listener);

		// 一次什么都没改的轮询周期：status 内容相同、分支相同。
		await resource.refresh({ silent: true });
		await resource.refreshBranches();

		expect(resource.getSnapshot()).toBe(before);
		expect(listener).not.toHaveBeenCalled();
	});

	it("更新的非静默刷新作废更早发出的响应（请求号，而非只有世代号）", async () => {
		const source = createSource();
		const resource = createResource(source);
		const older = deferred<GitResourceGroups>();
		const newer = deferred<GitResourceGroups>();
		source.status.mockImplementationOnce(() => older.promise);
		source.status.mockImplementationOnce(() => newer.promise);

		const first = resource.refresh();
		const second = resource.refresh();
		newer.resolve(groupsWith("new.ts"));
		await second;
		older.resolve(groupsWith("old.ts"));
		await first;

		// 世代号没变（同一项目）：只有请求号能挡住这次倒灌。
		expect(resource.getSnapshot().groups.workingTree[0].path).toBe("new.ts");
		expect(resource.getSnapshot().loading).toBe(false);
	});

	it("本地采纳的分支结果作废旧的在途分支读取", async () => {
		const source = createSource();
		const resource = createResource(source);
		const late = deferred<{ current: string; branches: string[] }>();
		source.branches.mockImplementationOnce(() => late.promise);

		void resource.refreshBranches();
		// checkout 成功：面板直接采纳 App 返回的分支事实。
		resource.setBranchInfo({ current: "feature", branches: ["main", "feature"] });
		late.resolve({ current: "main", branches: ["main"] });
		await vi.advanceTimersByTimeAsync(0);

		expect(resource.getSnapshot().branchInfo.current).toBe("feature");
	});

	it("force 刷新不被在途读取合并（mutation 后的意图刷新）", async () => {
		const source = createSource();
		const resource = createResource(source);
		const late = deferred<{ current: string; branches: string[] }>();
		source.branches.mockImplementationOnce(() => late.promise);
		source.branches.mockImplementation(async () => ({
			current: "main",
			branches: ["main"],
		}));

		void resource.refreshBranches();
		void resource.refreshBranches({ force: true });
		await vi.advanceTimersByTimeAsync(0);

		// 普通触发合并进在途读取；force 必须真的重开一次 IPC。
		expect(source.branches).toHaveBeenCalledTimes(2);
		late.resolve({ current: "main", branches: ["main"] });
		await vi.advanceTimersByTimeAsync(0);
	});

	it("非静默失败的分类由 probe 回答，静默失败不动已有数据", async () => {
		const source = createSource();
		const resource = createResource(source);
		await resource.refresh();
		expect(resource.getSnapshot().groups.workingTree[0].path).toBe("a.ts");

		source.status.mockRejectedValueOnce(new Error("boom"));
		source.probe.mockResolvedValueOnce({ gitAvailable: true, isRepo: false });
		await resource.refresh();
		expect(resource.getSnapshot().notAGitRepo).toBe(true);
		expect(resource.getSnapshot().gitNotInstalled).toBe(false);
		expect(resource.getSnapshot().loading).toBe(false);
		// 非静默失败不展示过期列表（既有语义）。
		expect(resource.getSnapshot().groups.workingTree).toEqual([]);

		source.status.mockRejectedValueOnce(new Error("boom"));
		const groupsBefore = resource.getSnapshot().groups;
		const errorBefore = resource.getSnapshot().error;
		await resource.refresh({ silent: true });
		expect(resource.getSnapshot().groups).toBe(groupsBefore);
		expect(resource.getSnapshot().error).toBe(errorBefore);
	});
});
