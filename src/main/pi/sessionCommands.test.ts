import { describe, expect, test, vi } from "vitest";
import type { SendPromptResult } from "../../shared/types";
import { SessionCommands } from "./sessionCommands";

/**
 * SessionCommands 的 interface 测试：客户端门只依赖这 8 个方法，
 * 因此「终端回收与 agent 生命周期是否配对」「空消息是否语义拒收」都在这里证明，
 * 不再需要分别启动 IPC / HTTP 两条链路。
 */
function makeCommands() {
	const order: string[] = [];
	const agents = {
		create: vi.fn(async () => ({ id: "agent-1" })),
		sendPrompt: vi.fn(async (): Promise<SendPromptResult> => ({ accepted: true })),
		abort: vi.fn(async () => undefined),
		abortAndRestoreQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
		stop: vi.fn(async () => {
			order.push("agent-stop");
		}),
		restart: vi.fn(async () => {
			order.push("agent-restart");
			return { id: "agent-1" };
		}),
		removeQueuedMessage: vi.fn(async () => ({ removed: true })),
		promoteQueuedMessage: vi.fn(async () => ({ promoted: true })),
	};
	const terminal = {
		closeAgent: vi.fn(() => {
			order.push("terminal-close");
		}),
	};
	const commands = new SessionCommands({
		agents: agents as never,
		terminal,
	});
	return { commands, agents, terminal, order };
}

describe("SessionCommands", () => {
	test("stop 先回收终端再停 agent（手机端曾漏关 pty）", async () => {
		const { commands, terminal, order } = makeCommands();
		await commands.stop("agent-1");
		expect(terminal.closeAgent).toHaveBeenCalledWith("agent-1");
		expect(order).toEqual(["terminal-close", "agent-stop"]);
	});

	test("restart 同样先回收终端，再返回新 tab", async () => {
		const { commands, order } = makeCommands();
		const tab = await commands.restart("agent-1");
		expect(tab.id).toBe("agent-1");
		expect(order).toEqual(["terminal-close", "agent-restart"]);
	});

	test("空消息的语义拒收由 AgentManager 判定，module 原样透传", async () => {
		const { commands, agents } = makeCommands();
		agents.sendPrompt.mockResolvedValueOnce({ accepted: false, error: "消息不能为空" });
		const result = await commands.send({ agentId: "agent-1", message: "   " });
		expect(result).toEqual({ accepted: false, error: "消息不能为空" });
		// 预检不能抢走 requireRuntime 的报错优先级：空消息也要走到 AgentManager。
		expect(agents.sendPrompt).toHaveBeenCalledWith({ agentId: "agent-1", message: "" });
	});

	test("纯图片消息放行，文本按 trim 后下发", async () => {
		const { commands, agents } = makeCommands();
		await commands.send({ agentId: "agent-1", message: "  hi  " });
		expect(agents.sendPrompt).toHaveBeenCalledWith({ agentId: "agent-1", message: "hi" });

		await commands.send({
			agentId: "agent-1",
			message: "  ",
			images: [{ type: "image", data: "AA", mimeType: "image/png" }],
		});
		expect(agents.sendPrompt).toHaveBeenCalledTimes(2);
	});

	test("队列撤回/提升透传结果，供 adapter 原样返回", async () => {
		const { commands } = makeCommands();
		await expect(commands.removeQueuedMessage("agent-1", "text", "followUp")).resolves.toEqual({
			removed: true,
		});
		await expect(commands.promoteQueuedMessage("agent-1", "text")).resolves.toEqual({ promoted: true });
	});

	test("create 失败原样重抛（IPC 信封据此分类），并留下结构化现场", async () => {
		const { commands, agents } = makeCommands();
		const error = Object.assign(new Error("trust denied"), { kind: "command" });
		agents.create.mockRejectedValueOnce(error);
		await expect(commands.create({ projectId: "p1" } as never)).rejects.toBe(error);
	});

	test("abort 委托给 AgentManager（无终端副作用）", async () => {
		const { commands, agents, terminal } = makeCommands();
		await commands.abort("agent-1");
		expect(agents.abort).toHaveBeenCalledWith("agent-1");
		expect(terminal.closeAgent).not.toHaveBeenCalled();
	});
});
