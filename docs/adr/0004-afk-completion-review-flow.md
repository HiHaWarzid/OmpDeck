# ADR-0004：AFK 完成后开 PR + 重标 ready-for-human

- 状态：Accepted
- 日期：2026-08-07

## 背景
`complete` 只表"跑到停"，`success` 需独立 review（CONTEXT.md / ADR-0001 已立）。需决定 review 怎么落地。候选：
- (a) 只重标 label 不开 PR；
- (b) AFK 再 spawn `/skill:code-review` 自审；
- (c) AFK 推分支 + 开 PR + 重标 `ready-for-human` + 停手；
- (d) 完全人工，AFK 只留分支不碰 GitHub。

## 决策
选 **(c)**。AFK 完成后：`git push` afk 分支 → `gh pr create --head afk-{ticketId}-{slug} --base <项目默认分支> --body ...` → `gh issue edit <n> --remove-label ready-for-agent --add-label ready-for-human` → 停手。**不** spawn review agent。

## 后果
- ✅ `ready-for-human` 贴合现有 triage label 语义（"Requires human implementation"）。
- ✅ PR 是天然 review surface，CI / 人审走 GitHub 原生流程。
- ✅ 避免 review-agent 递归（review-agent 自己又是 AFK 任务）。
- ❌ 依赖项目仓库有 push 权限 + 可开 PR 的 remote；无 remote 时 AFK 退化为"只留分支 + 重标 label"，PR 由人手动开。
- ❌ AFK 完成 ≠ 可合并；PR 可能被拒、issue 可能被 reopen——由人处理，AFK 不自动重试。
