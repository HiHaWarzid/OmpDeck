/** 数学公式版 Markdown 渲染管线：在基础管线之上叠加 remark-math / rehype-katex。
 *
 *  为什么单独成模块：KaTeX（JS + CSS + 字体）只有在消息里真的出现公式时才需要。
 *  AssistantText 用便宜正则先探测 $...$ / $$...$$ / latex 围栏，仅命中时才 React.lazy
 *  加载本模块，普通消息只加载不含 KaTeX 的 MarkdownBody。
 */
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import katex from "katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { Check, Copy } from "lucide-react";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";
import { writeClipboard } from "../../../utils/clipboard";
import { KATEX_OPTIONS, KATEX_REHYPE_PLUGIN } from "../../../utils/markdownKatex";
import type { PluggableList } from "unified";
import {
	buildMarkdownComponents,
	createCodeBlockComponent,
	markdownUrlTransform,
	remarkLinkifyPaths,
	type MarkdownBodyProps,
} from "./MarkdownBody";

/**
 * 将 ```latex / ```tex / ```math 代码围栏渲染为 KaTeX 公式。
 * 与 remark-math 的 $...$ / $$...$$ 路径互补：模型更常输出 language fence。
 * 渲染失败时回退到源码展示，避免整条消息白屏。
 */
function LatexBlock(props: { source: string }) {
	const [copied, setCopied] = useState(false);
	const source = props.source.trim();
	const rendered = useMemo(() => {
		if (!source) return { html: "", error: null as string | null };
		try {
			// displayMode + 共享 KATEX_OPTIONS（strict:"ignore" / throwOnError:false / trust:false）：
			// 多行方程块也能尽量渲染，中文与全角标点不再逐字符告警；真实错误以 katex-error span 呈现。
			const html = katex.renderToString(source, {
				displayMode: true,
				...KATEX_OPTIONS,
			});
			return { html, error: null as string | null };
		} catch (err) {
			return {
				html: "",
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}, [source]);

	const handleCopy = () => {
		// 复制为可再次粘贴的 $$...$$ 块，兼容 remark-math 与编辑器粘贴。
		const texContent = source.includes("\n") ? `$$\n${source}\n$$` : `$$${source}$$`;
		void writeClipboard(texContent);
		setCopied(true);
		showNotice(t("app.latexCopied"), 1200);
		setTimeout(() => setCopied(false), 1800);
	};

	if (rendered.error || !rendered.html) {
		return (
			<div className="code-block-wrap latex-block latex-block--fallback">
				<button className="code-copy" type="button" onClick={handleCopy} title={t("common.copy")}>
					{copied ? <Check size={14} /> : <Copy size={14} />}
				</button>
				{rendered.error && (
					<small className="latex-block-error">{rendered.error}</small>
				)}
				<pre><code className="language-latex">{source}</code></pre>
			</div>
		);
	}

	return (
		<div className="code-block-wrap latex-block">
			<button className="code-copy" type="button" onClick={handleCopy} title={t("common.copy")}>
				{copied ? <Check size={14} /> : <Copy size={14} />}
			</button>
			{/* KaTeX 输出已消毒（trust:false），dangerouslySetInnerHTML 仅用于插入渲染结果 */}
			<div
				className="latex-block-content"
				dangerouslySetInnerHTML={{ __html: rendered.html }}
			/>
		</div>
	);
}

// 数学管线 = 与原实现相同的插件顺序（先 remark-math 生成公式节点，再做路径链接化，
// 避免链接化把公式内的路径拆开导致 remark-math 无法识别）；数组引用稳定。
const MATH_REMARK_PLUGINS = [remarkGfm, remarkMath, remarkLinkifyPaths];
const MATH_REHYPE_PLUGINS: PluggableList = [KATEX_REHYPE_PLUGIN];
const MathCodeBlock = createCodeBlockComponent((source) => <LatexBlock source={source} />);

/** 数学公式 markdown 渲染件，props 与 MarkdownBody 完全一致。由 AssistantText 懒加载。 */
export function MarkdownMath(props: MarkdownBodyProps) {
	const components = useMemo(
		() => buildMarkdownComponents(MathCodeBlock, {
			onOpenExternal: props.onOpenExternal,
			onOpenFile: props.onOpenFile,
		}),
		[props.onOpenExternal, props.onOpenFile],
	);
	return (
		<ReactMarkdown
			remarkPlugins={MATH_REMARK_PLUGINS}
			rehypePlugins={MATH_REHYPE_PLUGINS}
			urlTransform={markdownUrlTransform}
			components={components}
		>
			{props.text}
		</ReactMarkdown>
	);
}
