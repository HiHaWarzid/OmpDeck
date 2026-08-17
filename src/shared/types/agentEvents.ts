import type { AgentRuntimeState, AgentStatus, AgentTab } from "./agent";
import type { ChatMessage } from "./message";

/**
 * AgentManager 语义事件（窄观察者面）：AFK 编排器与 renderer 订阅基于语义事件而非
 * 原始 RPC 事件/整表快照；字段最小化，只带订阅方需要的增量。
 */
export type AgentManagerEvent =
	| { type: "messageAppended"; agentId: string; message: ChatMessage }
	| { type: "statusChanged"; agentId: string; status: AgentStatus; tab: AgentTab }
	| { type: "runtimeStateChanged"; agentId: string; state: AgentRuntimeState }
	| { type: "settled"; agentId: string };

export type AgentManagerEventListener = (event: AgentManagerEvent) => void;
