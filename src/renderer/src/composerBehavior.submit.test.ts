import { describe, expect, it } from "vitest";
import {
	decideComposerSubmit,
	expandPromptTemplates,
	parseCompactCommand,
} from "./composerBehavior";

const base = {
	isOverride: false,
	agentStarting: false,
	hasTarget: true,
	message: "hello",
	imageCount: 0,
};

describe("parseCompactCommand", () => {
	it("裸 /compact 命中，prompt 为空串", () => {
		expect(parseCompactCommand("/compact")).toEqual({ compactPrompt: "" });
	});

	it("携带压缩提示时剥离命令前缀", () => {
		expect(parseCompactCommand("/compact focus on auth")).toEqual({
			compactPrompt: "focus on auth",
		});
	});

	it("大小写不敏感", () => {
		expect(parseCompactCommand("/COMPACT x")?.compactPrompt).toBe("x");
	});

	it("非前缀出现不命中（/compacts、行中 /compact）", () => {
		expect(parseCompactCommand("/compacts")).toBeUndefined();
		expect(parseCompactCommand("hi /compact")).toBeUndefined();
	});
});

describe("decideComposerSubmit", () => {
	it("starting 时非 override 直接 ignore（override 绕过）", () => {
		expect(
			decideComposerSubmit({ ...base, agentStarting: true }),
		).toEqual({ action: "ignore", reason: "starting" });
		expect(
			decideComposerSubmit({ ...base, agentStarting: true, isOverride: true }).action,
		).toBe("submit");
	});

	it("无 target 与空内容 ignore（有图则放行）", () => {
		expect(decideComposerSubmit({ ...base, hasTarget: false }).action).toBe("ignore");
		expect(decideComposerSubmit({ ...base, message: "   " }).action).toBe("ignore");
		expect(
			decideComposerSubmit({ ...base, message: "   ", imageCount: 1 }).action,
		).toBe("submit");
	});

	it("/compact 命中压缩路线", () => {
		expect(
			decideComposerSubmit({ ...base, message: "/compact focus" }),
		).toEqual({ action: "compact", compactPrompt: "focus" });
	});

	it("空模板拦截，不发送", () => {
		expect(
			decideComposerSubmit({
				...base,
				message: "/emptyTpl",
				emptyTemplateName: "emptyTpl",
			}),
		).toEqual({ action: "block-empty-template", templateName: "emptyTpl" });
	});

	it("忙闲都直发：待投递队列归 omp 服务端", () => {
		expect(decideComposerSubmit(base)).toEqual({ action: "submit" });
	});

	it("commandRoutes=false 跳过命令路线（对应 sendPromptAsFollowUp）", () => {
		expect(
			decideComposerSubmit({
				...base,
				message: "/compact focus",
				commandRoutes: false,
			}),
		).toEqual({ action: "submit" });
		expect(
			decideComposerSubmit({
				...base,
				message: "/emptyTpl",
				emptyTemplateName: "emptyTpl",
				commandRoutes: false,
			}),
		).toEqual({ action: "submit" });
	});
});

describe("expandPromptTemplates empty body", () => {
	it("正文为空的模板保留原样并上报 emptyTemplateName", () => {
		const templates = [
			{ name: "emptyTpl", path: "/t/emptyTpl.md", description: "", content: "---\ndescription: x\n---\n" },
			{ name: "full", path: "/t/full.md", description: "", content: "do things" },
		];
		const res = expandPromptTemplates("/emptyTpl", templates);
		expect(res.emptyTemplateName).toBe("emptyTpl");
		expect(res.message).toContain("/emptyTpl");
	});

	it("空模板仍走 block-empty-template", () => {
		const templates = [
			{ name: "emptyTpl", path: "/t/emptyTpl.md", description: "", content: "---\ndescription: x\n---\n" },
		];
		const res = expandPromptTemplates("/emptyTpl", templates);
		expect(
			decideComposerSubmit({
				isOverride: false,
				agentStarting: false,
				hasTarget: true,
				message: "/emptyTpl",
				imageCount: 0,
				emptyTemplateName: res.emptyTemplateName,
			}),
		).toEqual({ action: "block-empty-template", templateName: "emptyTpl" });
	});
});
