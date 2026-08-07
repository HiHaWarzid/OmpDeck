# IPC Handler 模块化提取

## Context

`src/main/index.ts` 是 4,238 行的巨型文件，其中 `registerIpc()` (L1376) 包含 ~212 个 `ipcMain.handle` 注册，加上 `registerFeishuIpc()` (L1109) 的 14 个，合计 226 个 handler 全堆在一个文件里。

服务层（GitService、AgentManager、FeishuBridge 等）已模块化到 `src/main/git/`、`src/main/pi/` 等目录，但 IPC handler 注册层没有跟进——每个新 IPC 方法都要在 `index.ts` 这个已过载的文件里加代码。

**目标**：将 handler 按命名空间提取到 `src/main/ipc/` 下的独立模块，`index.ts` 只保留窗口管理、服务初始化和薄注册层。已有的 `registerFeishuIpc()` 就是现成的提取模板。

## 范围

226 个 handler，17 个命名空间，分 3 批提取：

| 批次 | 命名空间 | handler 数 | 复杂度 | 风险 |
|------|----------|-----------|--------|------|
| 1 | logs, rpcLogs, editors, skills, extensions, terminal, scratchPad, skillStore, skillHub, promptStore | ~60 | 薄封装 | 低 |
| 2 | projects, projectResources, files, sessions, git, prompts, app | ~120 | 中等 | 低 |
| 3 | agents, feishu, pet, config, pi/wsl | ~46 | 重建复杂 | 中 |

## 方案

### 目录结构

```
src/main/ipc/
  index.ts                  # registerAllIpcHandlers(deps) — 调用各 register 函数
  logHandlers.ts            # logs + rpcLogs
  editorHandlers.ts         # editors
  projectHandlers.ts        # projects + projectResources
  fileHandlers.ts           # files
  sessionHandlers.ts        # sessions + codex/claude/opencode import
  gitHandlers.ts            # git (44 个 handler，最大的命名空间)
  agentHandlers.ts          # agents
  feishuHandlers.ts         # feishu（从 registerFeishuIpc 迁移）
  skillHandlers.ts          # skills
  promptHandlers.ts         # prompts + promptStore
  storeHandlers.ts          # skillStore + skillHub
  extensionHandlers.ts      # extensions
  terminalHandlers.ts       # terminal
  petHandlers.ts            # pet
  appHandlers.ts            # app + dialog + browser
  configHandlers.ts         # config
  piHandlers.ts             # pi + wsl
  scratchPadHandlers.ts     # scratch-pad
```

### 每个模块的接口模式

```typescript
// src/main/ipc/gitHandlers.ts
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { GitService } from "../git/GitService";
import type { ProjectStore } from "../settings/ProjectStore";

interface GitHandlerDeps {
  gitService: GitService;
  projectStore: ProjectStore;
}

export function registerGitHandlers(deps: GitHandlerDeps) {
  ipcMain.handle(ipcChannels.gitBranches, async (_event, projectId: string) => {
    const project = deps.projectStore.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return deps.gitService.getBranches(project.path);
  });
  // ...其余 git handler 逐行搬迁
}
```

### 可变状态的处理

`index.ts` 中有几个 `let` 变量在运行期会被重新赋值，handler 模块不能直接闭包捕获：

| 变量 | 用途 | 处理方式 |
|------|------|---------|
| `mainWindow` | 窗口引用（dialog、webContents.send） | dep 传 `getMainWindow: () => mainWindow` |
| `feishuBridge` | 飞书桥接实例（重新赋值） | dep 传 `getFeishuBridge` + `setFeishuBridge` |
| `genProcess` 等 | gen 进程管理 | 留在 index.ts，不随 handler 迁移 |

### index.ts 改造后

`registerIpc()` 和 `registerFeishuIpc()` 合并为：

```typescript
function registerIpc() {
  const sharedDeps = { getMainWindow: () => mainWindow, appLogger, settingsStore };
  registerLogHandlers({ appLogger, rpcLogger });
  registerEditorHandlers({ settingsStore, ...sharedDeps });
  registerGitHandlers({ gitService, projectStore });
  registerAgentHandlers({ agentManager, ...sharedDeps });
  registerFeishuHandlers({ getFeishuBridge, setFeishuBridge, agentManager, ...sharedDeps });
  // ...
}
```

预计 `index.ts` 从 4,238 行降到 ~1,500 行（窗口管理 + 服务初始化 + 薄注册层）。

## 执行步骤

### Batch 1：薄封装命名空间（低风险）

1. 创建 `src/main/ipc/` 目录和 `index.ts` 骨架
2. 逐个提取：`logHandlers` → `editorHandlers` → `skillHandlers` → `extensionHandlers` → `terminalHandlers` → `storeHandlers` → `scratchPadHandlers`
3. 每提取一个命名空间后运行 `npm run typecheck`
4. Batch 1 完成后提交

### Batch 2：中等复杂度命名空间

1. 提取：`projectHandlers` → `fileHandlers` → `sessionHandlers` → `gitHandlers` → `promptHandlers` → `appHandlers`
2. `getVisibleProjects()` 等局部 helper 随对应命名空间迁移
3. 每提取一个后 typecheck
4. Batch 2 完成后提交

### Batch 3：复杂命名空间

1. 提取：`agentHandlers` → `feishuHandlers`（从 `registerFeishuIpc` 迁移）→ `petHandlers` → `configHandlers` → `piHandlers`
2. 处理 `feishuBridge` 的 getter/setter dep
3. Batch 3 完成后提交

## 风险与缓解

- **纯机械搬迁**：handler 逻辑逐行复制，不重写任何业务逻辑
- **typecheck 验证**：每提取一个命名空间后 typecheck，确保类型安全
- **不改变 IPC 通道**：`ipcChannels` 定义和 preload 都不动，只搬 main 侧 handler 注册
- **可变状态**：通过 getter/setter dep 显式传递，不改变运行时行为

## 验证

- `npm run typecheck` — 每个 batch 后运行
- 手动启动应用，验证：
  - 项目列表加载正常（projects namespace）
  - 创建/关闭 Agent 正常（agents namespace）
  - Git 面板操作正常（git namespace）
  - 飞书连接正常（feishu namespace）
  - 日志查看正常（logs namespace）
