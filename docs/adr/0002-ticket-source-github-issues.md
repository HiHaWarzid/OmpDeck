# ADR-0002：AFK 工单源为 GitHub Issues

- 状态：Accepted
- 日期：2026-08-07

## 背景
AFK 需要稳定、单一、可协作的工单源。候选：
- **(A) GitHub Issues via `gh` CLI**（仓库已有 `docs/agents/issue-tracker.md` 约定 + triage labels）。
- **(B) `.scratch/<feature>/issues/*.md`**（凭空发明，无任何代码读取）。
- **(C) 两者并存**。

## 决策
选 **(A) GitHub Issues**。`.scratch/<feature>/` 保留为人工草稿约定（`ticket.md`+`spec.md`），AFK 既不读也不写工单。

## 后果
- ✅ 单一真相，与团队协作流程一致。
- ✅ `gh` CLI 已是仓库约定（`docs/agents/issue-tracker.md`）。
- ✅ 状态回写天然：`gh issue comment/close/edit --label`。
- ❌ 依赖 `gh` 已认证环境（issue-tracker.md 已规定，运行前需校验）。
- ❌ 工单内容质量依赖 issue 作者；brief 原样派发（呼应 Q11），AFK 不修正。
