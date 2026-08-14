import { memo, useCallback, useMemo } from "react";
import { Editor } from "@monaco-editor/react";
import { setupMonaco } from "../../utils/monacoSetup";

/** Monaco 初始化保证只执行一次 */
let monacoInitialized = false;
function ensureMonacoOnce(): void {
	if (monacoInitialized) return;
	monacoInitialized = true;
	setupMonaco();
}

// 在模块作用域同步初始化，确保 <Editor> 挂载前 loader.config({ monaco }) 已生效，
// 避免 Monaco 从 CDN 加载被 CSP 阻止。
ensureMonacoOnce();

export type MonacoEditorProps = {
	value: string;
	onChange?: (value: string) => void;
	language?: string;
	height?: string;
	readOnly?: boolean;
};

/** 统一的 Monaco 编辑器封装，自动处理 loader 初始化和 CSP 兼容。 */
export const MonacoEditor = memo(function MonacoEditor({
	value,
	onChange,
	language = "markdown",
	height = "100%",
	readOnly = false,
}: MonacoEditorProps) {
	// options/onChange/theme 引用稳定化：父组件重渲染（如流式 setState）时
	// 不再重建对象击穿 memo，Editor 内部避免不必要的 options diff 与重绑定。
	const theme = useMemo(
		() =>
			document.documentElement.getAttribute("data-theme") === "dark"
				? "vs-dark"
				: "vs",
		[],
	);
	const options = useMemo(
		() => ({
			minimap: { enabled: false },
			lineNumbers: "on" as const,
			folding: true,
			fontSize: 13,
			padding: { top: 10, bottom: 10 },
			scrollBeyondLastLine: false,
			wordWrap: "on" as const,
			tabSize: 2,
			insertSpaces: true,
			readOnly,
		}),
		[readOnly],
	);
	const handleChange = useCallback(
		(val: string | undefined) => onChange?.(val ?? ""),
		[onChange],
	);

	return (
		<Editor
			height={height}
			defaultLanguage={language}
			language={language}
			value={value}
			theme={theme}
			onChange={handleChange}
			options={options}
		/>
	);
});
