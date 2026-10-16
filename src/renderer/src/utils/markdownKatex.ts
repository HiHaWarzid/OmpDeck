/**
 * markdown 渲染管线里的 KaTeX 共享配置。
 * 三处 KaTeX 调用点（助手正文、代码围栏公式、草稿预览）必须复用同一份严格度，
 * 否则同一段文本在不同路径下表现不一致。
 */
import rehypeKatex from "rehype-katex";
import type { KatexOptions } from "katex";
import type { Pluggable } from "unified";

/**
 * KaTeX 渲染选项（全项目唯一来源）。
 *
 * - `strict: "ignore"`：模型输出的数学文本里经常夹着中文与全角标点（例如 `$中文，文本$`），
 *   这类内容本来就不该按公式排版，按普通文本原样输出即可。KaTeX 默认 `strict: "warn"`
 *   会为**每个**不兼容字符打一条 `LaTeX-incompatible input and strict mode is set to
 *   'warn': Unicode text character "，" used in math mode` 告警：既不是真实的渲染失败，
 *   又会随流式渲染反复刷屏 renderer console，因此统一降级为静默忽略。
 * - `throwOnError: false`：渲染失败不抛异常，而是产出 `katex-error` 节点——配置降级而非静默吞错；
 *   `LatexBlock` 另有回退到源码展示的分支。
 * - `trust: false`：不启用 `\href` / `\htmlClass` 等需要信任的命令，避免模型输出注入 DOM。
 */
export const KATEX_OPTIONS: KatexOptions = {
	strict: "ignore",
	throwOnError: false,
	trust: false,
};

/**
 * `rehypeKatex` 插件元组（插件 + 共享选项）。直接作为 `rehypePlugins` 的元素使用，
 * 需要拼接其他 rehype 插件时把它放在插件链任意位置即可，无需再单独传选项。
 */
export const KATEX_REHYPE_PLUGIN: Pluggable = [rehypeKatex, KATEX_OPTIONS];
