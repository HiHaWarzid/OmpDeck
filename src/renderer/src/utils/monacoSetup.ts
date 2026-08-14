import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

// Monaco Editor 依赖 Web Worker 做语法高亮。Vite ?worker 后缀会把每个 worker 拆成独立 chunk，
// 避免在 Electron 渲染进程里找不到 worker 入口而降级为无高亮的纯文本模式。
// 语言列表按使用频率添加，减少初始 bundle 体积。
// TypeScript Worker（~13MB）使用动态 import，仅当用户编辑 .ts/.js 文件时才加载，
// 避免首屏强制下载完整的 TS 编译器。
// monaco-editor 0.56 的 exports map 为 "./*": "./esm/vs/*.js"，深路径导入必须去掉 esm/vs 前缀，
// 否则 Rollup 按 exports 重写后指向不存在的 esm/vs/esm/vs/... 路径导致构建失败。
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

/**
 * 惰性 worker 工厂：首次访问对应语言时才动态 import worker chunk，并缓存实例。
 * json/css/html worker（共 ~3.9MB）与 ts.worker 一样按需加载——
 * 打开纯文本/未知语言文件时只需 editor.worker（571KB），不必下载全部语言 worker。
 */
function makeLazyWorker(
	importFn: () => Promise<{ default: new () => Worker }>,
): () => Promise<Worker> {
	let promise: Promise<Worker> | null = null;
	return () => {
		if (!promise) {
			promise = importFn().then((mod) => new mod.default());
		}
		return promise;
	};
}

const getTsWorker = makeLazyWorker(() =>
	import("monaco-editor/language/typescript/ts.worker?worker"),
);
const getJsonWorker = makeLazyWorker(() =>
	import("monaco-editor/language/json/json.worker?worker"),
);
const getCssWorker = makeLazyWorker(() =>
	import("monaco-editor/language/css/css.worker?worker"),
);
const getHtmlWorker = makeLazyWorker(() =>
	import("monaco-editor/language/html/html.worker?worker"),
);

export function setupMonaco(): void {
	self.MonacoEnvironment = {
		async getWorker(_workerId: string, label: string) {
			switch (label) {
				case "typescript":
				case "javascript":
					return getTsWorker();
				case "json":
					return getJsonWorker();
				case "css":
				case "scss":
				case "less":
					return getCssWorker();
				case "html":
				case "handlebars":
				case "razor":
					return getHtmlWorker();
				default:
					return new EditorWorker();
			}
		},
	};

	loader.config({ monaco });
}
