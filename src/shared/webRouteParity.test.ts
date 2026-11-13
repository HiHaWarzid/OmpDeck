import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchWebRoute, webRoutePathParams, webRoutes, webRouteUrl, type WebRestRoute } from "./ipc";

/**
 * 手机端路由奇偶守卫（静态契约）——手写客户端的死链防线。
 *
 * `/api` 的手写客户端不止一个：
 * - 桌面 renderer 走 browserApi（从 webRoutes 派生路径）；
 * - 服务端分发走 matchWebRoute（同一张表）；
 * - `src/renderer/public/mobile.js` 是浏览器里直接跑的脚本集合，没有构建步骤，无法 import 共享表；
 * - `WebServiceManager.renderPage()` 是 index.html 缺失时返回的内联降级页，同样手写路径。
 *
 * 后两者只能**静态核对**：从源码里抽出所有 `/api/...` 字面量，归一成路径形状后与
 * webRoutes 比对。只要有一侧漂移（服务端改路径、客户端改字面量、新增端点只在一边），
 * CI 就红——否则表现为静默 404（api() 拿到非 JSON 后降级成 null，界面停在旧数据）。
 *
 * 归一不了的字面量一律**判为失败**，不跳过：跳过等于把「我看不懂」当成「它没问题」，
 * 而看不懂的恰好是最容易漂移的那一类。真需要保留无法归一的手写路径，就在
 * AGGLOMERATE_ROUTES 里显式登记，让遗漏被承认而不是隐形。
 */

const MOBILE_JS = join(process.cwd(), "src/renderer/public/mobile.js");
const WEB_SERVICE_MANAGER = join(process.cwd(), "src/main/web/WebServiceManager.ts");

/** 不属于 webRoutes 聚合/直连端点（改这里等于承认又加了一个手写路由）。 */
const AGGLOMERATE_ROUTES = ["/api/state", "/api/health", "/api/web/status"];

/**
 * 单条消息详情：移动端展开长文本时直连（无对应 api 成员），路径含两段占位符。
 * 归一后为 /api/agents/:id/messages/:id。
 */
const DIRECT_MESSAGE_ROUTE = "/api/agents/:agentId/messages/:messageId";

/**
 * 路径模板末尾允许拼接的查询串变量名。
 *
 * 形如 `.../full-text${query}` 的尾部 `${…}` 是查询串而非路径段，忽略它是安全的；
 * 但必须按名字显式放行——否则 `${任意变量}` 都能悄悄溜过守卫，而那个变量完全可以
 * 是 `"/extra/segment"`。新增写法时在这里登记，别把规则放宽成「任意尾部变量」。
 */
const QUERY_SUFFIX_VARS = new Set(["query", "queryString", "search"]);

/**
 * 把路径归一成**形状**:去掉 /api 前缀、查询串,所有占位符一律折叠成 `:`,
 * 于是 `/api/agents/:agentId/runtime` 与 `/api/agents/:requestAgentId/runtime` 相等。
 *
 * 按形状比较是必要的:占位符由各端自己命名(手机端叫 requestAgentId、表里叫 agentId),
 * 名称不同不代表路径漂移;真正要守的是段数、位置与字面段。
 */
function routeShape(path: string): string {
	const withoutQuery = path.split("?")[0].replace(/^\/api(?=\/)/, "");
	return withoutQuery
		.replace(/\$\{\s*(?:encodeURIComponent\(\s*)?[A-Za-z0-9_.]+\s*\)?\s*\}/g, ":")
		.replace(/:[A-Za-z0-9_]+/g, ":");
}

/**
 * 把 `${cond ? "a" : "b"}` 展开成两条具体路径。
 *
 * 降级页用这种写法选 abort/stop（`/agents/${id}/${running ? "abort" : "stop"}`），
 * 两条分支都要参与比对——只取其中一条会让另一半静默失守。
 * 返回 null 表示嵌套了无法识别的三元表达式。
 */
function expandTernaries(literal: string): string[] | null {
	const ternary =
		/\$\{\s*[A-Za-z0-9_.]+\s*\?\s*(["'])([^"']*)\1\s*:\s*(["'])([^"']*)\3\s*\}/;
	const match = literal.match(ternary);
	if (!match) return [literal];
	const [whole, , whenTrue, , whenFalse] = match;
	const left = expandTernaries(literal.replace(whole, whenTrue));
	const right = expandTernaries(literal.replace(whole, whenFalse));
	if (!left || !right) return null;
	return [...left, ...right];
}

type NormalizedRoute =
	| { shapes: string[]; unparsed?: never }
	| { shapes?: never; unparsed: string };

/**
 * 归一一个 `/api/...` 字面量。非 /api 路径返回空 shapes（不是路由，无需核对）；
 * 含无法识别占位符的返回 `unparsed`，由调用方判为失败。
 *
 * 先展开三元、后切查询串：三元表达式里自带 `?`，先切会把分支截断成
 * `/agents/${id}/`，于是 abort/stop 两条路径双双消失。
 */
function normalizeRouteLiteral(literal: string): NormalizedRoute {
	if (!literal.startsWith("/api/")) return { shapes: [] };
	const expanded = expandTernaries(literal);
	if (!expanded) return { unparsed: literal };

	const shapes: string[] = [];
	for (const variant of expanded) {
		let path = variant.split("?")[0];
		const suffix = path.match(/\$\{\s*([A-Za-z0-9_.]+)(?:\.toString\(\s*\)|\(\s*\))?\s*\}$/);
		if (suffix) {
			if (!QUERY_SUFFIX_VARS.has(suffix[1].split(".")[0])) return { unparsed: literal };
			path = path.slice(0, suffix.index);
		}
		const collapsed = path.replace(
			/\$\{\s*encodeURIComponent\(\s*[A-Za-z0-9_.]+\s*\)\s*\}/g,
			":",
		);
		// 剩下的占位符是未编码的路径段（或位于路径中间），无法判定段数——判失败。
		if (collapsed.includes("${")) return { unparsed: literal };
		shapes.push(routeShape(collapsed));
	}
	return { shapes };
}

/**
 * 抽出源码里所有以 /api/ 开头的字符串字面量。
 *
 * 模板字面量允许内部出现引号（`${running ? "abort" : "stop"}`），普通引号字面量不允许，
 * 所以两类分开抽取——否则三元分支会在第一个引号处被截断，恰好漏掉要守的那条路径。
 *
 * 裸 `/api/` 是前缀判断（`startsWith("/api/")`）而不是路由，排除。
 */
function collectRouteLiterals(source: string): string[] {
	const literals = new Set<string>();
	const template = /`(\/api\/(?:[^`\\]|\\.)*)`/g;
	const quoted = /["'](\/api\/[^"']*)["']/g;
	for (const regex of [template, quoted]) {
		for (const match of source.matchAll(regex)) {
			if (match[1] === "/api/") continue;
			literals.add(match[1]);
		}
	}
	return [...literals];
}

/**
 * 抽出 renderPage() 内联页面的可扫描源码。
 *
 * 降级页不是独立文件：它嵌在 TS 模板字符串里，内层模板的 ` 与 ${ 都被转义过
 * （`` \` `` / `\${`），必须先反转义，才能与 mobile.js 共用同一个抽取器。
 */
function readFallbackPage(source: string): string {
	const marker = "private renderPage()";
	const start = source.indexOf(marker);
	if (start < 0) {
		throw new Error("WebServiceManager.renderPage() 找不到了：降级页抽取器需要更新");
	}
	const open = source.indexOf("`", start);
	let index = open + 1;
	let escaped = false;
	for (; index < source.length; index++) {
		const char = source[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "`") break;
	}
	const body = source.slice(open + 1, index);
	return body.replace(/\\`/g, "`").replace(/\\\$\{/g, "${");
}

/** 表内端点：键为路径形状，值为命名空间.成员（失败信息里可读）。 */
function routePaths(): Map<string, string> {
	const byPath = new Map<string, string>();
	for (const [namespace, members] of Object.entries(
		webRoutes as unknown as Record<string, Record<string, WebRestRoute>>,
	)) {
		for (const [member, route] of Object.entries(members)) {
			// webRoutes.path 相对于 /api；routeShape 会同时去掉两侧前缀与占位符名。
			byPath.set(routeShape(`/api${route.path}`), `${namespace}.${member}`);
		}
	}
	return byPath;
}

const CLIENTS = [
	{ name: "mobile.js", source: readFileSync(MOBILE_JS, "utf8") },
	{
		name: "WebServiceManager.renderPage()",
		source: readFallbackPage(readFileSync(WEB_SERVICE_MANAGER, "utf8")),
	},
];

describe.each(CLIENTS)("/api 路由 × webRoutes 奇偶守卫（$name）", ({ source }) => {
	const literals = collectRouteLiterals(source);

	it("能抽到路由字面量（否则守卫空转）", () => {
		expect(literals.length).toBeGreaterThan(3);
	});

	it("每个字面量都能归一，且对应 webRoutes 模板或显式登记的聚合端点", () => {
		const table = routePaths();
		const known = new Set([
			...table.keys(),
			...AGGLOMERATE_ROUTES.map(routeShape),
			routeShape(DIRECT_MESSAGE_ROUTE),
		]);
		const unknown: string[] = [];
		const unparsed: string[] = [];
		for (const literal of literals) {
			const normalized = normalizeRouteLiteral(literal);
			if (normalized.unparsed !== undefined) {
				unparsed.push(normalized.unparsed);
				continue;
			}
			for (const shape of normalized.shapes) {
				if (!known.has(shape)) unknown.push(`${literal} → ${shape}`);
			}
		}
		// 无法归一 = 守卫看不见这条路径，必须当场失败并让作者选择：改写成可辨认的形式，
		// 或到 AGGLOMERATE_ROUTES 显式登记。
		expect(
			unparsed,
			`存在无法归一的路由字面量（守卫会静默漏检，请改写成 \${encodeURIComponent(x)} 形式或显式登记）: ${unparsed.join(" | ")}`,
		).toEqual([]);
		expect(
			unknown,
			`存在 webRoutes 之外的路径（服务端改路径时该客户端会静默 404）: ${unknown.join(" | ")}`,
		).toEqual([]);
	});

	/**
	 * 反向缺口：`web:true` 只表示「手机端 UI 需要该能力」，不等于客户端一定有调用点
	 * （stop / settings 类由桌面 renderer 与 /api/state 聚合路径承担）。因此这里只核对
	 * **abort 与 stop 不得混用**——两者语义差一个数量级（abort 只中止当前回合，
	 * stop 会退役 pi 进程），把 abort 打到 /stop 会让用户的「停止」变成杀掉会话，
	 * 而这种漂移不会报错，只会表现得「点一下整段对话没了」。
	 */
	it("abort 与 stop 路径不同，且该客户端确实调用 abort", () => {
		const abortPath = routeShape(`/api${webRoutes.agents.abort.path}`);
		const stopPath = routeShape(`/api${webRoutes.agents.stop.path}`);
		// 服务端表本身不得让两个语义合并到同一个 URL。
		expect(abortPath).not.toBe(stopPath);
		const shapes = new Set(
			literals.flatMap((literal) => normalizeRouteLiteral(literal).shapes ?? []),
		);
		expect(shapes, "该客户端的停止按钮必须打到 abort 端点").toContain(abortPath);
	});
});

/**
 * 服务端分发奇偶守卫：表里有、分发里没接 = 运行时静默 404。
 *
 * 上面两组核对的是「客户端写的路径在表里」，反向仍然敞开：往 webRoutes 加一条
 * 端点（或把一条手写 if 改成 matchWebRoute 时改错键）而忘了在 WebServiceManager
 * 里分发，客户端照旧拼得出合法 URL，服务端却一路落到 `/api/` 的 404 分支。
 * 这里静态核对两件事：每条表内端点都有对应的匹配调用，且没有匹配调用指向表外的键。
 */
describe("服务端分发 × webRoutes 奇偶守卫", () => {
	const serverSource = readFileSync(WEB_SERVICE_MANAGER, "utf8");

	/**
	 * 扫源码前剥掉注释。
	 *
	 * 守卫是文本匹配：把一条真分发删掉、在注释里留一句
	 * `// matchWebRoute(webRoutes.agents.runtimeState` 就能骗过它。
	 * 剥注释后注释不再能"满足"守卫，这条捷径消失。
	 */
	function stripComments(source: string): string {
		return source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			// 行注释只认「行首或空白之后的 //」：URL 里的 `http://` 前面是冒号，
			// 放宽成 `[^:]` 外的任意字符会把 `"http://x"` 之后整行切掉，
			// 连同行尾的真实分发调用一起吞掉（守卫于是假绿）。
			.replace(/(^|\s)\/\/[^\n]*/g, "$1");
	}

	/** 抽出 `matchWebRoute(webRoutes.<ns>.<member>` 的成员键。 */
	function dispatchedKeys(): string[] {
		const keys = new Set<string>();
		for (const match of stripComments(serverSource).matchAll(
			/matchWebRoute\(\s*webRoutes\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g,
		)) {
			keys.add(`${match[1]}.${match[2]}`);
		}
		return [...keys];
	}

	/** 表内全部成员键（webRoutes 与 ipcTable 由 satisfies 保证成员齐备）。 */
	function tableKeys(): string[] {
		const keys: string[] = [];
		for (const [namespace, members] of Object.entries(
			webRoutes as unknown as Record<string, Record<string, WebRestRoute>>,
		)) {
			for (const member of Object.keys(members)) keys.push(`${namespace}.${member}`);
		}
		return keys;
	}

	it("每条表内端点都有对应的服务端分发", () => {
		const dispatched = new Set(dispatchedKeys());
		const missing = tableKeys().filter((key) => !dispatched.has(key));
		expect(
			missing,
			`webRoutes 里有端点没有分发（客户端能拼出 URL，服务端却 404）: ${missing.join(" | ")}`,
		).toEqual([]);
	});

	it("没有分发指向表外的键（否则是拼错的成员名）", () => {
		const known = new Set(tableKeys());
		const stray = dispatchedKeys().filter((key) => !known.has(key));
		expect(stray, `分发引用了 webRoutes 之外的成员: ${stray.join(" | ")}`).toEqual([]);
	});

	it("能抽到分发调用（否则守卫空转）", () => {
		expect(dispatchedKeys().length).toBe(tableKeys().length);
	});
});

/**
 * 表内 method + path 唯一性。
 *
 * 分发是顺序 if 链：两条同形状条目时，前一条分支永远遮蔽后一条，而后一条的客户端
 * 仍能拼出「合法」URL——只会落到前一条的语义上。三处守卫都会自证一致（客户端从表取值、
 * 服务端用同表匹配），所以这条重复必须单独守。
 */
describe("webRoutes 表自洽", () => {
	it("method + path 组合不重复", () => {
		const seen = new Map<string, string>();
		const duplicates: string[] = [];
		for (const [namespace, members] of Object.entries(
			webRoutes as unknown as Record<string, Record<string, WebRestRoute>>,
		)) {
			for (const [member, route] of Object.entries(members)) {
				const key = `${route.method} ${route.path}`;
				const owner = seen.get(key);
				if (owner) duplicates.push(`${key}（${owner} 与 ${namespace}.${member}）`);
				else seen.set(key, `${namespace}.${member}`);
			}
		}
		expect(
			duplicates,
			`webRoutes 存在重复端点（后一条分发永远不可达）: ${duplicates.join(" | ")}`,
		).toEqual([]);
	});

	/**
	 * 占位符语法：必须独占一整段。
	 *
	 * `webRouteUrl`（客户端拼 URL）与 `webRouteRegex`（服务端匹配）是两条独立实现，
	 * 段内写法 `/x/full-text:entryId` 会让客户端替换成字面量路径、服务端却按字面量 `:`
	 * 匹配——「客户端拼得出、服务端永远 404」，且不报错。两侧都拒绝这种模板。
	 */
	it("占位符独占路径段（客户端与服务端语法同源）", () => {
		const bad: string[] = [];
		for (const [namespace, members] of Object.entries(
			webRoutes as unknown as Record<string, Record<string, WebRestRoute>>,
		)) {
			for (const [member, route] of Object.entries(members)) {
				const embedded = route.path
					.split("/")
					.filter((segment) => segment.includes(":") && !/^:[A-Za-z0-9_]+$/.test(segment));
				if (embedded.length > 0) {
					bad.push(`${namespace}.${member} ${route.path}（${embedded.join(", ")}）`);
				}
			}
		}
		expect(bad, `webRoutes 存在段内占位符: ${bad.join(" | ")}`).toEqual([]);
	});

	it("段内占位符在建 URL 与匹配时都抛错，而不是各解析一套", () => {
		const malformed = { method: "GET", path: "/agents/:agentId/full-text:entryId" } as WebRestRoute;
		expect(() => webRoutePathParams(malformed.path)).toThrow(/独占一段/);
		expect(() => webRouteUrl(malformed, { agentId: "a", entryId: "e" })).toThrow(/独占一段/);
		// 服务端匹配同样拒绝，而不是把这个模板当成一条「字面量里带冒号」的普通路由。
		expect(() => matchWebRoute(malformed, "/api/agents/a/full-text:x", "GET")).toThrow(/独占一段/);
	});

	it("参数值编码后不会逃出所属路径段", () => {
		const route = { method: "GET", path: "/agents/:agentId/messages/:messageId" } as WebRestRoute;
		expect(webRouteUrl(route, { agentId: "a/1", messageId: "m 1" })).toBe(
			"/api/agents/a%2F1/messages/m%201",
		);
		expect(matchWebRoute(route, "/api/agents/a%2F1/messages/m%201", "GET")).toEqual({
			agentId: "a/1",
			messageId: "m 1",
		});
	});
});
