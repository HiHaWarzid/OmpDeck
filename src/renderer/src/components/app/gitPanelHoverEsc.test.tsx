// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitPanel } from "./GitPanel";
import { setI18nLocale } from "../../i18n";
import { registerDismissableLayer } from "../ui/dismissableLayer";
import { GitStatus, type CommitEntry } from "../../../../shared/types";

/**
 * 提交悬停卡片的 Esc 归属。
 *
 * 真实故障形态：卡片自己挂 `window.addEventListener("keydown")` 时，一次 Esc 会同时
 * 关掉卡片和它下面那层（设置页的 Radix Dialog、输入框的历史导航）。这里在卡片下面
 * 放一层真实的关闭层，断言 Esc 只消费卡片这一层，且卡片关掉后行离开的延迟关闭
 * 不会把「已关闭」状态带进下一次悬停。
 */
const commit: CommitEntry = {
	hash: "a".repeat(40),
	shortHash: "aaaaaaa",
	message: "hover target",
	authorName: "Smoke",
	authorEmail: "s@example.com",
	authorDate: Date.UTC(2026, 0, 1),
	parents: [],
	refNames: ["HEAD -> main"],
	graph: ["*"],
};

function gitFacade() {
	return {
		status: async () => ({
			merge: [],
			index: [{ path: "/repo/a.ts", status: GitStatus.MODIFIED, letter: "M" }],
			workingTree: [],
			untracked: [],
		}),
		branches: async () => ({ current: "main", branches: ["main"] }),
		probe: async () => ({ available: true }),
		commitLog: async () => [commit],
		commitDetail: async () => null,
		branchCompare: async () => null,
		stage: async () => undefined,
		unstage: async () => undefined,
		discard: async () => undefined,
		commit: async () => undefined,
		cherryPick: async () => undefined,
		revert: async () => undefined,
		reset: async () => undefined,
		dropCommit: async () => undefined,
		generateCommitMessage: async () => "",
		init: async () => undefined,
		push: async () => undefined,
		pull: async () => undefined,
	};
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
	// 历史面板默认折叠；直接把 graph 面板存成展开，免得测试去点折叠按钮。
	localStorage.setItem(
		"pideck:git-panel:p1:pane-state:v3",
		JSON.stringify({
			heights: { changes: 100, graph: 200, compare: 160 },
			open: { changes: false, graph: true, compare: false },
		}),
	);
	setI18nLocale("zh-CN");
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
});

async function renderPanel(): Promise<void> {
	await act(async () => {
		root.render(
			<GitPanel
				projectId="p1"
				projectRoot="/repo"
				git={gitFacade() as never}
				onOpenCommitFileDiff={() => undefined}
				onOpenWorkspaceFileDiff={() => undefined}
			/>,
		);
	});
	// status / branches / commitLog 的 promise 落地。
	for (let tick = 0; tick < 8; tick += 1) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

/** 悬停 500ms 后才打开卡片；mouseover 走 React 的 onMouseEnter 委托。 */
function hoverCommitRow(): void {
	const row = container.querySelector<HTMLButtonElement>(".git-history-row");
	if (!row) throw new Error("commit row not rendered");
	act(() => {
		row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
		vi.advanceTimersByTime(600);
	});
}

function pressEscape(): void {
	act(() => {
		document.body.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
		);
	});
}

describe("提交悬停卡片的 Esc", () => {
	it("Esc 只关卡片，不连带关闭它下面那层", async () => {
		await renderPanel();
		const underlying = document.createElement("div");
		document.body.appendChild(underlying);
		const dismissUnderlying = vi.fn();
		const unregister = registerDismissableLayer({
			getElement: () => underlying,
			onDismiss: dismissUnderlying,
		});

		hoverCommitRow();
		expect(document.getElementById("git-commit-hover")).not.toBeNull();

		pressEscape();

		expect(document.getElementById("git-commit-hover")).toBeNull();
		expect(dismissUnderlying).not.toHaveBeenCalled();
		unregister();
		underlying.remove();
	});

	it("Esc 之后再次悬停同一行仍能打开卡片", async () => {
		await renderPanel();

		hoverCommitRow();
		expect(document.getElementById("git-commit-hover")).not.toBeNull();
		pressEscape();
		expect(document.getElementById("git-commit-hover")).toBeNull();

		// 指针还停在行上：Esc 收起卡片后不能残留「指针在卡片内」的标记。
		const row = container.querySelector<HTMLButtonElement>(".git-history-row");
		act(() => {
			row?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
			row?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
			vi.advanceTimersByTime(600);
		});
		expect(document.getElementById("git-commit-hover")).not.toBeNull();
	});
});
