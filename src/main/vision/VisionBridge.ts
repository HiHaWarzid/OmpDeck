/**
 * 视觉桥（Vision Bridge）：给非视觉模型"眼睛"。
 *
 * 用户在设置里配置 OpenAI 兼容端点 + 视觉模型；发送带图片的消息时，
 * 主进程把图片转成文本描述并注入上下文，非视觉模型也能"看到"图片内容。
 *
 * 与上游 pi 扩展方案（pi-deck-vision.ts 绑定 pi 扩展运行时）不同，
 * 本实现是纯主进程模块，协议无关，直接适配 omp 的图片消息形态。
 */

import type { ImageContent } from "../../shared/types";

export type VisionBridgeConfig = {
	enabled: boolean;
	baseUrl: string;
	apiKey: string;
	model: string;
	prompt: string;
	timeoutMs: number;
};

export type VisionDescribeResult = {
	ok: true;
	text: string;
} | {
	ok: false;
	error: string;
};

/** 配置是否完整可用（启用 + 端点/模型/key 非空） */
export function isVisionBridgeReady(config: VisionBridgeConfig): boolean {
	return Boolean(
		config.enabled &&
			config.baseUrl.trim() &&
			config.apiKey.trim() &&
			config.model.trim(),
	);
}

/**
 * 调用 OpenAI 兼容 chat completions 端点把图片转成文本描述。
 * 图片以 data URL 形式作为 user 消息的 image_url 内容块。
 */
export async function describeImage(
	config: VisionBridgeConfig,
	image: ImageContent,
): Promise<VisionDescribeResult> {
	const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
	const payload = {
		model: config.model.trim(),
		max_tokens: 1024,
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: config.prompt || "请详细描述这张图片的内容。",
					},
					{
						type: "image_url",
						image_url: {
							url: `data:${image.mimeType};base64,${image.data}`,
						},
					},
				],
			},
		],
	};
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.timeoutMs || 120_000);
	try {
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${config.apiKey.trim()}`,
			},
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			return {
				ok: false,
				error: `Vision API ${response.status}: ${detail.slice(0, 200)}`,
			};
		}
		const data = (await response.json()) as {
			choices?: Array<{ message?: { content?: unknown } }>;
		};
		const content = data.choices?.[0]?.message?.content;
		const text = typeof content === "string" ? content.trim() : "";
		if (!text) return { ok: false, error: "Vision API returned empty content" };
		return { ok: true, text };
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			return { ok: false, error: `Vision request timed out after ${config.timeoutMs}ms` };
		}
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timer);
	}
}
