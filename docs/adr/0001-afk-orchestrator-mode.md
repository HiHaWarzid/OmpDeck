# ADR-0001：AFK 采用 Orchestrator 模式

- 状态：Accepted
- 日期：2026-08-07

## 背景
AFK 需要"选 ticket → 建 worktree → spawn agent → 监听完成 → 标终态 → 回写 issue"的完整链路。两种候选：
- **(A) Orchestrator**：主进程内显式组件，串行驱动全流程，调用 `AgentManager.create/sendPrompt` + `WorktreeService` + `gh` CLI。
- **(B) 嵌入式**：把 AFK 逻辑塞进 `AgentManager`，或 spawn 一个"主控 agent"用 prompt 自编排。

## 决策
选 **(A) Orchestrator**。主进程新增 AFK 组件，显式编排；`AgentManager` 仅作"被调用的 spawn 工具"，不侵入其多 tab 状态机；`WorktreeService` 同样被显式调用（且需配合 `projectStore` 同步子项目记录，见 Q5）。

## 后果
- ✅ 状态/错误/崩溃恢复逻辑集中在主进程，可测、可持久化（`afk-state.json`）。
- ✅ 不污染 `AgentManager` 既有的多会话 tab 语义。
- ✅ 崩溃恢复只需重放 orchestrator 状态。
- ❌ orchestrator 需自带事件循环（监听 `addStateListener` 全量快照判 idle/error）。
- ❌ 编排逻辑不能像 agent 自编排那样靠自然语言扩展——P0 串行不需要，未来若要并行/依赖编排需再议。
