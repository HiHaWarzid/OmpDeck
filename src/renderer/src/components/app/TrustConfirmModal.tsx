import { t } from "../../i18n";
import { ConfirmDialog } from "../ui/ConfirmDialog";

/**
 * 项目信任确认弹窗。
 *
 * 当用户在 pi-desktop 中打开含 .pi 配置资源（扩展 / skills / settings / SYSTEM.md 等）
 * 且未在 trust.json 记录决策的项目时，由主进程 AgentManager.ensureProjectTrust 经 IPC
 * 触发本弹窗。pi 在 RPC 模式下 project_trust 事件 hasUI 恒为 false，无法用其内置流程弹窗，
 * 因此信任决策由桌面端自行完成。
 *
 * 用户选择后通过 onChoose 回传，主进程据此决定是否启动 pi 进程：
 *   - trust-remember：永久信任，写入 trust.json
 *   - trust-session：仅本次会话信任，不落盘
 *   - deny：拒绝信任，阻止 Agent 创建并记录 false 避免重复打扰
 *
 * 三选一复用共享 ConfirmDialog（取消位 = 拒绝），Esc 等同于拒绝：
 * 用户明确关闭弹窗时按最保守的决策处理，既不会静默信任项目，也不会把 Agent 挂在等待态。
 * 遮罩点击不关闭："误点弹窗外" 与 "明确拒绝并落盘" 必须区分开，拒绝会被持久化。
 */
export function TrustConfirmModal(props: {
	cwd: string;
	projectName: string;
	onChoose: (choice: "trust-remember" | "trust-session" | "deny") => void;
}) {
	return (
		<ConfirmDialog
			title={t("agent.trust.title")}
			message={t("agent.trust.message")}
			confirmLabel={t("agent.trust.trustRemember")}
			cancelLabel={t("agent.trust.deny")}
			closeOnOutsideClick={false}
			onCancel={() => props.onChoose("deny")}
			onConfirm={() => props.onChoose("trust-remember")}
			secondaryAction={{
				label: t("agent.trust.trustSession"),
				onClick: () => props.onChoose("trust-session"),
			}}
		>
			<p className="modal-radix-confirm-detail">
				{t("agent.trust.project")}: {props.cwd}
			</p>
		</ConfirmDialog>
	);
}
