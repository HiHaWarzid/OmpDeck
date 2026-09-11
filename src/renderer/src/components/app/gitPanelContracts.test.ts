/**
 * Git 面板契约测试。
 *
 * 前身是 tests/gitPanelUi.test.mjs 的 19 条源码正则断言，随后又被写成
 * 「readFileSync 生产源码 + toMatch」的伪行为测试——方法改名、缩进调整、
 * 字符串换行都会误报，而真正的缺陷（键拼错、通道漏注册、丢弃语义写反）
 * 一个都抓不到。这里改为导入生产模块断言可观察契约。
 *
 * 已删除的部分（不再以正则钉住实现）：
 * - GitService 源码结构（runGit/超时常量/--end-of-options/缓存容量）：
 *   这些是实现细节，改由类型与 code review 保障；
 * - GitPanel JSX 结构（PaneId 联合、默认展开、role="separator"）：
 *   钉住的是渲染源码文本，不是用户可见行为。
 */

import { describe, expect, it } from "vitest";
import { ipcChannels, ipcTable } from "../../../../shared/ipc";
import { setI18nLocale, t } from "../../i18n";

/** Git 面板实际调用的文案键；缺任一个都会在界面上显示原始 key。 */
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
	it.each(["zh-CN", "en-US", "pseudo"] as const)(
		"%s 字典为每个 Git 标签提供译文",
		(locale) => {
			setI18nLocale(locale);
			for (const key of GIT_I18N_KEYS) {
				// t() 在键缺失时回退为键本身，因此「不等于键」就是「已翻译」。
				expect(t(key), `missing ${key} in ${locale}`).not.toBe(key);
			}
			// 复位，避免影响同进程内其它测试。
			setI18nLocale("en-US");
		},
	);
});

describe("Git IPC 接缝", () => {
	it("面板依赖的每个成员都在通道表中注册为 invoke", () => {
		const git = ipcTable.git as Record<string, { channel?: string; kind?: string }>;
		for (const member of [
			"commitLog",
			"commitFileDiff",
			"workspaceFileDiff",
			"discard",
			"stage",
			"unstage",
		]) {
			expect(git[member], `git.${member} missing from ipcTable`).toBeDefined();
			expect(git[member].kind).toBe("invoke");
		}
	});

	it("派生通道常量与表声明一致", () => {
		// 派生规则：`ns:member-name` → camelCase（见 shared/ipc.ts camelFromChannel）。
		expect(ipcChannels.gitCommitFileDiff).toBe("git:commit-file-diff");
		expect(ipcChannels.gitWorkspaceFileDiff).toBe("git:workspace-file-diff");
		expect(ipcChannels.gitDiscard).toBe("git:discard");
	});
});
