# 候选 5: 从 App.tsx 提取 useAgentSessions hook

## Context

App.tsx（10,165 行）包含 50+ useState，其中 agent/session 相关状态散布在 L576-L800（声明）、L1552-L1760（计算值）、L2275-L2470（RPC 流式 effect）、L3649-L3710（会话加载）、L4452-L4860（agent 生命周期）。目标是按 `useFeishuBridge` 模式提取一个 `useAgentSessions` hook，减少 ~550-650 行。

与 useFeishuBridge 不同，agent/session 状态与项目、UI、settings 深度耦合，无法完全自包含。hook 接收 `deps` 参数注入依赖，UI 副作用留在 App.tsx。

## 范围

**迁入 hook：**
- 状态：`agents`, `pendingAgents`, `activeAgentId`, `activeAgentByProject`, `messagesByAgent`, `runtimeStateByAgent`, `sessions`, `sessionsByProject`, `sessionLoadingByProject`
- Refs：`agentsRef`, `activeAgentIdRef`, `pendingAgentsRef`, `runtimeStateByAgentRef`, `agentStatusByAgentRef`, `sessionRequestByProjectRef`, `sessionRefreshRunningRef`, `sessionRefreshPendingRef`, `displayAgentsRef`
- 计算值：`displayAgents` (useMemo), `activeAgent`, `activeMessages`
- 纯动作：`applyAgentRuntimeState`, `refreshRuntimeState`, `cycleModel`, `cycleThinking`, `editMessage`, `refreshSessions`, `refreshProjectSessions`
- 工具函数：`isPendingAgentId`（一行纯函数，直接搬入 hook 文件）

**留在 App.tsx（深度耦合）：**
- `createAgent` — 触发 brandLogoReplay、terminal、drawer 等 UI 副作用
- `closeAgent`（5 行）— 调用 `triggerBrandLogoReplay` + `api.agents.stop`
- `abortAgent` — 操作 `streamingThinking` UI 状态
- `compactAgent` — 使用 `setCompacting` UI 状态
- `deleteMessage` — 使用 `setConfirmDialog`
- RPC 流式 effect（L2275-L2470）— 耦合 terminal/drawer/prompt/images/queuedPrompts

**RPC effect 交互**：effect 留在 App.tsx，通过 hook 暴露的 `setAgents`/`setPendingAgents`/`setActiveAgentId`/`setMessagesByAgent`/`pendingAgentsRef`/`runtimeStateByAgentRef` 更新 agent 状态。这些是 React 原生 setState dispatcher，行为不变。

## Hook 接口

```ts
// src/renderer/src/hooks/useAgentSessions.ts

interface UseAgentSessionsDeps {
  activeProjectId: string | undefined;
  t: (key: string, params?: Record<string, unknown>) => string;
  showToast: (message: string, duration?: number) => void;
  onSessionsByProjectChanged?: (projectId: string, sessions: SessionSummary[]) => void;
}

// 返回：state + setters + refs + computed + actions
// 完整接口见实现，关键部分：
// - state: agents, pendingAgents, activeAgentId, activeAgentByProject,
//   messagesByAgent, runtimeStateByAgent, sessions, sessionsByProject,
//   sessionLoadingByProject
// - computed: displayAgents, activeAgent, activeMessages
// - refs: agentsRef, pendingAgentsRef, activeAgentIdRef, displayAgentsRef,
//   runtimeStateByAgentRef
// - setters: setAgents, setPendingAgents, setActiveAgentId,
//   setActiveAgentByProject, setMessagesByAgent, setRuntimeStateByAgent
// - actions: applyAgentRuntimeState, refreshRuntimeState, refreshSessions,
//   refreshProjectSessions, cycleModel, cycleThinking, editMessage
// - utils: isPendingAgentId
```

## App.tsx 调用方式

```tsx
const {
  agents, pendingAgents, activeAgentId, /* ... state ... */
  displayAgents, activeAgent, activeMessages,
  agentsRef, pendingAgentsRef, /* ... refs ... */
  setAgents, setPendingAgents, /* ... setters ... */
  applyAgentRuntimeState, refreshRuntimeState, /* ... actions ... */
  isPendingAgentId,
} = useAgentSessions({
  activeProjectId,
  t,
  showToast: showNotice,
  onSessionsByProjectChanged: (pid, sessions) => {
    setVisibleProjectChildCountByProject((c) => ({ ...c, [pid]: c[pid] ?? SIDEBAR_PROJECT_CHILD_PAGE_SIZE }));
  },
});
```

## 实现步骤

### Step 0: 创建 hook 骨架（纯状态搬迁，零行为变化）
- 创建 `src/renderer/src/hooks/useAgentSessions.ts`
- 搬入状态声明 + refs + `isPendingAgentId`
- 搬入 `displayAgents` useMemo, `activeAgent`, `activeMessages`
- 暴露 state + setters + refs + computed
- App.tsx：用 `useAgentSessions(...)` 替换搬走的声明
- **验证**：`npm run typecheck` + 手动冒烟（打开应用、切换项目、打开 agent）

### Step 1: 搬入纯动作
- 搬入 `applyAgentRuntimeState`, `refreshRuntimeState`, `cycleModel`, `cycleThinking`, `editMessage`
- 这些只需 `deps.t`, `deps.showToast`, `deps.activeProjectId`
- **验证**：`npm run typecheck` + 手动测试（切换 model、切换 thinking、编辑消息）

### Step 2: 搬入会话加载
- 搬入 `refreshSessions`, `refreshProjectSessions` + 三个去重 refs
- 接入 `deps.onSessionsByProjectChanged` 回调
- **验证**：`npm run typecheck` + 手动测试（展开项目加载会话、创建 agent 后刷新、并发刷新去重）

### Step 3: 验证 RPC effect 调用点
- 不搬代码，确认 L2275-L2470 的 effect 使用 hook 暴露的 setters/refs
- **验证**：`npm run typecheck` + 手动测试（发送 prompt 观察流式、关闭 agent 观察 terminal 清理、重启 agent 观察 pending→real 迁移）

### Step 4: 导出 hook
- 在 `src/renderer/src/hooks/index.ts` 添加 `export { useAgentSessions }`
- **验证**：`npm run typecheck`

## 关键文件

- `src/renderer/src/App.tsx` — 提取源（L576-L800 状态, L1552-L1760 计算, L2275-L2470 RPC effect, L3649-L3710 会话加载, L4452-L4860 agent 生命周期）
- `src/renderer/src/hooks/useAgentSessions.ts` — 新建 hook 文件
- `src/renderer/src/hooks/useFeishuBridge.ts` — 参考模板（`getApi()` 模式, typed API slice, state+actions 返回）
- `src/renderer/src/hooks/index.ts` — 添加 export

## 风险

1. **RPC effect 闭包过期** — effect 用空依赖注册一次，通过 ref 读最新状态。hook 暴露相同 refs，不改变依赖数组。
2. **`displayAgents` useMemo 身份变化** — 下游 useEffect 依赖它。保持 useMemo 在 hook 内部，deps 不变。
3. **`createAgent` 直接写 ref** — `pendingAgentsRef.current = [...]` 直接赋值。hook 暴露 `pendingAgentsRef`，保持 ref 同步行（`pendingAgentsRef.current = pendingAgents`）在 hook 内部。
4. **deps 对象身份** — 在 hook 顶部解构 `activeProjectId`, `t`, `showToast`，useCallback 依赖原始值而非 deps 对象。`onSessionsByProjectChanged` 在 App.tsx 中用 `useCallback` 包裹。

## 降级方案

如果时间紧迫，Step 0+1 单独交付即可减少 ~350-400 行，且零行为变化。Step 2-4 可后续追加。
