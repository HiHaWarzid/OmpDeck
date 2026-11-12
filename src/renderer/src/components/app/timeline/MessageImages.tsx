/** 消息图片条：用户附件、助手图片、工具结果图片共用同一渲染与预览行为。
 *
 *  容器 class 与单图 class 由调用方传入，保持三处既有视觉（上/下文气泡、工具卡）
 *  不因抽取而改变；点击统一交给图片预览弹层。
 */
import { memo } from "react";
import { t } from "../../../i18n";
import type { ImageContent } from "../../../../../shared/types";

export const MessageImages = memo(function MessageImages(props: {
	images: ImageContent[];
	onPreviewImage?: (image: ImageContent) => void;
	className: string;
	imageClassName: string;
}) {
	return (
		<div className={props.className}>
			{props.images.map((img, index) => (
				<img
					key={index}
					src={`data:${img.mimeType};base64,${img.data}`}
					alt={t("app.imageAlt", { index: index + 1 })}
					className={props.imageClassName}
					loading="lazy"
					decoding="async"
					onClick={() => props.onPreviewImage?.(img)}
				/>
			))}
		</div>
	);
});
