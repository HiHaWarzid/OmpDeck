/**
 * Config IPC handler：pi 配置文件读写/导入导出/provider 模型拉取/连接测试。
 * 包含 `agentsTrustResponse`（物理位于此块，逻辑属于 agents 命名空间）。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { ConfigManager } from "../config/ConfigManager";
import type { AgentManager } from "../pi/AgentManager";
import type { AppLogger } from "../logging/AppLogger";

interface ConfigHandlerDeps {
	configManager: ConfigManager;
	agentManager: AgentManager;
	appLogger: AppLogger;
}

export function registerConfigHandlers(deps: ConfigHandlerDeps) {
	const { configManager, agentManager, appLogger } = deps;

	ipcMain.handle(ipcChannels.configGetModels, () => configManager.getModelsConfig());
	ipcMain.handle(ipcChannels.configGetAuth, () => configManager.getAuthConfig());
	ipcMain.handle(ipcChannels.configGetSettings, () => configManager.getSettingsConfig());
	ipcMain.handle(ipcChannels.configGetTrust, () => configManager.getTrustConfig());

	// 项目信任确认：渲染进程回传用户选择，唤醒等待中的 Agent 创建流程（见 AgentManager.ensureProjectTrust）
	ipcMain.handle(
		ipcChannels.agentsTrustResponse,
		(_event, requestId: string, choice: "trust-remember" | "trust-session" | "deny") =>
			agentManager.respondTrustRequest(requestId, choice),
	);

	ipcMain.handle(ipcChannels.configSaveModels, async (_event, data) => {
		const result = await configManager.saveModelsConfig(data);
		void appLogger.info("config", "Models config saved", {
			providerCount: Object.keys(data?.providers ?? {}).length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.configSaveAuth, async (_event, data) => {
		const result = await configManager.saveAuthConfig(data);
		void appLogger.info("config", "Auth config saved", { authCount: Object.keys(data ?? {}).length });
		return result;
	});
	ipcMain.handle(ipcChannels.configSaveSettings, async (_event, settings) => {
		const result = await configManager.saveSettingsConfig(settings);
		void appLogger.info("config", "Pi settings config saved", { keys: Object.keys(settings ?? {}) });
		return result;
	});
	// 原子设置 omp 默认供应商/模型：先读当前 settings.json 再合并写回，
	// 避免与设置页的整对象保存互相覆盖；默认模型必须与供应商成对写入，
	// 否则 omp 会用旧 defaultProvider 去匹配新模型 id 导致配不上。
	ipcMain.handle(ipcChannels.configSetDefaultModel, async (_event, provider: unknown, modelId: unknown) => {
		const trimmedProvider = typeof provider === "string" ? provider.trim() : "";
		const trimmedModel = typeof modelId === "string" ? modelId.trim() : "";
		if (!trimmedProvider || !trimmedModel) {
			return { valid: false, error: "provider 与 modelId 不能为空" };
		}
		const current = await configManager.getSettingsConfig();
		const next = {
			...current.parsed,
			defaultProvider: trimmedProvider,
			defaultModel: trimmedModel,
		};
		const result = await configManager.saveSettingsConfig(next);
		void appLogger.info("config", "Default model set", { provider: trimmedProvider, model: trimmedModel, valid: result.valid });
		return result;
	});
	ipcMain.handle(ipcChannels.configSaveRaw, async (_event, fileName, rawJson) => {
		const result = await configManager.saveRawConfig(fileName, rawJson);
		void appLogger.info("config", "Raw config saved", {
			fileName,
			bytes: Buffer.byteLength(rawJson, "utf8"),
		});
		return result;
	});
	ipcMain.handle(ipcChannels.configExport, () => configManager.exportConfig());
	ipcMain.handle(ipcChannels.configImport, async (_event, packageJson: string) => {
		const result = await configManager.importConfig(packageJson);
		void appLogger.info("config", "Config imported", {
			bytes: Buffer.byteLength(packageJson, "utf8"),
			valid: result.valid,
		});
		return result;
	});

	// 远程拉取 provider 模型列表
	ipcMain.handle(
		ipcChannels.configFetchModels,
		async (_event, payload: { baseUrl: string; apiKey: string; apiType?: string }) => {
			const result = await configManager.fetchProviderModels(
				payload.baseUrl,
				payload.apiKey,
				payload.apiType,
			);
			void appLogger.info("config", "Provider models fetched", {
				baseUrl: payload.baseUrl,
				apiType: payload.apiType,
				modelCount: Array.isArray(result) ? result.length : undefined,
			});
			return result;
		},
	);

	// 快速测试 provider 连接
	ipcMain.handle(
		ipcChannels.configTestProvider,
		async (
			_event,
			payload: {
				baseUrl: string;
				apiKey: string;
				modelId: string;
				apiType?: string;
				headers?: Record<string, string>;
			},
		) => {
			const result = await configManager.testProviderConnection(
				payload.baseUrl,
				payload.apiKey,
				payload.modelId,
				payload.apiType,
				payload.headers,
			);
			void appLogger.info("config", "Provider connection tested", {
				baseUrl: payload.baseUrl,
				apiType: payload.apiType,
				modelId: payload.modelId,
				success: result.success,
				error: result.error,
			});
			return result;
		},
	);
}
