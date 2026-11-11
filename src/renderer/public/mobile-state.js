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

	return {
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
	};
});
