/** 助手正文渲染：markdown / KaTeX / Mermaid 富文本管线及其私有渲染件。 */
import {
	isValidElement,
	memo,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import katex from "katex";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { sameImageListForRender } from "../AppUtils";
import { Check, FileText, Copy } from "lucide-react";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";
import { writeClipboard } from "../../../utils/clipboard";
import { filePathFromHref, stripFileLocation, toInternalFileHref } from "../../../utils/fileLinks";
import type { ImageContent } from "../../../../../shared/types";
import { stripAnsi, stripThinkingTags } from "../format";

// Mermaid 库体积数 MB，仅在真正出现 mermaid 代码块时才动态加载，
// 避免随渲染进程常驻、放大内存占用并在流式期间抢占主线程。
let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;
function loadMermaid() {
	if (!mermaidModulePromise) mermaidModulePromise = import("mermaid");
	return mermaidModulePromise;
}
/**
 * remark 插件：把助手正文里的裸文件路径转换成可点击的 file:// 链接。
 *
 * 以前用对原始 markdown 字符串做正则替换的 linkifyFilePaths，缺点是会把
 * ```代码块``` 里的路径字符串也改写掉（例如 AI 给出的 path: "D:\..." 示例
 * 被替换成 [D:\...](file://...) 破坏代码块），且 file:// 经 encodeURIComponent
 * 后反斜杠全被编码，链接既不可用又渲染异常。
 *
 * 改为在 mdast 层遍历，只处理 type === "text" 的叶子节点，天然跳过
 * code / inlineCode / link 内的文本，从根上消除双重处理与代码块破坏。
 * URL 用 file:// + encodeURIComponent 编码路径，MarkdownLink 里解码还原。
 */
const FILE_PATH_RE =
	/(?:[A-Z]:[\\/][^\s<>"'`|?*\n\[\]()]+|(?:\.\.?\/|\/)[^\s<>"'`|?*\n\[\]()]+|(?:[a-zA-Z_][a-zA-Z0-9_-]*[\\/])+[^\s<>"'`|?*\n\[\]()]+)\.[a-zA-Z0-9]+/g;
const remarkLinkifyPaths = () => {
	return (tree: any) => {
		// 遍历 mdast，仅替换 text 叶子节点；code/inlineCode/link 等节点不被处理。
		// 文本节点无 children，所以先用 __segs 标记待拆分节点，由父节点遍历时展开。
		const visit = (node: any) => {
			if (!node || typeof node !== "object") return;
			const type: string = node.type;
			if (type === "code" || type === "inlineCode") return;
			if (type === "link") {
				const fileHref = typeof node.url === "string" ? toInternalFileHref(node.url) : null;
				if (fileHref) node.url = fileHref;
				return;
			}
			if (type === "text" && typeof node.value === "string") {
				const text: string = node.value;
				FILE_PATH_RE.lastIndex = 0;
				const segs: any[] = [];
				let last = 0;
				let m: RegExpExecArray | null;
				let touched = false;
				while ((m = FILE_PATH_RE.exec(text)) !== null) {
					const start = m.index;
					const end = start + m[0].length;
					if (start > last) segs.push({ type: "text", value: text.slice(last, start) });
					segs.push({
						type: "link",
						url: `file://${encodeURIComponent(m[0])}`,
						children: [{ type: "text", value: m[0] }],
					});
					last = end;
					touched = true;
				}
				if (touched) {
					if (last < text.length) segs.push({ type: "text", value: text.slice(last) });
					node.__segs = segs;
				}
				return;
			}
			const children: any[] | undefined = node.children;
			if (Array.isArray(children)) {
				const next: any[] = [];
				for (const child of children) {
					visit(child);
					if (child && (child as any).__segs) {
						const segs = (child as any).__segs;
						delete (child as any).__segs;
						next.push(...segs);
					} else {
						next.push(child);
					}
				}
				node.children = next;
			}
		};
		visit(tree);
	};
};
// ── ReactMarkdown 插件数组常量 ──
// ReactMarkdown 对 plugins 数组做引用对比；每次渲染新建数组会触发整条 markdown 重新解析。
// 完整渲染管线常量：引用稳定，避免每次渲染重新初始化插件链。
const FULL_REMARK_PLUGINS = [remarkGfm, remarkMath, remarkLinkifyPaths];
const FULL_REHYPE_PLUGINS = [rehypeKatex];
/** 助手正文：扁平 markdown 渲染，无气泡包裹，全宽排版，支持内嵌图片。
 *  路径链接化用 remark 插件在 mdast 层处理（见底部 remarkLinkifyPaths），不再前置改写原始字符串。 */
/** 表格容器：与 code-block-wrap 保持相同的宽度与圆角，内部 <table> 仍负责横向滚动。 */
function TableWrapper(props: React.ComponentProps<"table">) {
	return (
		<div className="table-wrap">
			<table {...props} />
		</div>
	);
}
function MathSpan(props: React.HTMLAttributes<HTMLSpanElement>) {
	const { className, children, ...spanProps } = props;
	const ref = useRef<HTMLSpanElement | null>(null);
	const [copied, setCopied] = useState(false);
	const isDisplayMath = /\bkatex-display\b/.test(className ?? "");
	// 只对 KaTeX 最外层 span 添加复制按钮，内部嵌套的 katex-mathml / katex-html 等直接透传。
	// 行内公式外层 class 精确为 "katex"，块级外层为 "katex-display"（可能同时含 "katex"）。
	const isOuterKatex = isDisplayMath || className === "katex";
	if (!isOuterKatex) return <span className={className} {...spanProps}>{children}</span>;
	const copyMath = () => {
		const annotation = ref.current?.querySelector('annotation[encoding="application/x-tex"]');
		const source = annotation?.textContent || extractText(children);
		// 行内公式用 $...$ 包裹，块级公式用 $$...$$ 包裹
		const texContent = isDisplayMath ? `$$\n${source}\n$$` : `$${source}$`;
		void writeClipboard(texContent);
		setCopied(true);
		showNotice(t("app.latexCopied"), 1200);
		setTimeout(() => setCopied(false), 1800);
	};
	return (
		<span className={`math-copy-wrap${isDisplayMath ? "" : " math-copy-wrap--inline"}`}>
			<span ref={ref} className={className} {...spanProps}>{children}</span>
			<button className={`math-copy-btn${isDisplayMath ? "" : " math-copy-btn--inline"}`} type="button" onClick={copyMath} title={t("common.copy")}>
				{copied ? <Check size={isDisplayMath ? 12 : 10} /> : <Copy size={isDisplayMath ? 12 : 10} />}
			</button>
		</span>
	);
}
function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
	const child = Array.isArray(props.children) ? props.children[0] : props.children;
	const codeProps = isValidElement(child)
		? (child.props as { className?: string; children?: ReactNode })
		: undefined;
	const languageClass = codeProps?.className ?? "";
	const text = extractText(codeProps?.children ?? props.children);
	const [copied, setCopied] = useState(false);
	// mermaid / latex 围栏都走专用渲染，避免把图表或公式当普通代码块展示。
	if (/\blanguage-mermaid\b/i.test(languageClass)) {
		return <MermaidDiagram chart={text} />;
	}
	// 模型常输出 ```latex / ```tex / ```math 而不是 $...$，这里补齐 KaTeX 渲染路径。
	if (/\blanguage-(?:latex|tex|math)\b/i.test(languageClass)) {
		return <LatexBlock source={text} />;
	}
	const handleCopy = () => {
		writeClipboard(text);
		setCopied(true);
		showNotice(t("app.codeCopied"), 1200);
		setTimeout(() => setCopied(false), 1800);
	};
	return (
		<div className="code-block-wrap">
			<button
				className="code-copy"
				onClick={handleCopy}
				title={t("code.copy")}
			>
				{copied ? <Check size={14} /> : <Copy size={14} />}
			</button>
			<pre {...props}>{props.children}</pre>
		</div>
	);
}
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
			// displayMode + throwOnError:false：多行方程块也能尽量渲染；错误以 katex-error span 呈现。
			const html = katex.renderToString(source, {
				displayMode: true,
				throwOnError: false,
				strict: "ignore",
				trust: false,
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
function normalizeMermaidChart(chart: string) {
	// Mermaid flowchart 的方括号节点 label 未加引号时，`foo(bar)` 里的括号会被解析成形状语法。
	// 模型常输出 `A[api.call(arg)]` 这种写法，这里仅把含括号的普通方括号 label 自动转成 quoted label。
	return chart.replace(
		/(\b[A-Za-z][\w-]*\s*)\[([^\]\n"]*[()][^\]\n"]*)\]/g,
		(_match, prefix: string, label: string) =>
			`${prefix}["${label.replace(/"/g, "\\\"")}"]`,
	);
}
function MermaidDiagram(props: { chart: string }) {
	const reactId = useId();
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [zoom, setZoom] = useState(1);

	useEffect(() => {
		let disposed = false;
		const chart = normalizeMermaidChart(props.chart);
		const renderId = `pi-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
		// Mermaid 图由模型输出生成，使用 strict 安全级别并禁用 startOnLoad，
		// 避免库扫描整个页面或执行不受控的链接/脚本行为。此处动态加载 mermaid，
		// 保证不按需出现的图表场景不占用渲染进程常驻内存。
		loadMermaid()
			.then((mod) => {
				const mermaid = mod.default;
				mermaid.initialize({
					startOnLoad: false,
					securityLevel: "strict",
					theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default",
				});
				return mermaid.render(renderId, chart);
			})
			.then(({ svg }) => {
				if (disposed || !containerRef.current) return;
				containerRef.current.innerHTML = svg;
				setError(null);
			})
			.catch((err: unknown) => {
				if (disposed) return;
				setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			disposed = true;
		};
	}, [props.chart, reactId]);

	return (
		<div className="mermaid-block">
			{error ? (
				<MermaidMarkdownFallback chart={props.chart} error={error} />
			) : (
				<>
					<div className="mermaid-toolbar" aria-label="Mermaid diagram controls">
						<button type="button" onClick={() => { writeClipboard(`\`\`\`mermaid\n${props.chart}\n\`\`\``); showNotice(t("app.mermaidCopied"), 1200); }} title={t("common.copy")}><Copy size={14} /></button>
						<button type="button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))}>−</button>
						<span>{Math.round(zoom * 100)}%</span>
						<button type="button" onClick={() => setZoom((value) => Math.min(2.5, value + 0.1))}>＋</button>
						<button type="button" onClick={() => setZoom(1)}>100%</button>
					</div>
					<div className="mermaid-viewport">
						<div
							ref={containerRef}
							className="mermaid-diagram"
							style={{ transform: `scale(${zoom})`, "--mermaid-zoom": zoom } as CSSProperties}
						/>
					</div>
				</>
			)}
		</div>
	);
}
function MermaidMarkdownFallback(props: { chart: string; error: string }) {
	const markdown = `\`\`\`mermaid\n${props.chart}\n\`\`\``;
	return (
		<div className="code-block-wrap mermaid-fallback">
			<button
				className="code-copy"
				onClick={() => { writeClipboard(markdown); showNotice(t("app.codeCopied"), 1200); }}
				title={t("code.copy")}
			>
				<Copy size={14} />
			</button>
			<pre>{markdown}</pre>
			<small className="mermaid-error-message">Mermaid render failed: {props.error}</small>
		</div>
	);
}
/** Markdown 内的链接默认会在 Electron 窗口内导航,这里拦截点击统一用系统浏览器打开。
 * 支持文件路径链接（file:// 协议）点击打开文件。
 */
function markdownUrlTransform(url: string): string {
	// react-markdown 默认会清空 file:// 协议；这里只放行本地文件链接，普通外链仍使用默认安全过滤。
	return url.startsWith("file://") ? url : defaultUrlTransform(url);
}
function MarkdownLink(
	props: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
		onOpenExternal: (url: string) => void;
		onOpenFile?: (path: string) => void;
	},
) {
	const { onOpenExternal, onOpenFile, children, className, title, ...anchorProps } = props;
	const filePath = filePathFromHref(props.href);
	const isFileLink = filePath !== null;
	const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
		e.preventDefault();
		if (!props.href) return;

		if (filePath !== null) {
			// 本地文件链接不受 linkOpenMode 影响，始终走 onOpenFile。
			if (onOpenFile) void onOpenFile(stripFileLocation(filePath));
			return;
		}

		// 仅 http(s) 外链：Ctrl/Cmd+点击强制系统浏览器；普通点击仍跟 linkOpenMode。
		// 不扩散到非链接控件，避免误伤按钮/chip 等交互。
		const forceSystem = e.ctrlKey || e.metaKey;
		if (forceSystem && (props.href.startsWith("http:") || props.href.startsWith("https:"))) {
			const open = window.piDesktop?.app?.openExternal;
			if (open) {
				void open(props.href, true);
				return;
			}
		}
		void onOpenExternal(props.href);
	};
	const handleContextMenu = (e: React.MouseEvent<HTMLAnchorElement>) => {
		if (filePath === null) return;
		e.preventDefault();
		void writeClipboard(filePath).then(
			() => showNotice(t("app.pathCopied"), 1200),
			() => showNotice(t("copy.failed"), 2000, "error"),
		);
	};
	const linkClass =
		[className, isFileLink ? "markdown-link-file" : undefined]
			.filter(Boolean)
			.join(" ") || undefined;
	return (
		<a
			{...anchorProps}
			className={linkClass}
			onClick={handleClick}
			onContextMenu={handleContextMenu}
			title={isFileLink ? filePath : title}
		>
			{isFileLink ? (
				<>
					<FileText size={12} className="markdown-link-file-icon" />
					<span>{children}</span>
				</>
			) : (
				children
			)}
		</a>
	);
}
function extractText(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(extractText).join("");
	if (isValidElement<{ children?: ReactNode }>(node))
		return extractText(node.props.children);
	return "";
}
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

		// components 对象做 useMemo 稳定引用：a 组件需要闭包捕获 onOpenExternal/onOpenFile，
		// 但这两个回调在 App 中是稳定的（读 ref 或 setState），故依赖 [] 即可。
		// memo 比较器已排除回调，组件不会因回调变化而重渲染，闭包始终拿到首次渲染的引用即可。
		const components = useMemo(
			() => ({
				pre: CodeBlock,
				table: TableWrapper,
				span: MathSpan,
				a: (linkProps: React.ComponentProps<"a">) => (
					<MarkdownLink
						{...linkProps}
						onOpenExternal={props.onOpenExternal}
						onOpenFile={props.onOpenFile}
					/>
				),
			}),
			// eslint-disable-next-line react-hooks/exhaustive-deps
			[props.onOpenExternal, props.onOpenFile],
		);

		const imagesMarkup = props.images && props.images.length > 0 ? (
			<div className="message-images">
				{props.images.map((img, index) => (
					<img
						key={index}
						src={`data:${img.mimeType};base64,${img.data}`}
						alt={t("app.imageAlt", { index: index + 1 })}
						className="message-image"
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
				<ReactMarkdown
					remarkPlugins={FULL_REMARK_PLUGINS}
					rehypePlugins={FULL_REHYPE_PLUGINS}
					urlTransform={markdownUrlTransform}
					components={components}
				>
					{cleanText}
				</ReactMarkdown>
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
