/** 基础 Markdown 渲染管线（无 KaTeX）：react-markdown + GFM + 路径链接化 + Mermaid 懒加载。
 *
 *  为什么单独成模块：App → TurnRow → MessageListContent → AssistantText 是渲染进程启动
 *  关键路径，若本模块的 react-markdown/remark-gfm 被静态 import，打包后入口的
 *  modulepreload 会带上 vendor-markdown，首屏必须多解析数百 KB。AssistantText 因此改用
 *  React.lazy 动态加载本模块；含数学公式的消息再由 MarkdownMath 叠加 KaTeX 栈。
 */
import {
	isValidElement,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Mermaid } from "mermaid";
import { Check, FileText, Copy } from "lucide-react";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";
import { writeClipboard } from "../../../utils/clipboard";
import { filePathFromHref, stripFileLocation, toInternalFileHref } from "../../../utils/fileLinks";

// Mermaid 库体积数 MB，仅在真正出现 mermaid 代码块时才动态加载，
// 避免随渲染进程常驻、放大内存占用并在流式期间抢占主线程。
let mermaidModulePromise: Promise<{ default: Mermaid }> | null = null;
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
/** mdast 节点在本插件里只关心类型/文本/链接/子节点；用最小结构接收，避免 any 掩盖真实约束。 */
type MdastNode = {
	type?: string;
	value?: unknown;
	url?: unknown;
	children?: MdastNode[];
	__segs?: MdastNode[];
};
export const remarkLinkifyPaths = () => {
	return (tree: MdastNode) => {
		// 遍历 mdast，仅替换 text 叶子节点；code/inlineCode/link 等节点不被处理。
		// 文本节点无 children，所以先用 __segs 标记待拆分节点，由父节点遍历时展开。
		const visit = (node: MdastNode) => {
			if (!node || typeof node !== "object") return;
			const type = node.type;
			if (type === "code" || type === "inlineCode") return;
			if (type === "link") {
				const fileHref = typeof node.url === "string" ? toInternalFileHref(node.url) : null;
				if (fileHref) node.url = fileHref;
				return;
			}
			if (type === "text" && typeof node.value === "string") {
				const text = node.value;
				FILE_PATH_RE.lastIndex = 0;
				const segs: MdastNode[] = [];
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
			const children = node.children;
			if (Array.isArray(children)) {
				const next: MdastNode[] = [];
				for (const child of children) {
					visit(child);
					if (child.__segs) {
						const segs = child.__segs;
						delete child.__segs;
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
// ReactMarkdown 对 plugins 数组做引用对比；每次渲染新建数组会触发整条 markdown 重新解析。
// 基础管线常量：引用稳定，避免每次渲染重新初始化插件链。
// 数学公式插件（remark-math / rehype-katex）只在 MarkdownMath 中追加，普通消息不加载。
const BASE_REMARK_PLUGINS = [remarkGfm, remarkLinkifyPaths];
const TEXT_REMARK_PLUGINS = [remarkGfm];

/** 表格容器：与 code-block-wrap 保持相同的宽度与圆角，内部 <table> 仍负责横向滚动。 */
function TableWrapper(props: React.ComponentProps<"table">) {
	return (
		<div className="table-wrap">
			<table {...props} />
		</div>
	);
}
/** KaTeX 输出外层 span 的复制按钮。本模块不 import katex：只有 MarkdownMath 会产出这些 class。 */
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
/**
 * 生成 ```pre``` 渲染件。
 * renderLatex 由 MarkdownMath 注入：只有数学管线才有 KaTeX 可用来渲染 latex/tex/math 围栏。
 * 基础管线不传该参数，围栏按普通代码块展示（数学探测会在渲染前把这类消息路由到 MarkdownMath）。
 */
export function createCodeBlockComponent(renderLatex?: (source: string) => ReactNode) {
	return function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
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
		// 模型常输出 ```latex / ```tex / ```math 而不是 $...$，由数学管线补齐 KaTeX 渲染路径。
		if (renderLatex && /\blanguage-(?:latex|tex|math)\b/i.test(languageClass)) {
			return renderLatex(text);
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
	};
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
export function markdownUrlTransform(url: string): string {
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
export function extractText(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(extractText).join("");
	if (isValidElement<{ children?: ReactNode }>(node))
		return extractText(node.props.children);
	return "";
}

export type MarkdownHandlers = {
	onOpenExternal: (url: string) => void;
	onOpenFile?: (path: string) => void;
};

/**
 * 组装 ReactMarkdown 的 components 映射。
 * 由基础/数学管线共用，唯一差异是 pre 渲染件（数学版支持 latex 围栏）。
 */
export function buildMarkdownComponents(
	CodeBlock: React.ComponentType<React.HTMLAttributes<HTMLPreElement>>,
	handlers: MarkdownHandlers,
) {
	return {
		pre: CodeBlock,
		table: TableWrapper,
		span: MathSpan,
		a: (linkProps: React.ComponentProps<"a">) => (
			<MarkdownLink
				{...linkProps}
				onOpenExternal={handlers.onOpenExternal}
				onOpenFile={handlers.onOpenFile}
			/>
		),
	};
}

export type MarkdownBodyProps = {
	text: string;
	onOpenExternal: (url: string) => void;
	onOpenFile?: (path: string) => void;
};

const BaseCodeBlock = createCodeBlockComponent();

/** 基础 markdown 渲染件（无数学公式）。由 AssistantText 懒加载。 */
export function MarkdownBody(props: MarkdownBodyProps) {
	// components 对象做 useMemo 稳定引用：闭包捕获 onOpenExternal/onOpenFile；
	// 调用方（App 层）这两个回调引用稳定，避免每次渲染重建插件链。
	const components = useMemo(
		() => buildMarkdownComponents(BaseCodeBlock, {
			onOpenExternal: props.onOpenExternal,
			onOpenFile: props.onOpenFile,
		}),
		[props.onOpenExternal, props.onOpenFile],
	);
	return (
		<ReactMarkdown
			remarkPlugins={BASE_REMARK_PLUGINS}
			urlTransform={markdownUrlTransform}
			components={components}
		>
			{props.text}
		</ReactMarkdown>
	);
}

export type MarkdownTextProps = {
	/** 纯文本 markdown（优先使用 children，便于直接包裹文本节点）。 */
	text?: string;
	children?: string;
	/** 可选外层容器 class；不传则直接输出 markdown 内容，由调用方容器负责排版。 */
	className?: string;
};

/**
 * 通用的一次性 markdown 渲染件（如 App 更新说明）。
 * 入口文件不应静态 import react-markdown，因此调用方应以 React.lazy 加载本组件。
 */
export function MarkdownText(props: MarkdownTextProps) {
	const content = (
		<ReactMarkdown remarkPlugins={TEXT_REMARK_PLUGINS}>
			{props.children ?? props.text ?? ""}
		</ReactMarkdown>
	);
	return props.className ? <div className={props.className}>{content}</div> : content;
}
