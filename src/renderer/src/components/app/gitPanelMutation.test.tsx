// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitPanel } from "./GitPanel";
import { setI18nLocale, t } from "../../i18n";
import { GitStatus, type GitResource } from "../../../../shared/types";

/**
 * 面板侧 mutation 接线（commit 失败与项目切换）。
 *
 * module 的行为契约在 `gitStatusResource.test.ts` 里逐条钉住；这里只钉**接线**：
 * 面板把 spinner、错误提示、项目 id 交给 `runMutation` 之后，用户看到的结果是否仍然
 * 正确。真实故障形态是「提交失败但按钮永久转圈」和「跑到一半切项目，spinner 卡住」。
 */
const resource: GitResource = {
	path: "/repo/a.ts",
	status: GitStatus.MODIFIED,
	letter: "M",
};

type Facade = {
	status: () => Promise<{
		merge: GitResource[];
		index: GitResource[];
		workingTree: GitResource[];
		untracked: GitResource[];
	}>;
	branches: () => Promise<{ current: string; branches: string[] }>;
	probe: () => Promise<{ available: boolean }>;
	commitLog: () => Promise<{ commits: never[]; hasMore: boolean }>;
	commitDetail: () => Promise<null>;
	branchCompare: () => Promise<null>;
	stage: (projectId: string, paths: string[]) => Promise<void>;
	unstage: (projectId: string, paths: string[]) => Promise<void>;
	discard: () => Promise<void>;
	commit: (projectId: string, message: string) => Promise<void>;
	cherryPick: () => Promise<void>;
	revert: () => Promise<void>;
	reset: () => Promise<void>;
	dropCommit: () => Promise<void>;
	generateCommitMessage: () => Promise<string>;
	init: () => Promise<void>;
	push: (projectId: string) => Promise<void>;
	pull: (projectId: string) => Promise<void>;
};

function createGit(overrides: Partial<Facade> = {}): Facade {
	return {
		status: async () => ({
			merge: [],
			index: [resource],
			workingTree: [],
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
		...overrides,
	};
}

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

/** 等 status/branches 的 promise 落地并完成重渲染。 */
async function settle(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

function renderPanel(git: Facade, projectId = "p1") {
	return act(async () => {
		root.render(
			<GitPanel
				projectId={projectId}
				projectRoot="/repo"
				git={git as never}
				onOpenCommitFileDiff={() => undefined}
				onOpenWorkspaceFileDiff={() => undefined}
			/>,
		);
	});
}

function commitButton(): HTMLButtonElement {
	const button = container.querySelector<HTMLButtonElement>(".git-commit-btn");
	if (!button) throw new Error("commit button not rendered");
	return button;
}

function pushButton(): HTMLButtonElement {
	const button = container.querySelector<HTMLButtonElement>(
		`.git-action-btn[title="${t("git.push")}"]`,
	);
	if (!button) throw new Error("push button not rendered");
	return button;
}

function typeCommitMessage(message: string): void {
	const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
	if (!textarea) throw new Error("commit textarea not rendered");
	const setter = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value",
	)?.set;
	act(() => {
		setter?.call(textarea, message);
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("GitPanel mutation 接线", () => {
	it("提交失败：错误落到面板，按钮不留在 loading", async () => {
		const git = createGit({
			commit: async () => {
				throw new Error("nothing to commit");
			},
		});
		await renderPanel(git);
		await settle();
		await typeCommitMessage("feat: x");

		await act(async () => {
			commitButton().click();
			await Promise.resolve();
			await Promise.resolve();
		});
		await settle();

		// 用户必须看到失败原因，而不是一个永久转圈的按钮。
		expect(container.textContent).toContain("nothing to commit");
		expect(commitButton().disabled).toBe(false);
		expect(container.querySelector(".git-commit-btn .git-spin")).toBeNull();
	});

	it("提交跑到一半切换项目：新项目不被旧项目的门卡住", async () => {
		let releaseCommit!: () => void;
		const commitGate = new Promise<void>((resolve) => {
			releaseCommit = resolve;
		});
		const commits: string[] = [];
		const git = createGit({
			commit: (projectId) => {
				commits.push(projectId);
				return projectId === "p1" ? commitGate : Promise.resolve();
			},
		});
		await renderPanel(git);
		await settle();
		await typeCommitMessage("feat: y");
		await act(async () => {
			commitButton().click();
			await Promise.resolve();
		});
		expect(commitButton().textContent).toContain("正在提交");

		// 切换项目：module 侧会作废旧 ticket，旧 mutation 的收尾不得再碰这道门。
		await renderPanel(git, "p2");
		await settle();
		await typeCommitMessage("feat: p2");
		await act(async () => {
			commitButton().click();
			await Promise.resolve();
			await Promise.resolve();
		});

		// 关键：p2 的提交必须真的发出去了。旧收尾若解锁/占门搞混，这里会是 skipped。
		expect(commits).toEqual(["p1", "p2"]);

		await act(async () => {
			releaseCommit();
			await Promise.resolve();
			await Promise.resolve();
		});
		// p1 的提交迟到落地：不得把 p2 的按钮留在 loading。
		expect(commitButton().textContent).not.toContain("正在提交");
		expect(container.querySelector(".git-commit-btn .git-spin")).toBeNull();
	});

	it("推送跑到一半切换项目：push spinner 不复活在旧状态上", async () => {
		let releasePush!: () => void;
		const pushGate = new Promise<void>((resolve) => {
			releasePush = resolve;
		});
		const pushes: string[] = [];
		const git = createGit({
			push: (projectId) => {
				pushes.push(projectId);
				return projectId === "p1" ? pushGate : Promise.resolve();
			},
		});
		await renderPanel(git);
		await settle();

		await act(async () => {
			pushButton().click();
			await Promise.resolve();
		});
		expect(pushButton().querySelector(".git-spin"), "推送中必须显示转圈").not.toBeNull();

		// 跑到一半切项目：runMutation 因世代变化返回 stale，而 stale 刻意不复位 spinner
		// （复位可能误清新项目刚亮的那个）。项目切换是它唯一的复位点。
		await renderPanel(git, "p2");
		await settle();
		expect(pushButton().disabled, "切项目后旧 spinner 必须由切换重置").toBe(false);
		expect(pushButton().querySelector(".git-spin")).toBeNull();

		// 旧项目的迟到收尾也不得把 spinner 重新点亮。
		await act(async () => {
			releasePush();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(pushButton().querySelector(".git-spin")).toBeNull();
		expect(pushes).toEqual(["p1"]);
	});
});
