import { describe, expect, it } from "vitest";
import { GitStatus, type GitResource } from "../../../shared/types";
import {
	FILE_TREE_PAGE_SIZE,
	buildFileTreeView,
	groupGitResourcesByDir,
	sortGitDirs,
} from "./gitFileTree";

/** 构造只关心路径的资源：视图逻辑只看 path，status/letter 原样透传。 */
function resource(path: string): GitResource {
	return { path, status: GitStatus.MODIFIED, letter: "M" };
}

const ROOT = "/repo";

describe("groupGitResourcesByDir", () => {
	it("按相对目录分组并保留资源顺序", () => {
		const byDir = groupGitResourcesByDir(
			[
				resource(`${ROOT}/src/b.ts`),
				resource(`${ROOT}/README.md`),
				resource(`${ROOT}/src/a.ts`),
			],
			ROOT,
		);
		expect([...byDir.keys()].sort()).toEqual(["", "src"]);
		expect(byDir.get("src")!.map((r) => r.path)).toEqual([
			`${ROOT}/src/b.ts`,
			`${ROOT}/src/a.ts`,
		]);
	});

	it("Windows 分隔符与大小写不同的根目录都能归一化", () => {
		const byDir = groupGitResourcesByDir(
			[resource("D:\\Work\\repo\\src\\a.ts")],
			"D:\\Work\\repo\\",
		);
		expect([...byDir.keys()]).toEqual(["src"]);
	});

	it("不传根目录时按绝对路径分组", () => {
		const byDir = groupGitResourcesByDir([resource(`${ROOT}/src/a.ts`)]);
		expect([...byDir.keys()]).toEqual(["/repo/src"]);
	});
});

describe("sortGitDirs", () => {
	it("根目录排最前，其余按字典序", () => {
		expect(sortGitDirs(["src/b", "", "src/a"])).toEqual([
			"",
			"src/a",
			"src/b",
		]);
	});
});

describe("buildFileTreeView", () => {
	it("总行数不超过预算，剩余行计入 hidden", () => {
		const resources = Array.from({ length: 500 }, (_, i) =>
			resource(`${ROOT}/dir${String(i % 5)}/f${i}.ts`),
		);
		const view = buildFileTreeView(resources, ROOT, new Set(), 200);
		const rendered = view.sections.reduce(
			(sum, section) => sum + section.resources.length,
			0,
		);
		expect(rendered).toBe(200);
		expect(view.hidden).toBe(300);
		// 目录顺序与完整渲染一致：预算按目录顺序消耗
		expect(view.sections[0].dir).toBe("dir0");
	});

	it("目录头计数始终是全量，不是本页行数", () => {
		const resources = Array.from({ length: 250 }, (_, i) =>
			resource(`${ROOT}/src/f${i}.ts`),
		);
		const view = buildFileTreeView(resources, ROOT, new Set(), 100);
		expect(view.sections).toHaveLength(1);
		expect(view.sections[0].total).toBe(250);
		expect(view.sections[0].resources).toHaveLength(100);
		expect(view.hidden).toBe(150);
	});

	it("折叠目录只输出目录头，不消耗预算也不计入 hidden", () => {
		const resources = [
			...Array.from({ length: 150 }, (_, i) =>
				resource(`${ROOT}/big/f${i}.ts`),
			),
			resource(`${ROOT}/small/a.ts`),
		];
		const view = buildFileTreeView(
			resources,
			ROOT,
			new Set(["big"]),
			100,
		);
		const big = view.sections.find((s) => s.dir === "big")!;
		expect(big.resources).toEqual([]);
		expect(big.total).toBe(150);
		// 折叠的 150 行是用户主动隐藏的，不算「还有更多」
		expect(view.hidden).toBe(0);
		const small = view.sections.find((s) => s.dir === "small")!;
		expect(small.resources.map((r) => r.path)).toEqual([
			`${ROOT}/small/a.ts`,
		]);
	});

	it("预算耗尽后不再输出后续目录头（由加载更多统一承载）", () => {
		const resources = [
			resource(`${ROOT}/a/1.ts`),
			resource(`${ROOT}/a/2.ts`),
			resource(`${ROOT}/b/1.ts`),
		];
		const view = buildFileTreeView(resources, ROOT, new Set(), 2);
		expect(view.sections.map((s) => s.dir)).toEqual(["a"]);
		expect(view.hidden).toBe(1);
	});

	it("单根目录不输出目录头", () => {
		const view = buildFileTreeView(
			[resource(`${ROOT}/a.ts`)],
			ROOT,
			new Set(),
			FILE_TREE_PAGE_SIZE,
		);
		expect(view.singleRoot).toBe(true);
		expect(view.sections[0].dir).toBe("");
	});

	it("目录数远大于行预算时也不会超量渲染（真实仓库形态：3389 条 / 744 个目录）", () => {
		const resources: GitResource[] = [];
		for (let dir = 0; dir < 744; dir += 1) {
			for (let file = 0; file < 5; file += 1) {
				resources.push(resource(`${ROOT}/d${dir}/f${file}.ts`));
			}
		}
		const view = buildFileTreeView(resources, ROOT, new Set(), 200);
		const rendered = view.sections.reduce(
			(sum, section) => sum + section.resources.length,
			0,
		);
		expect(rendered).toBe(200);
		expect(view.hidden).toBe(resources.length - 200);
	});
});
