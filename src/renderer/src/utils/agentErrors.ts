/**
 * 将主进程抛出的 Agent 错误消息中的 BUSY_ 前缀码转为前端多语言文案。
 * 主进程在 agent 忙碌时返回 BUSY_STREAMING / BUSY_TOOL / BUSY_GENERIC 等内部码，
 * 前端需要翻译为用户可读的提示。
 */
import { t } from "../i18n";

export function translateAgentErrorMessage(msg: string): string {
	if (msg.startsWith("BUSY_STREAMING:")) return t("message.busyStreaming");
	if (msg.startsWith("BUSY_TOOL:")) return t("message.busyTool");
	if (msg.startsWith("BUSY_GENERIC:")) return t("message.busyGeneric");
	return msg;
}
