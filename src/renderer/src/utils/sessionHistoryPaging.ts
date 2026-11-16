import type { AgentHistoryPage } from "../../../shared/api";
import type { ChatMessage } from "../../../shared/types";

/**
 * 大会话「更早历史」分页的账本。
 *
 * 为什么收成一个 module：这段逻辑此前是 App 里的 3 个 useState + 2 个 useRef +
 * 一个 40 行 loader + 一个重置 effect，外加 ConversationPane 里另一份 id 去重。
 * 五条互相依赖的不变式只写在注释里，任何一条改错都只表现为「翻页偶尔重复」
 * 「切会话后旧页串台」「翻到第八页却看不到」，而接口是 6728 行的 App 函数，
 * 一条测试都写不了。收进 module 后，不变式与产生页的代码同处一室：
 *
 * - 单飞：同一 key 在途时再次点击直接丢弃（点击瞬间 state 还没刷新，不能靠 state 挡）；
 * - 作用域绑定：页属于一个 (agentId, sessionPath, 基线代号)，cursor 只从同一 key 复用；
 * - 陈旧响应丢弃：切换作用域 / 基线重建都会推进请求代号，晚到的响应一律作废；
 * - 基线失效：进程重连或压缩会替换 transcript 尾窗，旧页与新基线之间会出现空洞，
 *   因此 `invalidateBaseline()` 清页并推进代号；
 * - id 去重：尾窗与文件页、相邻两页之间可能重复同一条消息，按稳定 id 去重（拼到实时
 *   转录基线前面时还要再对一次，见 `mergeOlderHistory`）。
 *
 * 账本只被 `loadNextPage` 改写，展示视图由 `read(scope)` 纯派生——作用域跟着 React 状态走，
 * 不存在「先渲染旧作用域、下一帧才纠正」的空窗。模块不依赖 React 与 window，可用单测直接驱动。
 */

const EMPTY_OLDER_MESSAGES: readonly ChatMessage[] = Object.freeze([]);

/** 一页旧历史与它的归属 key。cursor 是下一页的字节偏移，0 表示已到文件头。 */
type PageLedger = {
	key: string;
	messages: readonly ChatMessage[];
	cursor: number;
	hasMore: boolean;
};

const EMPTY_LEDGER: PageLedger = { key: "", messages: EMPTY_OLDER_MESSAGES, cursor: 0, hasMore: true };

/** 旧页的作用域：任一字段变化都意味着「这些页不再属于当前会话」。 */
export type SessionHistoryScope = {
	agentId: string | null | undefined;
	sessionPath?: string;
	/** 尾窗之外还有更早内容（`AgentTab.historyHasOlder`）。 */
	historyHasOlder?: boolean;
};

export type SessionHistoryPagingSnapshot = {
	/** 当前作用域下的旧页（时间正序，最旧在前）；不属于当前作用域时是稳定空数组。 */
	olderMessages: readonly ChatMessage[];
	/** 是否还能继续向前翻。 */
	hasMore: boolean;
	/** 当前作用域是否有在途请求（按钮 loading）。 */
	loading: boolean;
};

export type SessionHistoryPagingOptions = {
	/** 读一页更早历史；beforeOffset 缺省表示从尾窗边界继续。 */
	loadPage: (agentId: string, beforeOffset?: number) => Promise<AgentHistoryPage>;
	/** 失败回调（App 侧弹 toast）。请求已过期时不会被调用。 */
	onError?: (error: unknown) => void;
};

export type SessionHistoryPaging = {
	/** 供 useSyncExternalStore 订阅。 */
	subscribe(listener: () => void): () => void;
	/** 账本修订号：只在账本/loading/代号变化时自增，作为订阅组件的快照值。 */
	getRevision(): number;
	/** 当前作用域的分页视图；输入不变时返回同一引用（useSyncExternalStore 需要稳定快照）。 */
	read(scope: SessionHistoryScope): SessionHistoryPagingSnapshot;
	/**
	 * 会话已被切走（App 在 effect 里调用，不是渲染里）：作废在途请求，
	 * 让迟到的页不再写进任何账本，同时复位 loading。
	 *
	 * 传当前作用域而不是无条件作废：**会话身份**是 `agentId ∥ sessionPath`，与翻页 key
	 * 不同（不含基线代号，也不含 `historyHasOlder`）。后者每次基线刷新都会变，
	 * 拿整个作用域判定「切走了」会让一次尾窗刷新就丢掉仍在路上的页。
	 */
	abandonInFlight(scope: SessionHistoryScope): void;
	/** 基线被替换（重连 / 压缩重载）：清页、推进代号、作废在途请求。 */
	invalidateBaseline(): void;
	/** 加载下一页。单飞：在途期间的重复调用返回同一个 promise。 */
	loadNextPage(scope: SessionHistoryScope): Promise<void>;
};

/** key = agentId ∥ sessionPath ∥ 基线代号。 */
function scopeKey(
	agentId: string | null | undefined,
	sessionPath: string | undefined,
	epoch: number,
): string {
	return agentId ? `${agentId}\u0000${sessionPath ?? ""}\u0000${epoch}` : "";
}

/**
 * 会话身份 = agentId ∥ sessionPath，**不含**基线代号。
 *
 * 「哪一页属于哪个会话文件」用 key（含代号），「用户有没有切走」用身份。
 * 两者混用时，任何一次尾窗刷新都会让在途页被误判为过期而丢弃。
 */
function sessionIdentity(agentId: string | null | undefined, sessionPath: string | undefined): string {
	return agentId ? `${agentId}\u0000${sessionPath ?? ""}` : "";
}

/**
 * 把旧页拼到实时转录基线前面。
 *
 * 首屏基线（尾窗）与文件页在边界处可能重叠，重复的消息会变成重复气泡 + React key 冲突，
 * 因此按稳定 id 过滤。基线随时在增长（流式），所以这一步必须在渲染时做，不能固化进账本。
 */
export function mergeOlderHistory(
	olderMessages: readonly ChatMessage[] | undefined,
	transcriptMessages: ChatMessage[],
): ChatMessage[] {
	// 无重叠时原样返回基线的同一个引用：下游 useMemo/依赖比较靠它省掉一次全量重渲染。
	if (!olderMessages?.length) return transcriptMessages;
	const known = new Set(transcriptMessages.map((message) => message.id));
	const older = olderMessages.filter((message) => !known.has(message.id));
	return older.length > 0 ? [...older, ...transcriptMessages] : transcriptMessages;
}

export function createSessionHistoryPaging(
	options: SessionHistoryPagingOptions,
): SessionHistoryPaging {
	const listeners = new Set<() => void>();

	let epoch = 0;
	let ledger: PageLedger = EMPTY_LEDGER;
	/** 在途请求的 key（而非作用域对象）：同一会话的重复点击被它挡住。 */
	let loadingKey: string | null = null;
	/**
	 * 在途请求所属的**会话身份**（`agentId ∥ sessionPath`，不含基线代号）。
	 * `abandonInFlight` 用它判断「用户是否真的切走了」：key 里的代号会在尾窗刷新时变，
	 * 拿完整 key 判定会把同一会话正在路上的页误杀。
	 */
	let loadingIdentity: string | null = null;
	/**
	 * 请求代号：基线失效与新一轮请求都推进它，晚到的响应据此丢弃。
	 * 单靠 key 比较不够——切走再切回同一会话时 key 会重新相等，只有代号能识别「这是上一轮的响应」。
	 */
	let requestId = 0;
	let inFlight: Promise<void> | null = null;
	/** 账本修订号：只在账本或 loading 变化时自增，供 read() 做单条目记忆。 */
	let revision = 0;

	let memoInput: { revision: number; key: string; hasOlder: boolean } | null = null;
	let memoOutput: SessionHistoryPagingSnapshot | null = null;

	const notify = (): void => {
		revision += 1;
		for (const listener of [...listeners]) listener();
	};

	/** 丢弃在途请求：推进代号 + 复位 loading。响应回来时据此判定过期。 */
	function discardInFlight(): boolean {
		if (requestId === 0 && loadingKey === null) return false;
		requestId += 1;
		loadingKey = null;
		loadingIdentity = null;
		inFlight = null;
		return true;
	}

	function append(key: string, page: AgentHistoryPage): void {
		// cursor 只从同一 key 复用：换了作用域后遗留的 cursor 属于另一个文件，绝不能继续用。
		const base = ledger.key === key ? ledger.messages : EMPTY_OLDER_MESSAGES;
		const seen = new Set(base.map((message) => message.id));
		const incoming = page.messages.filter((message) => {
			if (seen.has(message.id)) return false;
			seen.add(message.id);
			return true;
		});
		ledger = {
			key,
			// 页是「更早」的，必须前插，否则时间线顺序会倒过来。
			messages: incoming.length > 0 ? [...incoming, ...base] : base,
			cursor: page.cursor,
			hasMore: page.hasMore,
		};
	}

	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		getRevision: () => revision,

		abandonInFlight(scope) {
			// 会话已切走：在途请求的结果不再属于当前视图，作废它（loading 也要复位）。
			// loadingKey 是 null 说明没有在途请求，不必白换信封。
			if (loadingIdentity === null) return;
			// 同一会话文件（agent + sessionPath 未变）：基线代号可能刚推进过
			// （尾窗刷新），但这次请求仍属于用户正在看的会话，保留它。
			if (loadingIdentity === sessionIdentity(scope.agentId, scope.sessionPath)) return;
			if (discardInFlight()) notify();
		},

		read(scope) {
			const key = scopeKey(scope.agentId, scope.sessionPath, epoch);
			const hasOlder = Boolean(scope.historyHasOlder);
			const previous = memoInput;
			if (
				previous
				&& previous.revision === revision
				&& previous.key === key
				&& previous.hasOlder === hasOlder
			) {
				return memoOutput as SessionHistoryPagingSnapshot;
			}
			const matches = key !== "" && ledger.key === key;
			// 尾窗之外还有内容（historyHasOlder）是前提；已经翻空（hasMore=false）才停。
			// 尚未为当前 key 拉过页时（matches=false）仍要显示「可以继续翻」。
			// 没有 sessionPath 就没有可翻的文件，入口不该出现（与迁移前一致）。
			const snapshot: SessionHistoryPagingSnapshot = {
				olderMessages: matches ? ledger.messages : EMPTY_OLDER_MESSAGES,
				hasMore: hasOlder && key !== "" && Boolean(scope.sessionPath) && (!matches || ledger.hasMore),
				loading: loadingKey !== null && loadingKey === key,
			};
			memoInput = { revision, key, hasOlder };
			memoOutput = snapshot;
			return snapshot;
		},

		invalidateBaseline() {
			epoch += 1;
			ledger = EMPTY_LEDGER;
			discardInFlight();
			notify();
		},

		loadNextPage(scope) {
			const { agentId, sessionPath } = scope;
			if (!agentId || !sessionPath) return Promise.resolve();
			const key = scopeKey(agentId, sessionPath, epoch);
			// 单飞：点击瞬间 state 还没重渲染，必须用同步的 key 判定挡第二次点击。
			if (loadingKey === key) return inFlight ?? Promise.resolve();

			loadingKey = key;
			loadingIdentity = sessionIdentity(agentId, sessionPath);
			const request = ++requestId;
			const cursor = ledger.key === key ? ledger.cursor : undefined;
			notify();

			const settled = (async () => {
				try {
					const page = await options.loadPage(agentId, cursor);
					// 基线失效 / 新一轮请求：结果一律作废，不能覆盖当前账本。
					if (request !== requestId) return;
					append(key, page);
				} catch (error) {
					if (request !== requestId) return;
					options.onError?.(error);
				} finally {
					// 只有本次请求仍是最新时才收尾：否则会把新请求的 loading 清掉。
					if (request === requestId) {
						if (loadingKey === key) {
							loadingKey = null;
							loadingIdentity = null;
						}
						inFlight = null;
						notify();
					}
				}
			})();

			inFlight = settled;
			return settled;
		},
	};
}
