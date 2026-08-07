# ADR-0006：AFK 分支历史卫生

- 状态：Accepted
- 日期：2026-08-07

## 背景
两个 git 历史问题：
1. 重跑时 afk 分支落后 main，PR 基线陈旧。
2. `[afk-wip]` 快照 commit 会混进 PR（重跑场景尤甚），review 噪音。
3. `WorktreeService.remove` 不删 `afk-*` 分支（只删 `ompdeck//pideck/` 前缀），PR 合并后分支永久留存。

## 决策
1. **重跑 rebase**：碰撞复用时先 `git rebase --onto <current-main> <old-base> afk-{ticketId}-{slug}`；rebase 冲突 → `failed`（走 ADR-0005），不强行解。
2. **complete 前清 wip**：开 PR 前移除所有 `[afk-wip]` commit、保留 agent 真实 commit（`git rebase` 跳过 wip 行，或 `reset --soft` 到 base 后按真实改动重组）。若无真实 commit → 不开 PR，走失败路径。
3. **分支 GC**：PR 合并（`gh pr merge`）后删 afk 分支（`git push origin --delete`）。P0 AFK 不监听 PR 合并事件，提供"已开 PR 待合并"列表给人，人合并后人删；后续迭代可加 webhook 自动删。

## 后果
- ✅ PR 干净（无 wip 噪音、基线新鲜）。
- ✅ 失败分支留 `[afk-wip]` 供重跑。
- ✅ 已合并分支可清理，不无限累积。
- ❌ rebase 冲突直接 `failed`，需人介入解冲突。
- ❌ P0 分支 GC 半人工（AFK 不监听 PR 合并）。
