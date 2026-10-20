// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitPanel } from "./GitPanel";
import { setI18nLocale } from "../../i18n";
import { GitStatus, type GitResource } from "../../../../shared/types";

/**
 * 变更列表的行数上限（渲染规模回归）。
 *
 * 真实故障现场：3389 条变更全量渲染 → 4 万+ DOM 节点 → 单次按键提交/布局 1.1s。
 * 这里挂载真实的 GitPanel（假 git 门面），断言首屏只渲染一页资源行、并给出
 * 「加载更多」入口；这条断言能抓到「分页被绕过 / 预算算错」这类用户可见回归。
 */
const ROW_COUNT = 500;

function resources(): GitResource[] {
	return Array.from({ length: ROW_COUNT }, (_, index) => ({
		path: `/repo/dir${index % 4}/file${index}.ts`,
		status: GitStatus.MODIFIED,
		letter: "M",
	}));
}

const git = {
	status: async () => ({
		merge: [],
		index: [],
		workingTree: resources(),
		untracked: [],
	}),
	branches: async () => ({ current: "main", branches: ["main"] }),
	probe: async () => ({ available: true }),
	commitLog: async () => ({ commits: [], hasMore: false }),
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
} as never;

describe("GitPanel 变更列表渲染上限", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		localStorage.clear();
		setI18nLocale("zh-CN");
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it("首屏只渲染一页资源行，其余通过「加载更多」追加", async () => {
		await act(async () => {
			root.render(
				<GitPanel
					projectId="p1"
					projectRoot="/repo"
					git={git}
					onOpenCommitFileDiff={() => undefined}
					onOpenWorkspaceFileDiff={() => undefined}
				/>,
			);
		});
		// 等 status 的 promise 落地并完成重渲染
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		const rows = container.querySelectorAll(".git-resource-row");
		expect(rows.length).toBe(200);
		expect(container.textContent).toContain(`剩余 ${ROW_COUNT - 200} 条`);

		const loadMore = container.querySelector<HTMLButtonElement>(
			".git-load-more-btn",
		);
		expect(loadMore).not.toBeNull();
		await act(async () => {
			loadMore!.click();
		});
		expect(container.querySelectorAll(".git-resource-row").length).toBe(400);
	});
});
