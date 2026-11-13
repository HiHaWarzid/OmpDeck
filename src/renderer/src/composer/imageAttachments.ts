/**
 * 图片附件管线：粘贴/拖拽的 File → pi RPC 可识别的 ImageContent。
 *
 * 与 composer 规则分离的原因：这里全是浏览器 API（FileReader / Image / canvas），
 * 单测不需要覆盖压缩细节；规则模块只关心「哪些路径是图片」。
 */
import type { ImageContent } from "../../../shared/types";

/** 原始文件上限：误粘超大图片会卡住渲染进程，也撑爆 RPC 传输。 */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** 压缩目标：最长边 2000px、JPEG 质量 0.86，控制 base64 体积与模型上下文成本。 */
const IMAGE_MAX_EDGE = 2000;
const IMAGE_JPEG_QUALITY = 0.86;
const IMAGE_SUPPORTED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export function dataUrlToImageContent(dataUrl: string, fallbackMimeType: string): ImageContent {
	const [meta, data = ""] = dataUrl.split(",");
	const mimeType = meta.match(/^data:(.*?);base64$/)?.[1] || fallbackMimeType;
	return { type: "image", data, mimeType };
}

async function fileToImageContent(file: File): Promise<ImageContent> {
	const dataUrl = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error);
		reader.onload = () => resolve(String(reader.result));
		reader.readAsDataURL(file);
	});
	return dataUrlToImageContent(dataUrl, file.type);
}

async function resizeImageFile(file: File, maxEdge: number, quality: number): Promise<ImageContent> {
	const dataUrl = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error);
		reader.onload = () => resolve(String(reader.result));
		reader.readAsDataURL(file);
	});
	const image = await new Promise<HTMLImageElement>((resolve, reject) => {
		const element = new Image();
		element.onerror = () => reject(new Error("image decode failed"));
		element.onload = () => resolve(element);
		element.src = dataUrl;
	});
	const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
	const width = Math.max(1, Math.round(image.width * scale));
	const height = Math.max(1, Math.round(image.height * scale));
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
	// JPEG 更省 token/传输体积；透明 PNG/WebP 保持 PNG，避免截图透明区域变黑。
	const outputType = file.type === "image/png" ? "image/png" : "image/jpeg";
	return dataUrlToImageContent(canvas.toDataURL(outputType, quality), outputType);
}

/**
 * 处理图片文件：尺寸/类型校验 → 压缩（GIF 保留动图原样）。
 * 拒绝原因经 notify 交给调用方翻译文案（本模块不依赖 i18n）。
 */
export async function processImageFile(
	file: File,
	notify: (reason: "too-large" | "unsupported-type") => void,
): Promise<ImageContent | null> {
	if (file.size > IMAGE_MAX_BYTES) {
		notify("too-large");
		return null;
	}
	if (!IMAGE_SUPPORTED_TYPES.includes(file.type)) {
		notify("unsupported-type");
		return null;
	}
	// GIF 可能是动图，canvas 压缩会丢失动画，保留原始数据。
	if (file.type === "image/gif") return fileToImageContent(file);
	return resizeImageFile(file, IMAGE_MAX_EDGE, IMAGE_JPEG_QUALITY).catch(() =>
		fileToImageContent(file),
	);
}
