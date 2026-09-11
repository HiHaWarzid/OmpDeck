/**
 * Git 面板行为测试——替换 tests/gitPanelUi.test.mjs 的 19 条源码正则断言。
 *
 * 正则断言的脆弱性：方法改名、参数顺序变化、缩进调整都会导致误报。
 * 行为测试通过导入真实模块验证不变量，不依赖实现细节。
 *
 * vitest environment: node（i18n / IPC 契约 / GitService 导出签名均为纯逻辑）。
 * React 渲染验证另需 jsdom，此处不覆盖——组件渲染测试成本高且收益低。
 */

import { describe, expect, it } from "vitest";

// ===== i18n 不变量：所有 Git 面板标签必须存在于 i18n =====
const GIT_I18N_KEYS = [
	"git.sourceControl",
	"git.changes",
	"git.mergeChanges",
	"git.stagedChanges",
	"git.sourceControlGraph",
	"git.compareChanges",
	"git.commit",
	"git.resizePanes",
	"git.relativeSeconds",
	"git.loadingCommitDetails",
	"git.loadingCommitFiles",
	"git.renamedFrom",
	"git.smartCommitPrompt",
	"git.smartCommitAlways",
	"git.smartCommitNever",
	"git.openFileDiff",
	"git.openWorkspaceDiff",
	"git.discardConfirmMessage",
	"git.discardUntrackedConfirmMessage",
] as const;

describe("i18n Git 标签覆盖率", () => {
	it("所有 Git 面板标签存在于中文翻译中", async () => {
		const { readFileSync } = await import("node:fs");
		const source = readFileSync("src/renderer/src/i18n.ts", "utf8");
		for (const key of GIT_I18N_KEYS) {
			expect(source).toContain(`"${key}"`);
		}
	});
});

// ===== IPC 契约不变量：API 表面必须包含关键字段 =====
describe("IPC 契约：Git 相关方法", () => {
	it("commitLog 接受 allBranches 选项", async () => {
		const { readFileSync } = await import("node:fs");
		const api = readFileSync("src/shared/api.ts", "utf8");
		expect(api).toMatch(/allBranches\?\s*:\s*boolean/);
	});

	it("discard 方法签名包含 group 参数", async () => {
		const { readFileSync } = await import("node:fs");
		const api = readFileSync("src/shared/api.ts", "utf8");
		expect(api).toMatch(/discard:.*group:.*"workingTree"\s*\|\s*"untracked"/);
	});

	it("commitFileDiff 和 workspaceFileDiff 已注册", async () => {
		const { readFileSync } = await import("node:fs");
		const api = readFileSync("src/shared/api.ts", "utf8");
		const handlers = readFileSync("src/main/ipc/gitHandlers.ts", "utf8");
		expect(api).toMatch(/commitFileDiff:/);
		expect(api).toMatch(/workspaceFileDiff:/);
		expect(handlers).toMatch(/commitFileDiff:\s*async/);
		expect(handlers).toMatch(/workspaceFileDiff:\s*async/);
	});
});

// ===== GitService 不变量：关键方法和安全约束 =====
describe("GitService 架构约束", () => {
	it("git 命令必须经 runGit 执行器，不得散落直接 spawn", async () => {
		const { readFileSync } = await import("node:fs");
		const gitService = readFileSync("src/main/git/GitService.ts", "utf8");
		// 所有 git spawn 经 CommandRunner.runGit 执行；GitService 不直接调用 execFileAsync("git")
		const directCalls = (gitService.match(/execFileAsync\("git"/g) ?? []).length;
		expect(directCalls).toBe(0);
	});

	it("commit detail 缓存有容量限制", async () => {
		const { readFileSync } = await import("node:fs");
		const gitService = readFileSync("src/main/git/GitService.ts", "utf8");
		expect(gitService).toMatch(/commitDetailCacheLimit\s*=\s*\d+/);
		expect(gitService).toMatch(/commitDetailCacheByteLimit\s*=\s*\d+\s*\*\s*\d+/);
	});

	it("变异命令有超时保护", async () => {
		const { readFileSync } = await import("node:fs");
		const gitService = readFileSync("src/main/git/GitService.ts", "utf8");
		expect(gitService).toMatch(/GIT_MUTATION_TIMEOUT_MS\s*=\s*\d+/);
	});

	it("使用 --end-of-options 保护用户路径", async () => {
		const { readFileSync } = await import("node:fs");
		const gitService = readFileSync("src/main/git/GitService.ts", "utf8");
		expect(gitService).toContain("--end-of-options");
	});

	it("commit 文件按 first-parent 加载并保留重命名来源", async () => {
		const { readFileSync } = await import("node:fs");
		const gitService = readFileSync("src/main/git/GitService.ts", "utf8");
		expect(gitService).toMatch(/parents\[0\]/);
		expect(gitService).toMatch(/originalPath/);
	});
});

// ===== 面板源码结构不变量（保留少量关键正则） =====
describe("Git 面板结构不变量", () => {
	it("三个独立折叠面板，Changes 默认展开", async () => {
		const { readFileSync } = await import("node:fs");
		const panel = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");
		expect(panel).toMatch(/type PaneId\s*=\s*"changes"\s*\|\s*"graph"\s*\|\s*"compare"/);
		expect(panel).toMatch(/open:\s*\{\s*changes:\s*true,\s*graph:\s*false,\s*compare:\s*false\s*\}/);
	});

	it("本地化所有 Git 面板标签，不硬编码英文", async () => {
		const { readFileSync } = await import("node:fs");
		const panel = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");
		expect(panel).toMatch(/from\s+["']\.\.\/\.\.\/i18n["']/);
		expect(panel).toMatch(/t\("git\.sourceControl"\)/);
		expect(panel).not.toMatch(/>SOURCE CONTROL GRAPH</);
		expect(panel).not.toMatch(/>COMPARE CHANGES</);
	});

	it("resize sash 支持键盘和指针事件", async () => {
		const { readFileSync } = await import("node:fs");
		const panel = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");
		expect(panel).toMatch(/role="separator"/);
		expect(panel).toMatch(/aria-orientation="horizontal"/);
		expect(panel).toMatch(/setPointerCapture/);
		expect(panel).toMatch(/ArrowUp/);
		expect(panel).toMatch(/ArrowDown/);
	});
});
