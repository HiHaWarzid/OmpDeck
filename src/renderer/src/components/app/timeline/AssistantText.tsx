/** 助手正文渲染：流式期间纯文本近似，结束后按需加载 Markdown 管线。
 *
 *  markdown / KaTeX 栈（react-markdown、remark-*、rehype-katex、katex CSS）此前静态
 *  import 在本文件，而 App → TurnRow → MessageListContent → AssistantText 属于渲染进程
 *  入口图，导致打包后入口的 modulepreload 必然带上 vendor-markdown。现在改用 React.lazy
 *  动态加载：基础管线 MarkdownBody（无 KaTeX）；仅当消息里探测到公式时才加载 MarkdownMath
 *  （追加 remark-math / rehype-katex / katex.min.css）。
 */
import { lazy, memo, Suspense, useMemo } from "react";
import { sameImageListForRender } from "../AppUtils";
import { t } from "../../../i18n";
import type { ImageContent } from "../../../../../shared/types";
import { stripAnsi, stripThinkingTags } from "../format";

const LazyMarkdownBody = lazy(() =>
	import("./MarkdownBody").then((m) => ({ default: m.MarkdownBody })),
);
const LazyMarkdownMath = lazy(() =>
	import("./MarkdownMath").then((m) => ({ default: m.MarkdownMath })),
);

/**
 * 公式探测（便宜正则，避免为了判断是否加载 KaTeX 而先跑 remark 解析）。
 * 覆盖 remark-math 的 $$...$$、$...$ 与走 LatexBlock 的 ```latex/tex/math 围栏。
 * 宁可误判（多加载一次 math chunk），也不能漏判——漏判会把公式降级成纯文本。
 */
const MATH_HINT_RE =
	/\$\$[\s\S]*?\$\$|(?:^|[^\\$])\$(?=\S)[^$\n]*?\$(?!\d)|(?:```|~~~)\s*(?:latex|tex|math)\b/i;

export const AssistantText = memo(
	function AssistantText(props: {
		text: string;
		images?: ImageContent[];
		onPreviewImage: (image: ImageContent) => void;
		onOpenExternal: (url: string) => void;
		onOpenFile?: (path: string) => void;
		/** 当前消息是否正在流式追加。为 true 时走纯文本近似渲染（不解析 markdown），
		 *  回答结束后一次性切完整渲染——流式期间避免每个 token 都对不断增长的全量正文
		 *  跑 remark 解析（O(n²) 卡顿源）。取舍：流式中无行内格式，结束瞬间切换。 */
		isStreaming?: boolean;
	}) {
		// 清理 ANSI 转义码与 <thinking> 标签，thinking 由调用方通过 ThinkingBlock 渲染
		const cleanText = stripThinkingTags(stripAnsi(props.text));
		// 流式期间用纯文本近似渲染，回答结束后切回含数学/图表的完整渲染。
		const streaming = Boolean(props.isStreaming);
		// 普通消息不加载 KaTeX 栈；探测本身只扫一遍文本，成本远低于 markdown 解析。
		const hasMath = useMemo(() => MATH_HINT_RE.test(cleanText), [cleanText]);

		const imagesMarkup = props.images && props.images.length > 0 ? (
			<div className="message-images">
				{props.images.map((img, index) => (
					<img
						key={index}
						src={`data:${img.mimeType};base64,${img.data}`}
						alt={t("app.imageAlt", { index: index + 1 })}
						className="message-image"
						loading="lazy"
						decoding="async"
						onClick={() => props.onPreviewImage(img)}
					/>
				))}
			</div>
		) : null;

		// 流式：纯文本 + pre-wrap，不做 markdown 解析（消除 O(n²) 全文重解析）。
		if (streaming) {
			return (
				<div className="assistant-text markdown-body">
					{imagesMarkup}
					<div className="assistant-text-streaming">{cleanText}</div>
				</div>
			);
		}

		return (
			<div className="assistant-text markdown-body">
				{imagesMarkup}
				{/* 懒加载期间先渲染纯文本（与流式同一排版），避免空白闪烁或半成品 markdown；
				    chunk 到达后 React 自动替换为完整渲染结果。 */}
				<Suspense fallback={<div className="assistant-text-streaming">{cleanText}</div>}>
					{hasMath ? (
						<LazyMarkdownMath
							text={cleanText}
							onOpenExternal={props.onOpenExternal}
							onOpenFile={props.onOpenFile}
						/>
					) : (
						<LazyMarkdownBody
							text={cleanText}
							onOpenExternal={props.onOpenExternal}
							onOpenFile={props.onOpenFile}
						/>
					)}
				</Suspense>
			</div>
		);
	},
	// 自定义比较：文本、流式标记、图片一致时跳过重渲染。回调函数（onPreviewImage/onOpenExternal/
	// onOpenFile）行为稳定（读 ref 或 setState），不参与比较，避免 App 每次渲染新建内联箭头
	// 函数导致 memo 失效——历史消息在流式期间因此不再重复解析 Markdown，从根上消除卡顿。
	// images 按内容比较：TurnRow 每轮渲染重拼图片数组，引用比较会使 memo 恒定失效。
	(prev, next) =>
		prev.text === next.text &&
		prev.isStreaming === next.isStreaming &&
		sameImageListForRender(prev.images, next.images),
);
