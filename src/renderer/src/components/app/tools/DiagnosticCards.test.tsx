// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setI18nLocale } from "../../../i18n";
import type { ChatMessage } from "../../../../../shared/types";
import { DiagnosticMessageCard } from "./DiagnosticCards";

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
	return {
		id: "m1",
		agentId: "a1",
		role: "system",
		text: "输出",
		timestamp: Date.UTC(2026, 0, 1, 8, 0, 0),
		...overrides,
	};
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	setI18nLocale("zh-CN");
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

it("本地命令输出用命令名标题，不冒充诊断告警", () => {
	act(() => {
		root.render(
			<DiagnosticMessageCard
				message={makeMessage({
					text: "Context window: 1000000 tokens (1% used)",
					meta: { type: "commandOutput", command: "context" },
				})}
			/>,
		);
	});

	expect(container.querySelector(".diagnostic-card-header")?.textContent).toContain("/context");
	expect(container.querySelector(".diagnostic-card")?.getAttribute("data-type")).toBe("commandOutput");
});

it("缺失命令名时退回通用标题，普通系统消息仍是系统状态", () => {
	act(() => {
		root.render(
			<DiagnosticMessageCard
				message={makeMessage({ text: "No background jobs running.", meta: { type: "commandOutput" } })}
			/>,
		);
	});

	expect(container.querySelector(".diagnostic-card-header")?.textContent).toContain("命令输出");

	act(() => {
		root.render(<DiagnosticMessageCard message={makeMessage({ text: "系统状态文本" })} />);
	});

	expect(container.querySelector(".diagnostic-card-header")?.textContent).toContain("系统状态");
});
