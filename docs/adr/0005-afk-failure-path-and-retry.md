# ADR-0005：AFK 失败路径与重试策略

- 状态：Accepted
- 日期：2026-08-07

## 背景
R2-1 只定义了 `complete` 的 issue 流转（`ready-for-agent`→`ready-for-human`）。`failed`（error/超时/预检/异常）时 issue 标什么、是否自动重试未定。无脑重试会循环；不重标则 issue 卡在 `ready-for-agent` 无人知。

## 决策
`failed` 时：`gh issue comment <n>` 附失败原因（best-effort，从 AgentManager `lastError` 或超时类型）+ `gh issue edit <n> --remove-label ready-for-agent --add-label needs-info`。**不自动重试**。人介入修 issue 后手动重标 `ready-for-agent` 触发重跑；Q6 碰撞复用从 `[afk-wip]` commit 继续。

## 后果
- ✅ `needs-info` 语义贴合（"等更多信息/人介入"）。
- ✅ 不自动重试避免失败循环。
- ✅ `[afk-wip]` 保留保证重跑不丢进度。
- ❌ 失败原因可能拿不到（`AgentTab` 暂无 `lastError` 字段，见 scout 注记）——此时 comment 通用消息；实施时需给 `AgentTab` 加 `lastError?: string`。
- ❌ 需人工干预才能重跑（P0 可接受）。
