/**
 * Config IPC handler：pi 配置文件读写/导入导出/provider 模型拉取/连接测试。
 * 返回 HandlerMap 由 registerIpcHandlers 统一注册。
 */
import { ipcTable, type FetchModelsPayload, type IpcHandlerMap, type SetOmpRolePayload, type TestProviderPayload } from "../../shared/ipc";
import type { PiDesktopApi } from "../../shared/api";
import { formatRoleSelector, isOmpModelRole } from "../../shared/types/ompRoles";
import type { ConfigManager, PiAuthFile, PiModelsFile } from "../config/ConfigManager";
import type { AppLogger } from "../logging/AppLogger";

interface ConfigHandlerDeps {
	configManager: ConfigManager;
	appLogger: AppLogger;
}

type ConfigHandlerMaps = {
	config: IpcHandlerMap<typeof ipcTable.config, PiDesktopApi["config"]>;
};

export function registerConfigHandlers(deps: ConfigHandlerDeps): ConfigHandlerMaps {
	const { configManager, appLogger } = deps;

	return {
		config: {
			getModels: async () => configManager.getModelsConfig(),
			getAuth: async () => configManager.getAuthConfig(),
			getSettings: async () => configManager.getSettingsConfig(),
			getOmpDefault: async () => configManager.readOmpDefaultModel(),
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
			// 原子设置 omp 默认模型：写 ~/.omp/agent/config.yml 的 modelRoles.default
			// （"provider/modelId[:thinkingLevel]"）。当前 omp 的全局 settings 权威源是
			// config.yml，旧的 settings.json 已不被读取；defaultProvider/defaultModel
			// 单字段与 settings.json 均已废弃，仅作兼容展示，不再依赖其生效。
			setDefaultModel: async (_event, provider: unknown, modelId: unknown, thinkingLevel: unknown) => {
				const trimmedProvider = typeof provider === "string" ? provider.trim() : "";
				const trimmedModel = typeof modelId === "string" ? modelId.trim() : "";
				if (!trimmedProvider || !trimmedModel) {
					return { valid: false, error: "provider 与 modelId 不能为空" };
				}
				// selector 落盘格式 "provider/modelId"（shared 契约，见 ompRoles.formatRoleSelector）
				const selector = formatRoleSelector(trimmedProvider, trimmedModel);
				const level = typeof thinkingLevel === "string" ? thinkingLevel.trim() : "";
				// 原子设置 OMP 默认：单次文档变更写 modelRoles.default 与顶层
				// defaultThinkingLevel 两个槽位（原两次串行全文件 RMW 的撕裂窗口
				// 已收敛为 OmpRolesStore.applyDefault 的一次写）。
				const roleResult = await configManager.applyOmpDefault(
					selector,
					level || undefined,
				);
				if (!roleResult.valid) return roleResult;
				void appLogger.info("config", "Default model set", {
					provider: trimmedProvider,
					model: trimmedModel,
					thinkingLevel: level || undefined,
					valid: true,
				});
				return { valid: true };
			},
			// 清除 omp 默认模型角色与默认思考档（config.yml）。
			clearOmpDefault: async () => {
				const result = await configManager.clearOmpDefault();
				if (result.valid) {
					void appLogger.info("config", "Default model cleared", { valid: true });
				}
				return result;
			},
			// 读取 config.yml 全部模型角色（modelRoles.<role>）。
			getOmpRoles: async () => configManager.readOmpModelRoles(),
			// 原子设置某个模型角色：写 config.yml 的 modelRoles.<role>，
			// selector 形如 "provider/modelId"，可选 ":thinkingLevel" 后缀。
			setOmpRole: async (_event, payload: SetOmpRolePayload) => {
				const role = payload.role.trim();
				const selector = payload.selector.trim();
				if (!isOmpModelRole(role)) {
					return { valid: false, error: `未知的模型角色：${role}` };
				}
				if (!selector) {
					return { valid: false, error: "selector 不能为空" };
				}
				const result = await configManager.updateOmpModelRole(
					role,
					selector,
					payload.thinkingLevel?.trim() || undefined,
				);
				if (result.valid) {
					void appLogger.info("config", "Model role set", {
						role,
						selector,
						thinkingLevel: payload.thinkingLevel?.trim() || undefined,
					});
				}
				return result;
			},
			// 清除 config.yml 的 modelRoles.<role>。
			clearOmpRole: async (_event, role: unknown) => {
				const trimmedRole = typeof role === "string" ? role.trim() : "";
				if (!isOmpModelRole(trimmedRole)) {
					return { valid: false, error: "role 不能为空或不是有效角色" };
				}
				const result = await configManager.clearOmpModelRole(trimmedRole);
				if (result.valid) {
					void appLogger.info("config", "Model role cleared", { role: trimmedRole });
				}
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
					payload.headers,
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
	};
}
