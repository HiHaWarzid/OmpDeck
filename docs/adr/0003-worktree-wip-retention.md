# ADR-0003：Worktree WIP 强制提交保留

- 状态：Accepted
- 日期：2026-08-07

## 背景
`WorktreeService.remove()` = `git worktree remove --force` + `rm -rf`，销毁未提交 WIP；运行中 agent 的保护只在 renderer，AFK 从主进程调用会绕过。AFK 无人值守，崩溃/超时后 WIP 丢失不可接受。

## 决策
AFK 删 worktree 前**必须** `git add -A && git commit`（WIP 快照），commit message 统一前缀 `[afk-wip]`；超时/崩溃**不删** worktree，但仍执行 `git add -A && commit` WIP 快照（让工作树干净，便于重跑复用），等重跑复用或 TTL 后 GC。**禁止**直接调 `remove()` 裸抹工作树。

## 后果
- ✅ WIP 可恢复（在 afk branch 的 `[afk-wip]` commit 里）。
- ✅ 碰撞复用可从上次 WIP 继续（见 Q6）。
- ✅ 崩溃后重启能重建上下文。
- ❌ afk branch 上会有 `[afk-wip]` 提交，review 时需识别（建议 PR 描述标注，或 review 时 squash）。
- ❌ 需保证 git commit author 配置存在（AFK 启动时校验 `user.name`/`user.email`，缺则用 AFK 默认值写入 repo local config）。
