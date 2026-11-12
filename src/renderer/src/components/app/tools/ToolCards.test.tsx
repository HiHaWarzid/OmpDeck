// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setI18nLocale } from "../../../i18n";
import type { ChatMessage, ImageContent } from "../../../../../shared/types";
import { ToolCard } from "./ToolCards";

const IMAGE: ImageContent = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };

function makeToolMessage(overrides: Partial<ChatMessage>): ChatMessage {
	return {
		id: "t1",
		agentId: "a1",
		role: "tool",
		text: "✓ read",
		timestamp: Date.UTC(2026, 0, 1, 8, 0, 0),
		meta: { toolName: "read", status: "done" },
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

it("工具结果图片在折叠态也渲染，点击回调预览", () => {
	const onPreviewImage = vi.fn();
	act(() => {
		root.render(<ToolCard message={makeToolMessage({ images: [IMAGE] })} onPreviewImage={onPreviewImage} />);
	});

	const image = container.querySelector<HTMLImageElement>(".tool-card-images .message-image");
	expect(image).not.toBeNull();
	expect(image?.src).toBe(`data:image/png;base64,${IMAGE.data}`);

	act(() => image?.click());
	expect(onPreviewImage).toHaveBeenCalledWith(IMAGE);
});

it("没有图片的工具消息不渲染图片容器", () => {
	act(() => {
		root.render(<ToolCard message={makeToolMessage({})} />);
	});
	expect(container.querySelector(".tool-card-images")).toBeNull();
});
