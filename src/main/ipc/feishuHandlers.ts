/**
 * Feishu IPC handler：飞书机器人连接/断开、Bot 配置管理、会话绑定。
 *
 * 从 index.ts 的 registerFeishuIpc() 迁移而来。
 * 关键点：feishuBridge 是运行期可变的单例（连接时新建、断开时置 null），
 * 通过 getFeishuBridge / setFeishuBridge dep 显式传递，避免闭包捕获过期引用。
 * agentHandlers 中的 agentsPrompt / agentsAbort 也只读访问 feishuBridge，
 * 后续提取 agentHandlers 时只需传入 getFeishuBridge（只读）。
 */
import { ipcMain, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { ipcChannels } from "../../shared/ipc";
import type {
	FeishuBotConfig,
	FeishuBridgeStatus,
	FeishuChatBinding,
	FeishuConnectInput,
} from "../../shared/types";
import { FeishuBridge } from "../feishu/FeishuBridge";
import {
	listBots,
	getBot,
	addBot as addFeishuBot,
	removeBot as removeFeishuBot,
	updateBot as updateFeishuBot,
	getDecryptedBotAppSecret,
	getSessionBotId,
	setSessionBotId,
} from "../feishu/FeishuConfig";
import type { AgentManager } from "../pi/AgentManager";
import type { ProjectStore } from "../projects/ProjectStore";
import type { AppLogger } from "../logging/AppLogger";

interface FeishuHandlerDeps {
	agentManager: AgentManager;
	projectStore: ProjectStore;
	appLogger: AppLogger;
	getMainWindow: () => BrowserWindow | null;
	getFeishuBridge: () => FeishuBridge | null;
	setFeishuBridge: (bridge: FeishuBridge | null) => void;
}

export function registerFeishuHandlers(deps: FeishuHandlerDeps) {
	const { agentManager, projectStore, appLogger, getMainWindow, getFeishuBridge, setFeishuBridge } = deps;

	/** Bot 配置变更后主动推送给 renderer，保证多个页面/弹窗中的 Bot 列表实时同步。 */
	function broadcastBotsChanged() {
		const win = getMainWindow();
		if (!win || win.isDestroyed()) return;
		win.webContents.send(ipcChannels.feishuBotsChanged, listBots());
	}

	// 临时连接（不保存 bot 配置），用于添加 Bot 时先验证凭证可用性
	ipcMain.handle(ipcChannels.feishuConnectTemp, async (_event, input: FeishuConnectInput) => {
		const appId = input.appId?.trim() ?? "";
		const appSecret = input.appSecret?.trim() ?? "";
		console.log("[Feishu] 收到临时连接请求", JSON.stringify({ appId: appId ? appId.slice(0, 8) + "..." : "", name: input.name, hasSecret: Boolean(appSecret) }));
		try {
			if (!appId || !appSecret) {
				return { success: false, message: "请填写 App ID 和 App Secret" };
			}
			const existing = getFeishuBridge();
			if (existing) {
				existing.stop();
			}
			// 临时构造 botConfig，不做持久化；明文 secret 只传给当前 bridge，不写入磁盘。
			const botConfig: FeishuBotConfig = {
				id: "temp-" + randomUUID(),
				name: input.name?.trim() || "临时机器人",
				enabled: true,
				appId,
				appSecret,
				defaultUserOpenId: input.defaultUserOpenId,
			};
			const bridge = new FeishuBridge(botConfig, agentManager, getMainWindow, () => projectStore.list(), appSecret);
			setFeishuBridge(bridge);
			await bridge.start();
			const status = bridge.getStatus();
			console.log("[Feishu] 临时连接成功，状态:", JSON.stringify(status));
			return {
				success: true,
				message: "连接成功",
				botInfo: { id: botConfig.id, name: botConfig.name },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error("[Feishu] 临时连接失败:", message);
			return { success: false, message };
		}
	});

	// 连接飞书（保存 bot）
	ipcMain.handle(ipcChannels.feishuConnect, async (_event, input: FeishuConnectInput) => {
		console.log("[Feishu] 收到连接请求", JSON.stringify({ appId: input.appId?.slice(0, 8) + "...", name: input.name }));
		try {
			const existing = getFeishuBridge();
			if (existing) {
				console.log("[Feishu] 停止旧 bridge 状态:", JSON.stringify(existing.getStatus()));
				existing.stop();
			}

			const botConfig = addFeishuBot({
				name: input.name || "飞书机器人",
				appId: input.appId,
				appSecret: input.appSecret,
				defaultUserOpenId: input.defaultUserOpenId,
			});

			const bridge = new FeishuBridge(botConfig, agentManager, getMainWindow, () => projectStore.list());
			setFeishuBridge(bridge);
			await bridge.start();
			console.log("[Feishu] 连接成功，状态:", JSON.stringify(bridge.getStatus()));
			void appLogger.info("feishu", "Feishu connected", { botId: botConfig.id, name: botConfig.name });
			broadcastBotsChanged();
			return { success: true, message: "连接成功" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error("[Feishu] 连接失败:", message);
			void appLogger.error("feishu", "Feishu connect failed", error);
			return { success: false, message };
		}
	});

	// 断开连接
	ipcMain.handle(ipcChannels.feishuDisconnect, async () => {
		console.log("[Feishu] 收到断开请求");
		const existing = getFeishuBridge();
		if (existing) {
			console.log("[Feishu] 停止 bridge，此前状态:", JSON.stringify(existing.getStatus()));
			existing.stop();
			setFeishuBridge(null);
			console.log("[Feishu] bridge 已置 null");
		}
		void appLogger.info("feishu", "Feishu disconnected");
		return { success: true };
	});

	// 查询状态
	ipcMain.handle(ipcChannels.feishuStatusRequest, async () => {
		const bridge = getFeishuBridge();
		if (bridge) {
			const s = bridge.getStatus();
			console.log("[Feishu] 状态查询:", JSON.stringify(s));
			return s;
		}
		console.log("[Feishu] 状态查询: bridge 为 null，返回 disconnected");
		return { status: "disconnected", activeBindings: 0 } as FeishuBridgeStatus;
	});

	// Bot 列表
	ipcMain.handle(ipcChannels.feishuBotsList, async () => {
		return listBots();
	});

	// 添加 Bot
	ipcMain.handle(ipcChannels.feishuBotAdd, async (_event, input: FeishuConnectInput) => {
		// 同 feishuConnect，但可以添加多个 Bot
		try {
			const botConfig = addFeishuBot({
				name: input.name || "飞书机器人",
				appId: input.appId,
				appSecret: input.appSecret,
				defaultUserOpenId: input.defaultUserOpenId,
			});
			void appLogger.info("feishu", "Feishu bot added", { botId: botConfig.id, name: botConfig.name });
			broadcastBotsChanged();
			return { success: true, bot: { ...botConfig, appSecret: "" } };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	// 删除 Bot
	ipcMain.handle(ipcChannels.feishuBotRemove, async (_event, botId: string) => {
		const existing = getFeishuBridge();
		if (existing) {
			existing.stop();
			setFeishuBridge(null);
		}
		const result = removeFeishuBot(botId);
		if (result) {
			broadcastBotsChanged();
		}
		void appLogger.info("feishu", "Feishu bot removed", { botId });
		return result;
	});

	// 更新 Bot 配置
	ipcMain.handle(ipcChannels.feishuBotConfig, async (_event, botId: string, patch: Partial<FeishuBotConfig>) => {
		const updated = updateFeishuBot(botId, patch);
		void appLogger.info("feishu", "Feishu bot config updated", { botId, keys: Object.keys(patch) });
		// 只热更新当前在线 Bot；修改其它 Bot 配置不应污染正在运行的 bridge。
		const bridge = getFeishuBridge();
		if (bridge && bridge.getStatus().status === "connected" && bridge.getStatus().botId === botId) {
			bridge.updateBotConfig(patch);
			console.log("[飞书] 配置已热更新:", Object.keys(patch).join(", "));
		}
		if (updated) {
			broadcastBotsChanged();
		}
		return updated ? { ...updated, appSecret: "" } : undefined;
	});

	// 返回解密后的 Secret，仅用于用户主动复制/查看凭证。
	ipcMain.handle(ipcChannels.feishuBotSecret, async (_event, botId: string) => {
		return getDecryptedBotAppSecret(botId);
	});

	// 测试连接
	ipcMain.handle(ipcChannels.feishuTestConnection, async (_event, appId: string, appSecret: string) => {
		// 创建临时 bridge 实例来测试连接
		const testBridge = new FeishuBridge(
			{
				id: "test",
				name: "测试",
				enabled: true,
				appId,
				appSecret: "", // 将在 testConnection 中传入
			},
			agentManager,
			getMainWindow,
			() => projectStore.list(),
		);
		return testBridge.testConnection(appId, appSecret);
	});

	// 绑定列表
	ipcMain.handle(ipcChannels.feishuBindingsList, async () => {
		const bridge = getFeishuBridge();
		if (bridge) {
			return bridge.listBindings();
		}
		return [];
	});

	// 移除绑定
	ipcMain.handle(ipcChannels.feishuBindingRemove, async (_event, chatId: string) => {
		const bridge = getFeishuBridge();
		if (bridge) {
			// 先查 binding 拿到 sessionId，移除后清理 session-bot 映射，
			// 使 FeishuLinkIndicator 等 UI 同步更新断开状态。
			const bindings = bridge.listBindings();
			const binding = bindings.find((b) => b.chatId === chatId);
			const result = bridge.removeBinding(chatId);
			if (result && binding) {
				setSessionBotId(binding.sessionId, undefined);
			}
			return result;
		}
		return false;
	});

	// 更新绑定
	ipcMain.handle(ipcChannels.feishuBindingUpdate, async (_event, chatId: string, patch: Partial<FeishuChatBinding>) => {
		const bridge = getFeishuBridge();
		if (bridge) {
			return bridge.updateBinding(chatId, patch);
		}
		return undefined;
	});

	// 通过已保存的 Bot ID 连接（自动解密 Secret）
	ipcMain.handle(ipcChannels.feishuConnectByBot, async (_event, botId: string) => {
		try {
			const existing = getFeishuBridge();
			if (existing) {
				existing.stop();
			}
			const botConfig = getBot(botId);
			if (!botConfig) {
				return { success: false, message: "Bot 配置不存在" };
			}
			const bridge = new FeishuBridge(botConfig, agentManager, getMainWindow, () => projectStore.list());
			setFeishuBridge(bridge);
			await bridge.start();
			void appLogger.info("feishu", "Feishu connected by saved bot", { botId, name: botConfig.name });
			return { success: true, message: "连接成功" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { success: false, message };
		}
	});

	// 获取 Agent 绑定的飞书 Bot ID
	ipcMain.handle(ipcChannels.feishuSessionBotGet, async (_event, agentId: string) => {
		return getSessionBotId(agentId) ?? null;
	});

	// 设置 Agent 使用的飞书 Bot ID；非空表示用户手动连接当前会话，需要立即创建/复用飞书群绑定。
	// 传入 null 时取消关联：仅移除绑定（不终止 Agent），同时清理配置映射。
	// 返回结果给前端：以前静默 return 会导致 UI 显示"已连接"但实际没有群绑定，飞书发消息无响应。
	ipcMain.handle(ipcChannels.feishuSessionBotSet, async (_event, agentId: string, botId: string | null) => {
		const bridge = getFeishuBridge();
		if (!botId) {
			setSessionBotId(agentId, undefined);
			// 取消当前会话的飞书关联：移除绑定但不停止 Agent 进程
			if (bridge && bridge.getStatus().status === "connected") {
				bridge.removeBindingBySessionId(agentId);
			}
			return { success: true };
		}
		const status = bridge?.getStatus();
		if (!bridge || status?.status !== "connected") {
			return { success: false, message: "飞书未连接，请先在配置中连接机器人" };
		}
		if (status.botId !== botId) {
			return { success: false, message: "请先切换并连接所选机器人，再绑定当前会话" };
		}
		const tab = agentManager.list().find((item) => item.id === agentId);
		if (!tab) {
			return { success: false, message: "当前会话不存在或已关闭" };
		}
		// 先建群绑定，成功后再写映射；避免"映射成功但群创建失败"的假连接状态。
		const chatId = await bridge.ensureSessionMirror(tab.id, tab.title, tab.sessionPath);
		if (!chatId) {
			return {
				success: false,
				message:
					"创建/复用飞书群失败。请检查：1) 开放平台已开通 im:chat 权限 2) 已配置你的 Open ID（可向 Bot 发送 /whoami 获取）",
			};
		}
		setSessionBotId(agentId, botId);
		return { success: true, chatId };
	});
}
