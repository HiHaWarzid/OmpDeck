/* OmpDeck Mobile 的纯状态决策。
 * 这个文件不碰 DOM、不读时间、不发请求，便于在 jsdom/Node 里直接测试；
 * mobile.js 只负责把结果应用到页面。经典脚本加载时挂到 globalThis.OmpMobileState。 */
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	if (root) root.OmpMobileState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
	function mergeMessageLists() {
		const byId = new Map();
		for (let index = 0; index < arguments.length; index += 1) {
			const list = arguments[index];
			if (!Array.isArray(list)) continue;
			for (const message of list) {
				if (message && message.id) byId.set(message.id, message);
			}
		}
		return Array.from(byId.values());
	}

	function appendTail(current, incoming, options) {
		const reset = Boolean(options && options.reset);
		const limit = Number(options && options.limit) || 0;
		const merged = mergeMessageLists(reset ? [] : current, incoming);
		if (!limit || merged.length <= limit) return merged;
		// limit 只约束服务端真实消息；乐观消息必须额外保留，否则 40 条窗口 +
		// 1 条乐观消息会挤掉一条真实消息，客户端 length 比服务端少 1，下一轮
		// 轮询被判成窗口不一致并整窗 reset，刚发出的气泡会消失。
		const keptReal = merged.filter((message) => !message.optimistic).slice(-limit);
		const keptIds = new Set(keptReal.map((message) => message.id));
		return merged.filter((message) => message.optimistic || keptIds.has(message.id));
	}

	function mergeOlder(older, incoming) {
		// 历史分页返回的是更早的一页；保持页面顺序，已有 id 由 Map 去重。
		return mergeMessageLists(incoming, older);
	}

	/**
	 * 历史页消息 id 由 entryId 生成，实时 transcript 用运行态 id，两者内容相同但 id 不同。
	 * 历史文件与运行态对 thinking/重试消息的收录顺序并不完全一致，不能按前后缀对齐；
	 * 这里按内容签名做多重集匹配：live 中每出现一次，就抵掉 history 中同一条，保留未匹配的
	 * 更早历史消息，避免打开正在运行的会话时同一轮对话显示两遍。
	 */
	function timelineSignature(message) {
		const meta = message && message.meta ? message.meta : {};
		// 只取前缀，容忍流式结束时历史文件与运行态正文的尾差；tool 结果带上名称与结果前缀。
		return [
			message?.role || "",
			String(message?.text || "").slice(0, 200),
			meta.toolName || "",
			typeof meta.result === "string" ? meta.result.slice(0, 200) : "",
		].join("\u0000");
	}

	function mergeTimeline(older, chat) {
		const history = Array.isArray(older) ? older : [];
		const live = Array.isArray(chat) ? chat : [];
		const liveCounts = new Map();
		for (const message of live) {
			const key = timelineSignature(message);
			liveCounts.set(key, (liveCounts.get(key) || 0) + 1);
		}
		const unmatchedHistory = [];
		for (const message of history) {
			const key = timelineSignature(message);
			const count = liveCounts.get(key) || 0;
			if (count > 0) liveCounts.set(key, count - 1);
			else unmatchedHistory.push(message);
		}
		return mergeMessageLists(unmatchedHistory, live);
	}

	function countNewMessages(current, incoming) {
		const known = new Set((current || []).map((message) => message.id));
		return (incoming || []).filter((message) => message && !known.has(message.id)).length;
	}

	function shouldAcceptResponse(request) {
		return Boolean(
			request &&
				request.requestEpoch === request.currentEpoch &&
				request.requestAgentId &&
				request.requestAgentId === request.currentAgentId,
		);
	}

	function pollDelay(options) {
		if (options && options.hidden) return null;
		return options && options.running ? 500 : 5000;
	}

	function isNearBottom(options) {
		const threshold = Number(options && options.threshold) || 80;
		const scrollHeight = Number(options && options.scrollHeight) || 0;
		const scrollTop = Number(options && options.scrollTop) || 0;
		const clientHeight = Number(options && options.clientHeight) || 0;
		return scrollHeight - scrollTop - clientHeight < threshold;
	}

	function scrollPlan(options) {
		const mode = (options && options.mode) || "auto";
		const previousHeight = Number(options && options.previousHeight) || 0;
		const previousTop = Number(options && options.previousTop) || 0;
		const scrollHeight = Number(options && options.scrollHeight) || 0;
		if (mode === "initial") {
			return { scrollTop: scrollHeight, showNewMessages: false };
		}
		if (mode === "preserve") {
			return {
				scrollTop: previousTop + Math.max(0, scrollHeight - previousHeight),
				showNewMessages: false,
			};
		}
		if (options && options.nearBottom) {
			return { scrollTop: scrollHeight, showNewMessages: false };
		}
		return {
			scrollTop: previousTop,
			showNewMessages: Boolean(options && Number(options.newCount) > 0),
		};
	}

	function tailLength(messages) {
		return (messages || []).filter((message) => !message.optimistic).length;
	}

	function lastRealMessageId(messages) {
		const list = messages || [];
		for (let index = list.length - 1; index >= 0; index -= 1) {
			if (!list[index].optimistic) return list[index].id;
		}
		return "";
	}

	function removeAcknowledgedOptimistic(current, incoming) {
		const optimistic = (current || []).filter((message) => message && message.optimistic);
		if (!optimistic.length) return current || [];
		const acknowledged = new Set();
		for (const local of optimistic) {
			const hit = (incoming || []).find(
				(message) =>
					message &&
					message.role === "user" &&
					message.text === local.text &&
					Math.abs((Number(message.timestamp) || 0) - (Number(local.timestamp) || 0)) <= 10000,
			);
			if (hit) acknowledged.add(local.id);
		}
		if (!acknowledged.size) return current || [];
		return (current || []).filter((message) => !acknowledged.has(message.id));
	}

	// ── 消息 → 展示项 ─────────────────────────────────────────────
	// 这段以前埋在 mobile.js 第 106 个函数之后：渲染流水线里唯一的纯决策
	// （该显示哪条、工具怎么折、展开按钮怎么说）与 DOM 赋值挨着，导致手机端
	// 零测试。搬到这个文件后，只有转义与 innerHTML 留在 mobile.js。

	/** 工具名 → 中文标签。领域词表留在这里，别的文件不再各存一份。 */
	function toolNameLabel(name) {
		const names = {
			read: "读取",
			read_file: "读取",
			bash: "命令",
			eval: "执行",
			write: "写入",
			write_file: "写入",
			edit: "编辑",
			edit_file: "编辑",
			apply_patch: "补丁",
			glob: "查找",
			grep: "搜索",
			list_dir: "目录",
			task: "子任务",
			wait: "等待",
			todo: "任务",
			todo_write: "任务",
			web_search: "搜索网页",
			web_fetch: "网页",
			lsp: "分析",
			ask: "询问",
			ask_question: "提问",
		};
		return names[name] || name || "工具";
	}

	function toolLabel(text) {
		return String(text || "").replace(
			/^([✓✗▶])\s*([A-Za-z_][\w-]*)/,
			(_, mark, name) => `${mark} ${toolNameLabel(name)}`,
		);
	}

	function durationText(value) {
		const ms = Number(value);
		if (!Number.isFinite(ms) || ms <= 0) return "";
		return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
	}

	function shortText(value, max = 120) {
		const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
		return text.length > max ? `${text.slice(0, max - 1)}…` : text;
	}

	/** 工具卡片副标题：服务端 compact / 详情端点已用 shared/sessionDisplayContract 算好
	 *  meta.summary（参数键优先级唯一实现）；这里只对「旧服务端没有 summary」的响应
	 *  保留一个 result 兜底，不再复制 detailText 正文行解析。 */
	function toolSummary(meta) {
		if (typeof meta.summary === "string" && meta.summary) return meta.summary;
		return shortText(meta.result);
	}

	/** 历史消息里 text 可能带 <thinking> 标签，同时另有 thinking 字段；展示时只保留正文。 */
	function splitThinking(text, thinking) {
		const raw = String(text || "").trim();
		let found = typeof thinking === "string" ? thinking.trim() : "";
		let body = raw;
		// pi 的思考块包在整条消息最外层；思考内容本身可能包含字面量 <thinking>，
		// 所以从开头匹配到最后一个 </thinking>，不能使用非贪婪匹配。
		if (/^<thinking\b/i.test(raw)) {
			const end = raw.lastIndexOf("</thinking>");
			if (end !== -1) {
				if (!found) found = raw.slice(0, end).replace(/^<thinking\b[^>]*>/i, "").trim();
				body = raw.slice(end + "</thinking>".length).trim();
			} else {
				body = raw.replace(/^<thinking\b[^>]*>/i, "").trim();
			}
		} else {
			body = raw
				.replace(/<thinking\b[^>]*>([\s\S]*?)<\/thinking>/gi, (_, inner) => {
					if (!found) found = inner.trim();
					return "";
				})
				.trim();
		}
		return { body, thinking: found };
	}

	/**
	 * 一条消息 → 一个展示项。只产出数据，不含任何 HTML：
	 * 转义与拼接留在 mobile.js，测试可以直接断言这个对象。
	 *
	 * 状态三件套（glyph/error/文案）与投递文案都由服务端按共享契约写好，
	 * 手机端不再解析 meta.status / streamingBehavior，也不维护中文表。
	 */
	function displayItem(message) {
		const role = message.role || "assistant";
		const label = role === "system" ? "系统" : role === "error" ? "错误" : "助手";
		const images = Array.isArray(message.images) ? message.images : [];
		const { body, thinking } = splitThinking(message.text, message.thinking);
		const thinkingOnly = !body && !!thinking;
		const meta = message.meta || {};
		const toolMatch = /^([✓✗▶])\s*([^\s]+)/.exec(String(body || ""));
		const toolName = toolNameLabel(String(meta.toolName || (toolMatch && toolMatch[2]) || "工具"));
		const toolStatus = typeof meta.statusGlyph === "string" ? meta.statusGlyph : "";
		const toolError = meta.statusKind === "error";
		const toolState = typeof meta.statusText === "string" ? meta.statusText : "";
		const duration = durationText(meta.durationMs);
		const delivery = typeof meta.deliveryText === "string" ? meta.deliveryText : "";
		const toolDetail = role === "tool" ? toolSummary(meta) : "";
		const text = role === "tool" ? toolLabel(body) : body;
		const textRemaining = Number.isFinite(Number(meta.fullLength))
			? Number(meta.fullLength) - String(body || "").length
			: 0;
		const thinkingRemaining = Number.isFinite(Number(meta.fullThinkingLength))
			? Number(meta.fullThinkingLength) - String(thinking || "").length
			: 0;
		// 只有服务端标了 hasMore/thinkingHasMore 才给展开按钮：截断判定属于服务端契约，
		// 手机端凭长度猜会让「全文已到但没有标记」的消息永远显示展开。
		const expand = meta.hasMore || meta.thinkingHasMore
			? {
					label:
						meta.hasMore && meta.thinkingHasMore
							? "展开全文"
							: meta.hasMore
								? "展开工具输出"
								: "展开思考",
					remaining: Math.max(0, textRemaining, thinkingRemaining),
				}
			: null;
		return {
			id: message.id,
			role,
			label,
			images,
			body,
			thinking,
			thinkingOnly,
			thinkingPreview: shortText(thinking, 48),
			text,
			expand,
			timestamp: message.timestamp,
			duration,
			toolName,
			toolDetail,
			toolError,
			toolStatus,
			toolState,
			delivery,
			optimistic: Boolean(message.optimistic),
		};
	}

	/**
	 * 展示项 → 渲染计划。连续工具调用折成一组「执行过程」，其余各占一条。
	 *
	 * 组状态复用每条工具消息的服务端文案（运行中 > 失败 > 最后一条），
	 * 手机端不再拼中文状态词；纯思考消息保留，交给 details 折叠。
	 */
	function groupDisplayItems(items) {
		const visible = (items || []).filter(
			(item) => !(item.role === "assistant" && !item.body && !item.images.length && !item.thinking),
		);
		const plan = [];
		for (let index = 0; index < visible.length; index += 1) {
			const item = visible[index];
			if (item.role !== "tool") {
				plan.push({ type: "single", item });
				continue;
			}
			const group = [item];
			while (index + 1 < visible.length && visible[index + 1].role === "tool") {
				index += 1;
				group.push(visible[index]);
			}
			if (group.length === 1) {
				plan.push({ type: "single", item });
				continue;
			}
			// 执行过程默认展开：手机端最需要看到 agent 实际跑了哪些命令，
			// 折叠起来只剩「工具 · N 次」，等于把过程信息全部藏掉。
			const running = group.some((entry) => entry.toolStatus === "▶");
			const failed = group.some((entry) => entry.toolError);
			const state =
				(group.find((entry) => entry.toolStatus === "▶") ||
					group.find((entry) => entry.toolError) ||
					group[group.length - 1]).toolState || "";
			plan.push({ type: "toolGroup", key: `group:${group[0].id}`, entries: group, running, failed, state });
		}
		return plan;
	}

	/**
	 * 本脚本的 URL 是否仍是 Vite dev 下发的原文。
	 *
	 * 判据是占位符前缀 `__SHELL` 还在：Main 的 sendFile 会把 `__SHELL_VERSION__` 整体
	 * 替换成数字，处理后不可能再出现这个前缀。这里只比较前缀、不写完整占位符，因为这
	 * 个文件自己也会被 sendFile 处理一次——写完整占位符会被替换成数字，生产判断随即反转。
	 */
	function isUnversionedShell(src) {
		return typeof src === "string" && src.includes("__SHELL");
	}

	return {
		isUnversionedShell,
		mergeMessageLists,
		mergeTimeline,
		appendTail,
		mergeOlder,
		countNewMessages,
		shouldAcceptResponse,
		pollDelay,
		isNearBottom,
		scrollPlan,
		tailLength,
		lastRealMessageId,
		removeAcknowledgedOptimistic,
		toolNameLabel,
		toolLabel,
		durationText,
		shortText,
		toolSummary,
		splitThinking,
		displayItem,
		groupDisplayItems,
	};
});
