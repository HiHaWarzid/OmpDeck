import { describe, expect, it } from "vitest";
import {
	decideComposerSubmit,
	parseCompactCommand,
} from "./composerBehavior";

const base = {
	isOverride: false,
	agentStarting: false,
	hasTarget: true,
	message: "hello",
	imageCount: 0,
	isBusy: false,
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

	it("/compact 优先于 busy：忙也走压缩而非入队", () => {
		expect(
			decideComposerSubmit({ ...base, message: "/compact focus", isBusy: true }),
		).toEqual({ action: "compact", compactPrompt: "focus" });
	});

	it("空模板即使忙也拦截，不入队", () => {
		expect(
			decideComposerSubmit({
				...base,
				message: "/emptyTpl",
				emptyTemplateName: "emptyTpl",
				isBusy: true,
			}),
		).toEqual({ action: "block-empty-template", templateName: "emptyTpl" });
	});

	it("忙则入队、闲则直发", () => {
		expect(decideComposerSubmit({ ...base, isBusy: true })).toEqual({ action: "enqueue" });
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
				isBusy: true,
				commandRoutes: false,
			}),
		).toEqual({ action: "enqueue" });
	});
});
