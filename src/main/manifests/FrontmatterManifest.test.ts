import { homedir } from "node:os";
import { describe, it, expect } from "vitest";
import {
	SKILL_FILE,
	normalizeName,
	parseFrontmatter,
	resolveWslHome,
	serializeFrontmatter,
	setFrontmatterBoolean,
	setFrontmatterName,
	validateManifest,
} from "./FrontmatterManifest";

describe("parseFrontmatter", () => {
	it("解析标准 frontmatter 并保留多字段", () => {
		const parsed = parseFrontmatter("---\nname: test-kit\ndescription: a skill\n---\n\nbody");
		expect(parsed).toEqual({ name: "test-kit", description: "a skill" });
	});

	it("serialize → parse 往返一致", () => {
		const fm = { name: "my skill", description: "docs: line1 line2" };
		expect(parseFrontmatter(serializeFrontmatter(fm))).toEqual(fm);
	});

	it("无 frontmatter 时返回空对象（调用方兜底）", () => {
		expect(parseFrontmatter("# plain\n\nmarkdown")).toEqual({});
	});

	it("未闭合的 --- 块返回空对象", () => {
		expect(parseFrontmatter("---\nname: foo")).toEqual({});
	});

	it("--- 不在文件头部时不识别", () => {
		expect(parseFrontmatter("text\n---\nname: foo\n---")).toEqual({});
	});

	it("剥离值首尾的单/双引号各一个", () => {
		expect(parseFrontmatter("---\nname: \"quoted\"\n---\n")).toEqual({ name: "quoted" });
		expect(parseFrontmatter("---\nname: 'single'\n---\n")).toEqual({ name: "single" });
	});

	it("跳过无冒号行与空 key，支持 CRLF", () => {
		const parsed = parseFrontmatter("---\r\nno colon here\r\n: orphan\r\nname: ok\r\n---");
		expect(parsed).toEqual({ name: "ok" });
	});

	it("空 value 保留为空字符串", () => {
		expect(parseFrontmatter("---\nname:\n---")).toEqual({ name: "" });
	});

	it("按第一个冒号切分，值内冒号保留", () => {
		expect(parseFrontmatter("---\ndescription: docs: details\n---")).toEqual({
			description: "docs: details",
		});
	});
});

describe("serializeFrontmatter", () => {
	it("序列化格式与既有 create() 产出格式一致（LF，无尾部空行）", () => {
		expect(serializeFrontmatter({ name: "x", description: "d" })).toBe("---\nname: x\ndescription: d\n---");
	});

	it("null / undefined 值被过滤", () => {
		expect(serializeFrontmatter({ name: "x", empty: "" } as Record<string, string>)).toBe(
			"---\nname: x\nempty: \n---",
		);
	});
});

describe("setFrontmatterName / setFrontmatterBoolean", () => {
	it("原位替换已有 name 字段，保留其它行", () => {
		const raw = "---\ndescription: keep\nname: old\n---\n# old";
		expect(setFrontmatterName(raw, "new")).toBe("---\ndescription: keep\nname: new\n---\n# old");
	});

	it("无 name 字段时不追加（仅替换语义，与既有实现一致）", () => {
		expect(setFrontmatterName("---\ndescription: d\n---", "new")).toBe("---\ndescription: d\n---");
	});

	it("无 frontmatter 时补最小块", () => {
		expect(setFrontmatterName("# body", "new")).toBe("---\nname: new\n---\n\n# body");
	});

	it("布尔字段：存在则替换，缺省追加", () => {
		expect(setFrontmatterBoolean("---\ndisable-model-invocation: false\n---", "disable-model-invocation", true)).toBe(
			"---\ndisable-model-invocation: true\n---",
		);
		expect(setFrontmatterBoolean("---\nname: x\n---", "disable-model-invocation", true)).toBe(
			"---\nname: x\ndisable-model-invocation: true\n---",
		);
	});

	it("布尔字段无 frontmatter 时补块", () => {
		expect(setFrontmatterBoolean("body", "k", false)).toBe("---\nk: false\n---\n\nbody");
	});
});

describe("normalizeName", () => {
	it("去除首尾空白并转小写", () => {
		expect(normalizeName("  My Cool Skill  ")).toBe("my-cool-skill");
	});

	it("斜杠等符号替换为连字符", () => {
		expect(normalizeName("my/skill\\name")).toBe("my-skill-name");
	});

	it("连续连字符合并、首尾连字符去除", () => {
		expect(normalizeName("--foo--bar--")).toBe("foo-bar");
	});

	it("保留 Unicode 字母（中文等非拉丁文字）", () => {
		expect(normalizeName("测试技能")).toBe("测试技能");
		expect(normalizeName("héllo wörld")).toBe("héllo-wörld");
	});

	it("纯符号输入得到空串", () => {
		expect(normalizeName("!!!")).toBe("");
	});

	it("已规范名称保持不变", () => {
		expect(normalizeName("foo-bar")).toBe("foo-bar");
	});
});

describe("resolveWslHome", () => {
	it("有 WSL 环境时注入 windowsHome", () => {
		const environment = {
			distro: "Ubuntu",
			user: "me",
			linuxHome: "/home/me",
			windowsHome: "\\\\wsl$\\Ubuntu\\home\\me",
		};
		expect(resolveWslHome("C:\\Users\\me", environment)).toBe("\\\\wsl$\\Ubuntu\\home\\me");
	});

	it("无 WSL 环境时原样返回传入 home", () => {
		expect(resolveWslHome("C:\\Users\\me", null)).toBe("C:\\Users\\me");
	});

	it("缺省参数：home 默认 Windows homedir，环境为空时行为不变", () => {
		expect(resolveWslHome()).toBe(homedir());
		expect(resolveWslHome(undefined, null)).toBe(homedir());
	});
});

describe("validateManifest", () => {
	it("合法 skill 清单无警告", () => {
		expect(validateManifest({ name: "test-kit", description: "desc" })).toEqual([]);
	});

	it("缺 name / description 分别报 warning", () => {
		const warnings = validateManifest({});
		expect(warnings).toContain("缺少 name");
		expect(warnings).toContain("缺少 description，omp 不会加载该 skill");
	});

	it("name 字符集：Unicode 字母/数字/单个连字符通过，非法字符报错", () => {
		expect(validateManifest({ name: "测试技能", description: "d" })).toEqual([]);
		expect(validateManifest({ name: "bad name", description: "d" })).toContain(
			"name 只能包含字母（含中文等）、数字和单个连字符",
		);
	});

	it("长度上限：name 64 / description 1024", () => {
		expect(validateManifest({ name: "a".repeat(65), description: "d" })).toContain("name 超过 64 个字符");
		expect(validateManifest({ name: "ok", description: "d".repeat(1025) })).toContain(
			"description 超过 1024 个字符",
		);
	});

	it("prompt 清单只要求 description（name 来自文件名）", () => {
		expect(validateManifest({ description: "d" }, "prompt")).toEqual([]);
		expect(validateManifest({}, "prompt")).toContain("缺少 description");
	});

	it("SKILL_FILE 与两处 manager 常量一致", () => {
		expect(SKILL_FILE).toBe("SKILL.md");
	});
});