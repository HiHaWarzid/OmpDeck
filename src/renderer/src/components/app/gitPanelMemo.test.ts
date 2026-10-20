import { describe, it, expect } from "vitest";
import type { GitResourceGroupType } from "../../../../shared/types";
import { GitPanel } from "./GitPanel";
import { ToolCard, ToolGroupCard } from "./tools/ToolCards";
import type { ChatMessage } from "../../../../shared/types";

/**
 * memo 判据的契约测试（无需渲染）。
 *
 * 这是渲染线程被压满那类故障的直接回归点：GitPanel 的变更列表一次渲染全部条目
 * （大仓库实测 3000+ 行、单次 200ms 以上），只要面板跟着 App 重渲染就会把主线程打满，
 * 用户侧表现为整个界面点不动。防止回归的两件事都在这里钉住：
 * 1. 面板必须保持 memo（没有 memo 时 comparator 不存在，测试直接失败）；
 * 2. comparator 必须只比较数据入参——回调由 App 以稳定引用传入，若把回调算进判据，
 *    引用变化会让 memo 永久失效，冻结立即回来。
 */
type Comparator = (previous: never, next: never) => boolean;

function comparatorOf(component: unknown): Comparator {
	const compare = (component as { compare?: Comparator }).compare;
	expect(typeof compare, "component must stay memoized").toBe("function");
	return compare as Comparator;
}

const callbacks = () => ({
	onOpenCommitFileDiff: () => undefined,
	onOpenWorkspaceFileDiff: () => undefined,
	onSwitchBranch: async () => undefined,
	onCreateBranch: async () => undefined,
});

// git 门面与分支信息在 App 侧是稳定引用（store/useMemo），只有回调每次渲染重建。
const git = {} as never;
const branchInfo = { current: "main", branches: ["main"] };

function gitPanelProps(overrides: Record<string, unknown> = {}) {
	return {
		projectId: "p1",
		projectRoot: "D:/repo",
		git,
		initialBranchInfo: branchInfo,
		...callbacks(),
		...overrides,
	};
}

describe("GitPanel memo 判据", () => {
	it("数据入参不变时，回调引用变化不算变更（App 每次渲染都会重建函数）", () => {
		const compare = comparatorOf(GitPanel);
		const previous = gitPanelProps();
		const next = gitPanelProps({ ...callbacks() });
		expect(compare(previous as never, next as never)).toBe(true);
	});

	it("项目 / 根目录 / git 门面 / 分支信息变化时必须重渲染", () => {
		const compare = comparatorOf(GitPanel);
		const previous = gitPanelProps();
		const changed: Record<string, unknown>[] = [
			{ projectId: "p2" },
			{ projectRoot: "D:/other" },
			{ git: {} },
			{ initialBranchInfo: { current: "dev", branches: ["main", "dev"] } },
		];
		for (const override of changed) {
			expect(
				compare(previous as never, gitPanelProps(override) as never),
				`change ${Object.keys(override)[0]} must re-render`,
			).toBe(false);
		}
	});

	it("工具卡片与工具组同样只按消息引用判定", () => {
		const message = { id: "m1", role: "tool", text: "ok" } as unknown as ChatMessage;
		const cardCompare = comparatorOf(ToolCard);
		expect(cardCompare({ message } as never, { message } as never)).toBe(true);
		expect(
			cardCompare({ message } as never, { message: { ...message } } as never),
		).toBe(false);

		const group = { id: "g1", messages: [message] };
		const groupCompare = comparatorOf(ToolGroupCard);
		// 每批 delta 都重建组容器（新对象、旧消息元素），逐元素比较才能跳过未变化的卡片
		expect(groupCompare({ group } as never, { group: { ...group } } as never)).toBe(true);
		expect(
			groupCompare(
				{ group } as never,
				{ group: { ...group, messages: [message, message] } } as never,
			),
		).toBe(false);
	});
});

// 只用于让类型检查确认分组枚举未参与判据比较。
export type _Unused = GitResourceGroupType;
