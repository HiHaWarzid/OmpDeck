import { createSessionWorkspaceStore } from "./sessionWorkspace";

/**
 * 会话工作区默认单例：App 与各切片 hook 共享同一实例。
 * 测试/隔离场景用 createSessionWorkspaceStore() 工厂造独立 store。
 */
export const sessionWorkspaceStore = createSessionWorkspaceStore();
