import type { BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { AgentEvent, AgentEventSink } from "../pi/agentEventSink";

/**
 * 语义事件 → 桌面窗口的适配器。
 *
 * 通道名只活在这一层：领域（AgentManager）与主进程内消费者（AFK/宠物）看到的是
 * AgentEvent；渲染层看到的仍是原来的 11 个通道与负载形状（本层逐字段保真映射，
 * 不改变 wire 契约）。手机端将来订阅同一个 sink，不需要碰这里。
 */

type ChannelMessage = { channel: string; payload: unknown };

/** `settled` / `status-changed` 是进程内信号，没有桌面通道。 */
function toChannelMessage(event: AgentEvent): ChannelMessage | null {
	switch (event.kind) {
		case "message-appended":
			return {
				channel: ipcChannels.agentsMessage,
				payload: { agentId: event.agentId, replaceFrom: event.replaceFrom, messages: event.messages },
			};
		case "thinking-delta":
			return {
				channel: ipcChannels.agentsThinking,
				payload: { agentId: event.agentId, thinking: event.thinking },
			};
		case "runtime-changed":
			return {
				channel: ipcChannels.agentsRuntimeState,
				payload: { agentId: event.agentId, state: event.state },
			};
		case "tabs-changed":
			return { channel: ipcChannels.agentsState, payload: event.tabs };
		case "ui-request":
			return { channel: ipcChannels.agentsUiRequest, payload: event.request };
		case "trust-request":
			return {
				channel: ipcChannels.agentsTrustRequest,
				payload: { requestId: event.requestId, cwd: event.cwd, projectName: event.projectName },
			};
		case "notice":
			return {
				channel: ipcChannels.agentsNotice,
				payload: {
					agentId: event.notice.agentId,
					message: event.notice.message,
					i18nKey: event.notice.i18nKey,
					kind: event.notice.kind,
					duration: event.notice.durationMs,
				},
			};
		case "log":
			return { channel: ipcChannels.agentsLog, payload: { agentId: event.agentId, text: event.text } };
		case "subagents-changed":
			return {
				channel: ipcChannels.agentsSubagents,
				payload: { agentId: event.agentId, subagents: event.subagents },
			};
		case "command-catalog":
			return {
				channel: ipcChannels.agentsCommandCatalog,
				payload: { agentId: event.agentId, commands: event.commands },
			};
		case "settled":
		case "status-changed":
			return null;
	}
}

export type ElectronAgentEventBridge = {
	/**
	 * 绑定主窗口并开始投递。同一时刻只绑定一个窗口；
	 * 窗口关闭时自动退订，保证 `sink.hasUiResponders()` 与「真有人能作答」一致
	 * （否则 headless 期间的项目信任询问会白等 60 秒才拒绝）。
	 */
	attach(window: BrowserWindow): void;
	detach(): void;
};

export function createElectronAgentEventBridge(events: AgentEventSink): ElectronAgentEventBridge {
	let unsubscribe: (() => void) | null = null;
	let boundWindow: BrowserWindow | null = null;

	const stopForwarding = () => {
		unsubscribe?.();
		unsubscribe = null;
	};
	const handleClosed = () => {
		stopForwarding();
		boundWindow = null;
	};

	return {
		attach(window) {
			stopForwarding();
			boundWindow?.removeListener("closed", handleClosed);
			boundWindow = window;
			window.once("closed", handleClosed);
			// 桌面窗口能弹信任确认/扩展 UI，因此计入「可作答消费者」。
			unsubscribe = events.onEvent(
				(event) => {
					if (window.isDestroyed()) return;
					const message = toChannelMessage(event);
					if (message) window.webContents.send(message.channel, message.payload);
				},
				{ answersUi: true },
			);
		},
		detach() {
			stopForwarding();
			boundWindow?.removeListener("closed", handleClosed);
			boundWindow = null;
		},
	};
}
