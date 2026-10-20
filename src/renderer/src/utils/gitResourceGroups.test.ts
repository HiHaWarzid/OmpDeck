import { describe, it, expect } from "vitest";
import { GitStatus } from "../../../shared/types";
import type { GitResource, GitResourceGroups } from "../../../shared/types";
import { sameResourceGroups } from "./gitResourceGroups";

function resource(path: string, overrides: Partial<GitResource> = {}): GitResource {
	return {
		path,
		status: GitStatus.MODIFIED,
		letter: "M",
		...overrides,
	};
}

function groups(overrides: Partial<GitResourceGroups> = {}): GitResourceGroups {
	return {
		merge: [],
		index: [],
		workingTree: [],
		untracked: [],
		...overrides,
	};
}

/**
 * 轮询结果落地前的等价判断。两个方向都必须是「用户可见状态不变才复用旧引用」：
 * 误判为相等 → 界面吞掉真实变更；误判为不等 → 整棵数千行资源树白重渲染。
 */
describe("sameResourceGroups", () => {
	it("同一份内容（新对象）判定为等价", () => {
		const before = groups({
			workingTree: [resource("a.ts"), resource("b.ts", { letter: "D" })],
			index: [resource("c.ts", { status: GitStatus.INDEX_MODIFIED })],
		});
		const after = groups({
			workingTree: [resource("a.ts"), resource("b.ts", { letter: "D" })],
			index: [resource("c.ts", { status: GitStatus.INDEX_MODIFIED })],
		});
		expect(sameResourceGroups(before, after)).toBe(true);
		expect(sameResourceGroups(before, before)).toBe(true);
	});

	it("文件在组之间移动、增删条目都判定为不等价", () => {
		const before = groups({ workingTree: [resource("a.ts")] });
		expect(sameResourceGroups(before, groups({ index: [resource("a.ts")] }))).toBe(false);
		expect(sameResourceGroups(before, groups({ workingTree: [] }))).toBe(false);
		expect(
			sameResourceGroups(
				before,
				groups({ workingTree: [resource("a.ts"), resource("b.ts")] }),
			),
		).toBe(false);
	});

	it("路径 / 状态 / 字母 / 重命名来源任一变化都判定为不等价", () => {
		const before = groups({ workingTree: [resource("a.ts", { oldPath: "old-a.ts" })] });
		expect(
			sameResourceGroups(
				before,
				groups({ workingTree: [resource("b.ts", { oldPath: "old-a.ts" })] }),
			),
		).toBe(false);
		expect(
			sameResourceGroups(
				before,
				groups({
					workingTree: [
						resource("a.ts", {
							status: GitStatus.UNTRACKED,
							oldPath: "old-a.ts",
						}),
					],
				}),
			),
		).toBe(false);
		expect(
			sameResourceGroups(
				before,
				groups({
					workingTree: [resource("a.ts", { letter: "R", oldPath: "old-a.ts" })],
				}),
			),
		).toBe(false);
		expect(
			sameResourceGroups(before, groups({ workingTree: [resource("a.ts")] })),
		).toBe(false);
	});
});
