/// <reference types="vite/client" />

// electron-vite 的 ?asset 后缀类型声明
// 使用 ?asset 导入时，Vite 会将文件复制到输出目录并返回正确的运行时路径
declare module "*?asset" {
	const value: string;
	export default value;
}

// Vite `?raw` 导入：返回文件原文。用于把静态 HTML 降级页从 TS 模板字符串里搬出来
// （页面内容零插值，构建时内联，运行时不再读盘）。
declare module "*?raw" {
	const value: string;
	export default value;
}
