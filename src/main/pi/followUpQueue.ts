import type { AgentQueuedMessages, ImageContent } from "../../shared/types";

/**
 * follow-up 排队消息的本地快照：与真实投递时的气泡内容一一对应。
 *
 * 为什么不直接把已排队消息插进时间线？队列里的消息尚未进入本轮上下文，
 * 若此刻就落气泡，当前回答会被切成「上一轮 + 新冒出的用户消息 + 剩余回答」，
 * 用户看到的就是「结束后排队」的消息已经发出去了。
 */
export type DeferredFollowUp = {
	/** 时间线气泡文案：用户可见原文，不含宿主注入的隐藏标记。 */
	text: string;
	/**
	 * 对账用的队列文案：omp 的 queue chip 按实际收到的消息生成。
	 * plan 模式等场景下它会带上隐藏标记，与 `text` 不同，所以两个都留着做匹配。
	 */
	queueText: string;
	images?: ImageContent[];
	meta: Record<string, unknown>;
};

/**
 * 撤回墓碑的有效期。只需覆盖「撤回请求发出 → 在途准入对账返回」这段窗口
 * （get_state 上限 10s），过期即失效，避免长期压制同文案的新消息。
 */
export const WITHDRAWN_FOLLOW_UP_TTL_MS = 30_000;

/** 队列快照里的全部 chip 文案（steering 在前，followUp 在后）。 */
export function queuedTexts(snapshot: AgentQueuedMessages): string[] {
	return [...snapshot.steering, ...snapshot.followUp];
}

/** 本地快照与 chip 文案是否指同一条消息。 */
export function deferredMatchesText(entry: DeferredFollowUp, text: string): boolean {
	return entry.queueText === text || entry.text === text;
}

/** 准入对账结果：`delivered` 是这次对账新确认「已投递」的条目（可能不止一条）。 */
export type FollowUpAdmission = {
	/** 该条目仍留在服务端队列，气泡要继续压着。 */
	queued: boolean;
	/** 需要立刻落气泡的条目（含竞态兜底里被顺带确认投递的旧条目）。 */
	delivered: DeferredFollowUp[];
};

/**
 * follow-up 排队账本（每个 agent 一份）。
 *
 * 这里只做判断，不做副作用：落气泡由调用方按返回值执行，因此投递/撤回/中止恢复
 * 的全部规则都能在纯状态上断言，不需要窗口、RPC 或时间线。
 *
 * 三条不变量：
 * - 一条消息只在「确认投递」后才落气泡，撤回/中止拿回的消息永远不会出现；
 * - 同文案连发时按 FIFO 语义从尾部保留仍在队列里的条目，图片/meta 才能对上；
 * - 墓碑只覆盖在途对账窗口，过期自清，不能长期压住同文案的新消息。
 */
export class FollowUpQueue {
	/** 已提交给 omp、但还在服务端队列里没投递的 follow-up 快照（按发送顺序）。 */
	private readonly deferred: DeferredFollowUp[] = [];
	/** 文案 -> 墓碑过期时刻。 */
	private readonly withdrawn = new Map<string, number>();
	private lastSnapshot: AgentQueuedMessages | undefined;
	private lastSnapshotAt = 0;

	/** 只读快照（测试与中止恢复的名单汇总用）。 */
	get pending(): readonly DeferredFollowUp[] {
		return this.deferred;
	}

	/** 最近一次 queue_update 带下来的队列快照与到达时刻。 */
	get snapshot(): AgentQueuedMessages | undefined {
		return this.lastSnapshot;
	}

	get snapshotAt(): number {
		return this.lastSnapshotAt;
	}

	/** 记录来自 queue_update 的服务端队列快照。 */
	noteSnapshot(snapshot: AgentQueuedMessages, at = Date.now()): void {
		this.lastSnapshot = snapshot;
		this.lastSnapshotAt = at;
	}

	/**
	 * 准入对账：omp 收下消息后仍可能因为本地 busy 快照过期而立即开跑。
	 *
	 * - 快照里还有它 → 入队，等 queue_update 报告离队；
	 * - 快照里没有它 → 已投递，但要排除「对账窗口内已被我们撤回」的情况；
	 * - 快照读不到（RPC 失败/超时）→ 退回旧的乐观行为：宁可早显示一条，
	 *   也不能让已投递的消息永远不出现在时间线。
	 *
	 * 入队时若发送之后已经到达过更新的队列快照，会立刻按它再对账一次，
	 * 兜住「那次 queue_update 早于本条目入表、什么都没 flush 到」的竞态——
	 * 这类条目由 `settle` 在返回前从队列里摘掉，调用方只需处理 delivered。
	 */
	admit(entry: DeferredFollowUp, snapshot: AgentQueuedMessages | undefined, promptSentAt: number): FollowUpAdmission {
		const stillQueued =
			snapshot !== undefined && queuedTexts(snapshot).some((chipText) => deferredMatchesText(entry, chipText));
		if (!stillQueued) {
			// 离队不等于投递：对账窗口内用户可能已经撤回/中止并把它拿回输入框。
			return { queued: false, delivered: this.isWithdrawn(entry) ? [] : [entry] };
		}
		this.deferred.push(entry);
		if (this.lastSnapshot && this.lastSnapshotAt >= promptSentAt) {
			// 竞态兜底：命中投递的条目已由 settle 摘除，调用方看到的是 delivered。
			const delivered = this.settle(this.lastSnapshot);
			return { queued: !delivered.includes(entry), delivered };
		}
		return { queued: true, delivered: [] };
	}

	/**
	 * 按服务端队列快照结算：队列里剩余条数少于本地条数的部分就是已投递。
	 *
	 * omp 是 FIFO 投递，所以从尾部倒着保留仍在队列里的条目——同文案连发多条时
	 * 先投递的是靠前那条，倒序保留才能让图片/meta 与真实投递内容对齐。
	 */
	settle(snapshot: AgentQueuedMessages): DeferredFollowUp[] {
		if (this.deferred.length === 0) return [];
		const remaining = new Map<string, number>();
		for (const text of queuedTexts(snapshot)) {
			remaining.set(text, (remaining.get(text) ?? 0) + 1);
		}
		const keep = new Array<boolean>(this.deferred.length).fill(false);
		for (let index = this.deferred.length - 1; index >= 0; index -= 1) {
			const entry = this.deferred[index];
			if (!entry) continue;
			// 本进程正在/已经撤回这条消息：它离队是撤回造成的，不是投递。
			if (this.isWithdrawn(entry)) {
				keep[index] = true;
				continue;
			}
			// plan 模式下 chip 文案带隐藏标记，两个候选里命中一个就算还在队列。
			const queuedKey = [entry.queueText, entry.text].find((text) => (remaining.get(text) ?? 0) > 0);
			if (queuedKey === undefined) continue;
			remaining.set(queuedKey, (remaining.get(queuedKey) ?? 0) - 1);
			keep[index] = true;
		}
		const delivered: DeferredFollowUp[] = [];
		this.deferred.forEach((entry, index) => {
			if (!keep[index]) delivered.push(entry);
		});
		this.replace([...this.deferred].filter((_, index) => keep[index]));
		return delivered;
	}

	/**
	 * 用户主动撤回排队 follow-up：气泡从未写入时间线，只需丢掉本地快照，
	 * 否则下一次 queue_update 会把它当成「已投递」补一条不该出现的用户消息。
	 * 按首条匹配丢弃（同文案连发时撤回的正是服务端队列里的第一条）。
	 */
	takeWithdrawn(text: string): DeferredFollowUp | undefined {
		const index = this.deferred.findIndex((entry) => deferredMatchesText(entry, text));
		if (index === -1) return undefined;
		const [entry] = this.deferred.splice(index, 1);
		return entry;
	}

	/**
	 * 中止恢复：服务端把队列还给了我们，本地快照必须同步清空。
	 *
	 * 恢复到名单里的条目从未落气泡；不在名单里的说明中止前已被投递，需要补气泡。
	 * truncated 表示恢复的文本本身不完整，无法判断哪些已投递，只能全部丢弃，
	 * 宁可少一条气泡，也不要在时间线里塞进用户没看到执行的消息。
	 */
	resolveRestore(restoredTexts: readonly string[], truncated: boolean): DeferredFollowUp[] {
		const delivered: DeferredFollowUp[] = [];
		if (!truncated) {
			for (const entry of this.deferred) {
				if (restoredTexts.some((text) => deferredMatchesText(entry, text))) continue;
				delivered.push(entry);
			}
		}
		this.replace([]);
		return delivered;
	}

	/**
	 * 记下「这条 follow-up 是我们撤走的」：离队事件/准入对账只看得到「不在队列里」，
	 * 分不清投递还是撤回。墓碑只覆盖在途对账窗口，TTL 过期自动清理。
	 */
	markWithdrawn(text: string, now = Date.now()): void {
		for (const [key, expiry] of this.withdrawn) {
			if (expiry <= now) this.withdrawn.delete(key);
		}
		this.withdrawn.set(text, now + WITHDRAWN_FOLLOW_UP_TTL_MS);
	}

	/** 这条 follow-up 是否刚被本进程撤回（墓碑命中即视为未投递）。 */
	isWithdrawn(entry: DeferredFollowUp, now = Date.now()): boolean {
		if (this.withdrawn.size === 0) return false;
		let hit = false;
		for (const [text, expiry] of this.withdrawn) {
			if (expiry <= now) {
				this.withdrawn.delete(text);
				continue;
			}
			if (deferredMatchesText(entry, text)) hit = true;
		}
		return hit;
	}

	/** 某条文案当前是否带墓碑（含未过期的判定）。 */
	hasWithdrawn(text: string, now = Date.now()): boolean {
		this.prune(now);
		return this.withdrawn.has(text);
	}

	/** 撤回请求回执证明这条其实是「已投递」时，清掉墓碑让投递路径继续补气泡。 */
	clearWithdrawn(text: string): void {
		this.withdrawn.delete(text);
	}

	/** 进程重启/重连时整体重置，避免上一代进程的队列与墓碑污染新会话。 */
	reset(): void {
		this.replace([]);
		this.withdrawn.clear();
		this.lastSnapshot = undefined;
		this.lastSnapshotAt = 0;
	}

	private replace(next: DeferredFollowUp[]): void {
		this.deferred.splice(0, this.deferred.length, ...next);
	}

	private prune(now: number): void {
		for (const [key, expiry] of this.withdrawn) {
			if (expiry <= now) this.withdrawn.delete(key);
		}
	}
}
