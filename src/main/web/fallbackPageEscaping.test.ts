// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import fallbackPageHtml from "./fallbackPage.html?raw";

/**
 * 降级页的注入面：`render()` 把服务端字段拼进 `innerHTML`。
 *
 * 该页面与 `/api/*` 同源，一旦拼进去的字段能携带标签，脚本就以应用自身身份运行，
 * 可以直接 `POST /api/agents/:id/{prompt,abort,stop}`（回环豁免无需令牌）——
 * 也就是「谁的手机打开了降级页，谁就能驱动本机 agent」。
 *
 * 今天 `project.id` / `agent.id` 来自 `randomUUID()`、`status` 与 `role` 是闭集，
 * 所以没有可利用路径；但这条链路是**唯一**由服务端字段直接拼 HTML 的地方，
 * 页面搬成资源文件后剩下的一致性只有在渲染结果里才看得见。
 *
 * 测试手法：剥掉 `<script>` 后用 jsdom 建 DOM，再把页面脚本放进
 * `Function(document, fetch, setInterval, ...)` 里执行——这样既跑的是真实脚本，
 * 又不需要 jsdom 的脚本加载器，也不真实联网。
 */

/** 从页面里取出内联脚本源码；页面结构固定为一个 `<script>` 块。 */
function pageScript(): string {
	const match = fallbackPageHtml.match(/<script>([\s\S]*?)<\/script>/);
	if (!match) throw new Error("降级页的内联脚本找不到了：本测试需要随结构更新");
	return match[1];
}

/** 恶意字段：每个都试图跳出所在上下文。 */
const HOSTILE = {
	projectId: 'p1"><img src=x onerror="window.__pwned=1">',
	projectName: "<script>window.__pwned=1</script>项目",
	agentId: 'a1" onmouseover="window.__pwned=1',
	agentTitle: "<svg onload=window.__pwned=1>",
	agentCwd: "</small><script>window.__pwned=1</script>",
	role: '"><svg onload=window.__pwned=1>',
	text: "<img src=x onerror=window.__pwned=1>",
};

async function renderWithHostileState(): Promise<Document> {
	// 先建一个只有容器骨架的文档：脚本只依赖 getElementById 能命中的节点。
	document.body.innerHTML = [
		'<main class="shell">',
		'<div id="projects"></div>',
		'<div id="agents"></div>',
		'<h2 id="title"></h2>',
		'<p id="status"></p>',
		'<div id="messages"></div>',
		'<form id="composer"><textarea id="prompt"></textarea><button type="submit"></button></form>',
		'<button id="stop"></button>',
		"</main>",
	].join("");

	const state = {
		projects: [
			{ id: HOSTILE.projectId, name: HOSTILE.projectName, path: "/tmp/p" },
		],
		agents: [
			{
				id: HOSTILE.agentId,
				title: HOSTILE.agentTitle,
				status: "running",
				cwd: HOSTILE.agentCwd,
			},
		],
		messagesByAgent: {
			[HOSTILE.agentId]: [{ role: HOSTILE.role, text: HOSTILE.text }],
		},
	};

	const fetchStub = () =>
		Promise.resolve({ ok: true, json: async () => state, statusText: "OK" });

	// 脚本末尾自执行 `refresh()`，它内部有 refreshing 闸门；再调一次会直接返回，
	// 所以这里等宏任务落地，而不是自己再触发一次（会拿到尚未渲染的 DOM）。
	const run = new Function(
		"document",
		"fetch",
		"setInterval",
		"encodeURIComponent",
		pageScript(),
	);
	run(document, fetchStub, () => 0, encodeURIComponent);
	await new Promise((resolve) => setTimeout(resolve, 20));
	return document;
}

describe("降级页把服务端字段拼进 DOM 时必须转义", () => {
	test("恶意 id / 状态 / 角色不会变成标签、属性或可执行脚本", async () => {
		const doc = await renderWithHostileState();

		// 1. 没有新增任何标签：注入点的标签会被解析成元素，这里一律不许。
		expect(doc.querySelectorAll("script")).toHaveLength(0);
		expect(doc.querySelectorAll("img")).toHaveLength(0);
		expect(doc.querySelectorAll("svg")).toHaveLength(0);

		// 2. 恶意 id 只能以数据形式存在，不能被拆成额外属性。
		const projectButton = doc.querySelector("[data-project]");
		expect(projectButton?.getAttribute("data-project")).toBe(HOSTILE.projectId);
		expect(projectButton?.hasAttribute("onmouseover")).toBe(false);

		const agentButton = doc.querySelector("[data-agent]");
		expect(agentButton?.getAttribute("data-agent")).toBe(HOSTILE.agentId);
		expect(agentButton?.hasAttribute("onmouseover")).toBe(false);
		expect(doc.querySelector("[data-close-agent]")?.getAttribute("data-close-agent")).toBe(
			HOSTILE.agentId,
		);

		// 3. 角色用于 class：整段必须是转义后的字面量，而不是新标签的开头。
		const message = doc.querySelector(".message");
		expect(message?.className).toBe(`message ${HOSTILE.role}`);
		expect(message?.querySelector(".role")?.textContent).toBe(HOSTILE.role);

		// 4. 任何注入都不会被执行。
		expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
	});

	test("正常字段仍然原样呈现（转义没有过度吃掉文本）", async () => {
		const doc = await renderWithHostileState();
		expect(doc.getElementById("title")?.textContent).toBe(HOSTILE.agentTitle);
		// 文本里的尖括号同样只以文本形式出现。
		expect(doc.querySelector(".message")?.textContent).toContain(HOSTILE.text);
		expect(doc.querySelectorAll("script")).toHaveLength(0);
	});
});
