/**
 * Config IPC handler：pi 配置文件读写/导入导出/provider 模型拉取/连接测试。
 * 包含 `agentsTrustResponse`（物理位于此块，逻辑属于 agents 命名空间）。
 * 返回 HandlerMap 由 registerIpcHandlers 统一注册。
 */
import { ipcTable, type FetchModelsPayload, type IpcHandlerMap, type TestProviderPayload } from "../../shared/ipc";
import type { PiDesktopApi } from "../../shared/api";
import type { ConfigManager, PiAuthFile, PiModelsFile } from "../config/ConfigManager";
import type { AgentManager } from "../pi/AgentManager";
import type { AppLogger } from "../logging/AppLogger";

interface ConfigHandlerDeps {
	configManager: ConfigManager;
	agentManager: AgentManager;
	appLogger: AppLogger;
}

type ConfigHandlerMaps = {
	config: IpcHandlerMap<typeof ipcTable.config, PiDesktopApi["config"]>;
	// 项目信任确认：渲染进程回传用户选择，唤醒等待中的 Agent 创建流程（见 AgentManager.ensureProjectTrust）
	agents: Pick<IpcHandlerMap<typeof ipcTable.agents, PiDesktopApi["agents"]>, "respondTrustRequest">;
};

export function registerConfigHandlers(deps: ConfigHandlerDeps): ConfigHandlerMaps {
	const { configManager, agentManager, appLogger } = deps;

	return {
		config: {
			getModels: async () => configManager.getModelsConfig(),
			getAuth: async () => configManager.getAuthConfig(),
			getSettings: async () => configManager.getSettingsConfig(),
			getTrust: async () => configManager.getTrustConfig(),
			saveModels: async (_event, data) => {
				// configManager 负责形状校验（返回 valid/error），边界只透传
				const result = await configManager.saveModelsConfig(data as PiModelsFile);
				// 仅日志统计：configManager 已校验形状，这里不重复验证
				const dataObj = data as { providers?: unknown } | null;
				const providerCount =
					dataObj?.providers && typeof dataObj.providers === "object"
						? Object.keys(dataObj.providers).length
						: 0;
				void appLogger.info("config", "Models config saved", { providerCount });
				return result;
			},
			saveAuth: async (_event, data) => {
				// configManager 负责形状校验（返回 valid/error），边界只透传
				const result = await configManager.saveAuthConfig(data as PiAuthFile);
				const authCount = data && typeof data === "object" ? Object.keys(data).length : 0;
				void appLogger.info("config", "Auth config saved", { authCount });
				return result;
			},
			saveSettings: async (_event, settings) => {
				const result = await configManager.saveSettingsConfig(settings);
				const keyCount = settings && typeof settings === "object" ? Object.keys(settings).length : 0;
				void appLogger.info("config", "Pi settings config saved", { keys: keyCount });
				return result;
			},
			// 原子设置 omp 默认供应商/模型：先读当前 settings.json 再合并写回，
			// 避免与设置页的整对象保存互相覆盖；默认模型必须与供应商成对写入，
			// 否则 omp 会用旧 defaultProvider 去匹配新模型 id 导致配不上。
			setDefaultModel: async (_event, provider: unknown, modelId: unknown) => {
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
			},
			saveRaw: async (_event, fileName, rawJson) => {
				const result = await configManager.saveRawConfig(fileName, rawJson);
				void appLogger.info("config", "Raw config saved", {
					fileName,
					bytes: Buffer.byteLength(rawJson, "utf8"),
				});
				return result;
			},
			export: async () => configManager.exportConfig(),
			import: async (_event, packageJson: string) => {
				const result = await configManager.importConfig(packageJson);
				void appLogger.info("config", "Config imported", {
					bytes: Buffer.byteLength(packageJson, "utf8"),
					valid: result.valid,
				});
				return result;
			},
			// 远程拉取 provider 模型列表（pack 成员：payload 类型由通道表 pack 派生）
			fetchModels: async (_event, payload: FetchModelsPayload) => {
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
			// 快速测试 provider 连接（pack 成员）
			testProvider: async (_event, payload: TestProviderPayload) => {
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
		},
		agents: {
			respondTrustRequest: async (
				_event,
				requestId: string,
				choice: "trust-remember" | "trust-session" | "deny",
			) => agentManager.respondTrustRequest(requestId, choice),
		},
	};
}
