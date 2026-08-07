# OmpDeck AFK — 领域语言 (CONTEXT.md)

> 记录 OmpDeck AFK 自动编排功能的领域术语（ubiquitous language）。
> AFK = 应用内"挂机"模式：无值守情况下，按 GitHub 工单自动派发 pi Agent 到隔离 worktree 完成 T1 级编码任务。
> 维护规则：术语敲定时更新；不可逆决策见 `docs/adr/`。

## 术语

### Ticket（工单）
AFK 的工作单元来源。**单一来源 = GitHub Issue**（via `gh` CLI，仓库 `HiHaWarzid/OmpDeck`）。
- 本上下文中 `ticket` **仅指 GitHub Issue**，不再混用 `.scratch` 文件或运行时结构体名。
- 选取条件：label `ready-for-agent`（见 `docs/agents/triage-labels.md`）。
- AFK 内部承载结构命名 `AfkTask`，避免与 Issue 本身混淆。

### AfkTask（AFK 任务运行时记录）
从一个 Ticket 派生出的运行时实体，含：ticketRef（issue number）、worktree 路径、分支名、agent tab id、状态、起止时间。持久化于 `userData/afk-state.json`。

### Brief（任务简报）
派发给 spawned agent 的工单内容。**原样派发**：issue title 作 goal，issue body 作 brief 原文，`workflow:*` 标签作工作流提示。AFK 不解析改写（呼应 Q11：不强制工作流，工单声明什么就派什么）。

### Complete（完成）
AFK 终态之一。判据：spawned agent 的 `AgentStatus` 由 `running` 经 `agent_settled` 转为 `idle`，且未触发 `error`。**`complete` 只表示"跑到停"，不表示"做对了"。**

### Success（成功）
独立于 AFK 的判断：afk 分支/PR 是否可合并、是否真正解决工单。**由独立 review 判定，不在 AFK 内做。** `complete ≠ success`。

### Failed（失败）
AFK 终态之一。判据：agent 进入 `error` 状态、超过最大等待时长、RPC 预检失败、或 orchestrator 自身异常。超时留下的 WIP 按 WIP 保留策略保留。

### Afk Branch（AFK 分支）
为单个 AfkTask 创建的 git 分支，命名 `afk-{ticketId}-{slug}`（`-` 分隔，不用 `/`；slug 取自 issue title）。碰撞时复用同名分支，从上次 WIP commit 继续。

### Worktree WIP 保留
无论 `complete` 还是 `failed`，删 worktree 前必须先 `git add -A && git commit` 保存 WIP 快照。**永不裸 `git worktree remove --force` 抹工作树。** 超时/崩溃留下的 worktree 保留，等下次同 ticket 重跑复用或 TTL 后 GC。

### AFK Orchestrator（编排器）
主进程内负责"选 ticket → 建 worktree/分支 → spawn agent → 监听 idle/error → 标终态 → 推分支/开 PR → 回写 issue label"的组件。显式编排，AgentManager 仅作"被调用的 spawn 工具"，不侵入其状态机。

### Selection（工单选取）
`gh issue list --state open --label ready-for-agent`（在目标项目 worktree 内运行，`gh` 由 `git remote -v` 自动推断仓库），丢弃已 assign 的，认领 `gh issue edit <n> --add-assignee @me`（session's first write），一次一个串行。

### Project Scope（AFK 作用域）
AFK 作用于 OmpDeck 中**当前选中的项目**：工单来自该项目的 git remote（`gh` 自动推断），worktree 建在该项目路径下，PR 开到该项目仓库。P0 单项目串行，不跨项目并行。

### Timeout（超时）
单 agent 最大等待 **30 分钟**（写入 AppSettings 可配）。超时 → `failed`，按 ADR-0003 留 WIP、不裸删。

### Failed 条件（枚举）
任一即 `failed`：agent `error` 状态 / 超时 / RPC 预检失败 / orchestrator 异常。（`error` 与 `idle` 的精确关系由 scout 核验后微调实现，不改变决策。）

### Review（独立评审）
`complete` 后：AFK 推 afk 分支、`gh pr create`、issue 重标 `ready-for-agent`→`ready-for-human`、AFK 停手。PR 合并由人决定，issue 由人关闭。AFK 不 spawn review agent。`success` 判定在 review 阶段，不在 AFK 内。

### Failed Path（失败路径）
`failed` 时：`gh issue comment` 附失败原因（best-effort）+ 重标 `ready-for-agent`→`needs-info`，不自动重试（ADR-0005）。

### Retry（重试）
AFK 不自动重试失败任务。人修 issue 后重标 `ready-for-agent` 触发重跑，碰撞复用从 `[afk-wip]` 继续（Q6）。

### Rebase-on-Reuse（重跑 rebase）
重跑碰撞复用时先 rebase afk 分支 onto 当前 main；冲突 → `failed`（ADR-0006）。

### PR Hygiene（PR 卫生）
开 PR 前移除 `[afk-wip]` commit、保留真实 commit；无真实 commit 不开 PR（ADR-0006）。

### Branch GC（分支清理）
PR 合并后删 afk 分支；P0 半人工（AFK 不监听合并，人删或后续 webhook）。

### Double Timeout（双超时）
`AGENT_SETTLED_TIMEOUT_MS=5000`（AgentManager 已有，settled 检测）与 AFK `30min`（任务预算，可配）叠加：5s 判"agent 停了"，30min 判"任务超时"。

### AFK Identity（AFK 身份）
P0 用 `gh auth` 认证账户 `@me` 作 assignee（显示为启 AFK 的人）；bot 账户留作未来优化。

### Environment Inheritance（环境继承）
worktree 只继承项目仓库**已提交**的 `AGENTS.md`/`.omp/skills`。AFK **不注入**约定文件（所有者责任）；启动时检测无 `AGENTS.md` 则 warn 不阻塞。

### AfkTask Lifecycle（记录生命周期）
创建 worktree 时 AFK 显式 `projectStore.add(path, parentId)`（绕 IPC），清理时 `remove`；终态后 `AgentManager.stop` + 关 tab 防泄漏。

### Crash Recovery（崩溃恢复，细化）
启动时读 `afk-state.json`：若记录的 agent PID 仍存活 → 不判死、标 needs-review 等人；PID 死 → 强清死 worktree（留 WIP per ADR-0003）。

## 不在 AFK 范围
- `success` 判定（留给 review）。
- 工单内容质量（brief 由 issue 作者负责）。
- 跨多 ticket 的任务依赖编排（P0 单 ticket 串行）。
