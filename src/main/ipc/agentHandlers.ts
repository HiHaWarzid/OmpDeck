/**
 * Agent IPC handler：Agent 生命周期（创建/停止/重启/克隆）、消息收发、模型/思考级别切换。
 *
 * 从 index.ts 的 registerIpc() 迁移而来。
 * agentsPrompt / agentsAbort 只读访问 feishuBridge（通过 getFeishuBridge dep），
 * 用于飞书会话镜像、文件转发和流式卡片控制。
 * agentsStop / agentsRestart 调用 terminalManager.closeAgent 清理终端会话。
 */
import { ipcMain, Notification, type BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { CreateAgentInput, SendPromptInput } from "../../shared/types";
import type { AgentManager } from "../pi/AgentManager";
import type { TerminalSessionManager } from "../terminal/TerminalSessionManager";
import type { AppLogger } from "../logging/AppLogger";
import type { FeishuBridge } from "../feishu/FeishuBridge";
import { wantsFeishuDoc, wrapHostInstruction } from "../feishu/docActions";
import { resolveFeishuFileSendIntent } from "../feishu/fileIntent";

interface AgentHandlerDeps {
	agentManager: AgentManager;
	terminalManager: TerminalSessionManager;
	appLogger: AppLogger;
	getFeishuBridge: () => FeishuBridge | null;
	getMainWindow: () => BrowserWindow | null;
}

export function registerAgentHandlers(deps: AgentHandlerDeps) {
	const { agentManager, terminalManager, appLogger, getFeishuBridge, getMainWindow } = deps;

	ipcMain.handle(
		ipcChannels.agentsNotifyAsk,
		(_event, title: unknown, body: unknown) => {
			// 渲染层判定「非活动 agent 收到 ask 请求且设置开启」后请求主进程发系统通知；
			// 点击通知聚焦主窗口（询问卡片已渲染在会话流中，用户聚焦后可直接作答）。
			if (typeof title !== "string" || typeof body !== "string") return;
			if (!Notification.isSupported()) return;
			const notification = new Notification({
				title: title || "OmpDeck",
				body,
				silent: false,
			});
			notification.on("click", () => {
				const win = getMainWindow();
				if (!win || win.isDestroyed()) return;
				if (win.isMinimized()) win.restore();
				if (!win.isVisible()) win.show();
				win.focus();
			});
			notification.show();
		},
	);

	ipcMain.handle(ipcChannels.agentsList, () => agentManager.list());
	ipcMain.handle(ipcChannels.agentsGetMessages, (_event, agentId: string) =>
		agentManager.getMessages(agentId),
	);

	ipcMain.handle(ipcChannels.agentsCreate, async (_event, input: CreateAgentInput) => {
		void appLogger.info("agent", "Agent create IPC received", {
			projectId: input.projectId,
			sessionPath: input.sessionPath,
			title: input.title,
			platform: process.platform,
			arch: process.arch,
		});
		try {
			const tab = await agentManager.create(input);
			void appLogger.info("agent", "Agent create IPC completed", {
				agentId: tab.id,
				projectId: input.projectId,
				status: tab.status,
				sessionPath: tab.sessionPath,
			});
			void appLogger.info("agent", "Agent created", {
				agentId: tab.id,
				projectId: input.projectId,
				title: tab.title,
				sessionPath: tab.sessionPath,
			});
			// 不再自动为新会话创建飞书群；必须由用户在会话输入框的飞书菜单中手动连接后才同步。
			return tab;
		} catch (error) {
			// createUnlocked 内部已尽量吞掉 pi 启动失败；这里兜底信任/项目查找等前置异常，
			// 保证 IPC 层也有结构化日志，方便 Mac 闪退类反馈对照 userData/logs。
			void appLogger.error("agent", "Agent create IPC failed", {
				projectId: input.projectId,
				sessionPath: input.sessionPath,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				platform: process.platform,
				arch: process.arch,
			});
			throw error;
		}
	});
	ipcMain.handle(
		ipcChannels.agentsRename,
		async (_event, agentId: string, name: string) => {
			const result = await agentManager.rename(agentId, name);
			void appLogger.info("agent", "Agent renamed", { agentId, name });
			return result;
		},
	);
	ipcMain.handle(ipcChannels.agentsStop, async (_event, agentId: string) => {
		terminalManager.closeAgent(agentId);
		await agentManager.stop(agentId);
		void appLogger.info("agent", "Agent stopped", { agentId });
	});
	ipcMain.handle(ipcChannels.agentsPrompt, async (_event, input: SendPromptInput) => {
		const bridge = getFeishuBridge();
		const bridgeConnected = bridge?.getStatus().status === "connected";
		const hasFeishuBinding = bridgeConnected && bridge.hasSessionBinding(input.agentId);
		const docTitle = bridgeConnected ? wantsFeishuDoc(input.message) : undefined;
		const sessionChatId = bridgeConnected ? bridge.getSessionChatId(input.agentId) : undefined;
		let agentInstruction: string | undefined;
		const buildFeishuActionInstruction = (chatId?: string) => [
			"当前会话已连接飞书聊天。严禁调用 lark-cli、飞书 IM API 或搜索群聊来发送文件；不要询问 chat_id。需要把本地文件发到当前飞书聊天时，最终回答末尾独立一行写 [SEND_FILE:本地文件路径]，OmpDeck 会按当前会话绑定自动上传。",
			chatId ? `当前绑定的飞书 chat_id: ${chatId}。这是只读上下文，用于确认当前会话绑定；发送文件仍必须用 [SEND_FILE:本地文件路径]。` : undefined,
		].filter(Boolean).join("\n");

		if (bridgeConnected && hasFeishuBinding) {
			const filePath = resolveFeishuFileSendIntent(input.message, agentManager.getCwd(input.agentId));
			if (filePath) {
				const result = await bridge.sendFileForSession(input.agentId, filePath);
				agentManager.recordHostExchange(input.agentId, input.message, result);
				void appLogger.info("feishu", "File sent through current session binding", {
					agentId: input.agentId,
					filePath,
					success: result.startsWith("✅"),
				});
				return;
			}
		}

		// 用户说了要做飞书文档但当前会话未绑定 → 自动绑定并告知 Agent 可用 lark-cli
		if (bridgeConnected && docTitle && !hasFeishuBinding) {
			const tab = agentManager.list().find((item) => item.id === input.agentId);
			if (tab) {
				await bridge.ensureSessionMirror(tab.id, tab.title, tab.sessionPath).catch((e) => {
					console.error("[Feishu] auto-bind session mirror failed:", e);
				});
				bridge.trackDocRequest(tab.id, docTitle);
				void bridge.forwardUserMessageToFeishu(tab.id, input.message).catch((e) => {
					console.error("[Feishu] forward OmpDeck message failed:", e);
				});
				agentInstruction = `${buildFeishuActionInstruction(bridge.getSessionChatId(tab.id))}\n创建飞书文档时，先输出完整正文，最后独立一行写 [CREATE_DOC:文档标题]。`;
			}
		} else if (hasFeishuBinding) {
			agentInstruction = buildFeishuActionInstruction(sessionChatId);
			const tab = agentManager.list().find((item) => item.id === input.agentId);
			if (tab) {
				void bridge.startSessionMirrorRun(tab.id, tab.title, tab.sessionPath).catch((e) => {
					console.error("[Feishu] session mirror card init failed:", e);
				});
				if (input.message.trim()) {
					void bridge.forwardUserMessageToFeishu(tab.id, input.message).catch((e) => {
						console.error("[Feishu] forward OmpDeck message failed:", e);
					});
				}
			}
		}
		// agentMessage 用隐藏标记包裹宿主指令，UI/历史展示只显示用户原文。
		const result = await agentManager.sendPrompt(
			agentInstruction
				? {
						...input,
						agentMessage: wrapHostInstruction(agentInstruction, input.message),
					}
				: input,
		);
		void appLogger.info("agent", "Prompt sent", {
			agentId: input.agentId,
			messageLength: input.message.length,
			imageCount: input.images?.length ?? 0,
			streamingBehavior: input.streamingBehavior,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.agentsAbort, async (_event, agentId: string) => {
		// Session Mirror: 停止飞书流式卡片
		const bridge = getFeishuBridge();
		if (bridge) {
			bridge.stopSessionMirrorRun(agentId);
		}
		const result = await agentManager.abort(agentId);
		void appLogger.info("agent", "Agent aborted", { agentId });
		return result;
	});
	ipcMain.handle(ipcChannels.agentsExportHtml, (_event, agentId: string) =>
		agentManager.exportHtml(agentId),
	);
	ipcMain.handle(ipcChannels.agentsForkMessages, (_event, agentId: string) =>
		agentManager.getForkMessages(agentId),
	);
	ipcMain.handle(
		ipcChannels.agentsForkSession,
		(_event, agentId: string, entryId: string) =>
			agentManager.forkSession(agentId, entryId),
	);
	ipcMain.handle(ipcChannels.agentsCloneSession, async (_event, agentId: string) => {
		const result = await agentManager.cloneSession(agentId);
		void appLogger.info("agent", "Agent session cloned", { agentId });
		return result;
	});
	ipcMain.handle(
		ipcChannels.agentsSwitchSession,
		async (_event, agentId: string, sessionPath: string) => {
			const result = await agentManager.switchSession(agentId, sessionPath);
			void appLogger.info("agent", "Agent switched session", { agentId, sessionPath });
			return result;
		},
	);
	ipcMain.handle(ipcChannels.agentsEditMessage, async (_event, agentId: string, messageId: string, text: string) => {
		await agentManager.editMessage(agentId, messageId, text);
		void appLogger.info("agent", "Message edited", { agentId, messageId });
	});
	ipcMain.handle(ipcChannels.agentsDeleteMessage, async (_event, agentId: string, messageId: string) => {
		await agentManager.deleteMessage(agentId, messageId);
		void appLogger.info("agent", "Message deleted", { agentId, messageId });
	});
	ipcMain.handle(
		ipcChannels.agentsPrepareResend,
		async (_event, agentId: string, messageId: string) => {
			const result = await agentManager.prepareResendFromMessage(agentId, messageId);
			void appLogger.info("agent", "Message prepared for resend", { agentId, messageId });
			return result;
		},
	);
	ipcMain.handle(ipcChannels.agentsReload, async (_event, agentId: string) => {
		const result = await agentManager.reload(agentId);
		void appLogger.info("agent", "Agent reloaded", { agentId });
		return result;
	});
	ipcMain.handle(ipcChannels.agentsRestart, async (_event, agentId: string) => {
		terminalManager.closeAgent(agentId);
		const result = await agentManager.restart(agentId);
		void appLogger.info("agent", "Agent restarted", { agentId });
		return result;
	});
	ipcMain.handle(ipcChannels.agentsCompact, async (_event, agentId: string, prompt?: string) => {
		void appLogger.info("agent", "Agent compact IPC called", { agentId, prompt });
		try {
			const result = await agentManager.compact(agentId, prompt);
			void appLogger.info("agent", "Agent compact IPC succeeded", { agentId });
			return result;
		} catch (error) {
			void appLogger.error("agent", "Agent compact IPC failed", {
				agentId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});
	ipcMain.handle(ipcChannels.agentsRuntimeState, (_event, agentId: string) =>
		agentManager.getRuntimeState(agentId),
	);
	ipcMain.handle(ipcChannels.agentsCycleModel, (_event, agentId: string) =>
		agentManager.cycleModel(agentId),
	);
	ipcMain.handle(ipcChannels.agentsAvailableModels, (_event, agentId: string) =>
		agentManager.getAvailableModels(agentId),
	);
	ipcMain.handle(
		ipcChannels.agentsSetModel,
		async (_event, agentId: string, provider: string, modelId: string) => {
			const result = await agentManager.setModel(agentId, provider, modelId);
			void appLogger.info("agent", "Agent model changed", { agentId, provider, modelId });
			return result;
		},
	);
	ipcMain.handle(ipcChannels.agentsRefreshModels, async (_event, agentId: string) => {
		void appLogger.info("agent", "Agent model refresh requested", { agentId });
		return agentManager.refreshModels(agentId);
	});
	ipcMain.handle(ipcChannels.agentsCycleThinking, (_event, agentId: string) =>
		agentManager.cycleThinking(agentId),
	);
	ipcMain.handle(
		ipcChannels.agentsSetThinking,
		async (_event, agentId: string, level: string) => {
			const result = await agentManager.setThinking(agentId, level);
			void appLogger.info("agent", "Agent thinking level changed", { agentId, level });
			return result;
		},
	);
	ipcMain.handle("agents:commands", async (_event, agentId: string) => {
		try {
			return await agentManager.getCommands(agentId);
		} catch {
			// agent 不存在或 RPC 超时时返回空列表，避免控制台报未处理异常
			return [];
		}
	});

	/** 用户通过 UI 响应了扩展的 ask_question 请求，转发给 AgentManager 发送 extension_ui_response */
	ipcMain.handle(ipcChannels.agentsUiResponse, async (_event, agentId: string, requestId: string, response: { value?: string | boolean | null; cancelled?: boolean; confirmed?: boolean }) => {
		await agentManager.sendUIResponse(agentId, requestId, response);
	});
}
