import { describe, it, expect } from "vitest";
import type { AgentMessagesDelta, ChatMessage, ChatRole } from "../../../shared/types";
import {
	resolveFullPullResult,
	resolveIncomingMessagesDelta,
} from "./messageDeltaResolver";

/**
 * 测试 onMessages 解码逻辑（原内联在 App.tsx onMessages 处理器中）：
 * - 代数序号：delta 流上单调递增，调用方保存后用于异步全量拉取的陈旧判定；
 * - 陈旧全量结果丢弃：拉取期间有新 delta 到达 → resolveFullPullResult 返回 null；
 * - replaceFrom 语义：0 整体替换，>0 截断尾部拼接，越界触发自愈标记；
 * - prompt 历史重建耦合：只在全量基线上、且未初始化、且含有效用户消息时输出。
 */

function msg(id: string, role: ChatRole = "user", text = `msg-${id}`): ChatMessage {
	return { id, agentId: "agent-1", role, text, timestamp: 1 };
}

function delta(replaceFrom: number, messages: ChatMessage[]): AgentMessagesDelta {
	return { agentId: "agent-1", replaceFrom, messages };
}

describe("代数序号（seq guard 的基础）", () => {
	it("缺省 currentSeq 从 1 开始，后续传入递增", () => {
		const prev = [msg("a")];
		const first = resolveIncomingMessagesDelta(prev, delta(1, [msg("b")]));
		expect(first.seq).toBe(1);
		// 调用方把 seq 存回 ref，下一次以该值传入（App 的 messageDeltaSeqRef 行为）
		const second = resolveIncomingMessagesDelta(first.messages, delta(2, [msg("c")]), {
			currentSeq: first.seq,
		});
		expect(second.seq).toBe(2);
	});

	it("currentSeq 显式传入时 seq = currentSeq + 1", () => {
		const res = resolveIncomingMessagesDelta([], delta(0, [msg("a")]), { currentSeq: 41 });
		expect(res.seq).toBe(42);
	});
});

describe("陈旧全量结果丢弃（seq 守卫）", () => {
	it("拉取期间有新 delta（currentSeq !== capturedSeq）→ 返回 null 丢弃旧基线", () => {
		// 捕获代数 1 后，新 delta 把当前代数推到 2 → 该全量结果是旧基线
		const stale = resolveFullPullResult(1, 2, [msg("old")]);
		expect(stale).toBeNull();
	});

	it("序号相等视为新鲜：整体替换消息并在全量基线上重建 prompt 历史", () => {
		const res = resolveFullPullResult(3, 3, [msg("u1"), msg("u2")]);
		expect(res).not.toBeNull();
		expect(res!.messages.map((m) => m.id)).toEqual(["u1", "u2"]);
		expect(res!.promptHistory).toEqual(["msg-u2", "msg-u1"]);
	});

	it("已初始化时自愈拉取不再重建 prompt 历史", () => {
		const res = resolveFullPullResult(1, 1, [msg("u1")], { inited: true });
		expect(res!.promptHistory).toBeNull();
	});
});

describe("replaceFrom 截断语义", () => {
	const prev = [msg("a"), msg("b"), msg("c")];

	it("replaceFrom === 本地长度 → 纯追加", () => {
		const res = resolveIncomingMessagesDelta(prev, delta(3, [msg("d"), msg("e")]));
		expect(res.messages.map((m) => m.id)).toEqual(["a", "b", "c", "d", "e"]);
		expect(res.needsFullPull).toBe(false);
	});

	it("replaceFrom < 本地长度 → 截断尾部后拼接（支持就地更新与删除）", () => {
		const res = resolveIncomingMessagesDelta(prev, delta(2, [msg("b2", "assistant", "updated")]));
		expect(res.messages.length).toBe(3);
		expect(res.messages[0].id).toBe("a");
		// slice(0, replaceFrom) 保留 0..replaceFrom-1，增量消息从索引 replaceFrom 起
		expect(res.messages[2]).toMatchObject({ id: "b2", text: "updated" });
		expect(res.needsFullPull).toBe(false);
	});

	it("replaceFrom === 0 → 整体替换（即使 messages 更短）", () => {
		const res = resolveIncomingMessagesDelta(prev, delta(0, [msg("x")]));
		expect(res.messages.map((m) => m.id)).toEqual(["x"]);
		expect(res.needsFullPull).toBe(false);
	});

	it("增量合并保留 replaceFrom 之前的原数组引用（流式性能约定）", () => {
		const res = resolveIncomingMessagesDelta(prev, delta(1, [msg("d")]));
		expect(res.messages[0]).toBe(prev[0]);
	});
});

describe("失同步自愈（seq gap）", () => {
	it("replaceFrom 超出本地长度 → needsFullPull=true，且合并结果仍先过渡显示", () => {
		const prev = [msg("a")];
		const res = resolveIncomingMessagesDelta(prev, delta(3, [msg("d"), msg("e")]));
		expect(res.needsFullPull).toBe(true);
		// 本地只有 1 条，replaceFrom=3 钳制到 1，尾部拼接增量
		expect(res.messages.map((m) => m.id)).toEqual(["a", "d", "e"]);
	});

	it("本地无消息 + replaceFrom>0 → 同样触发自愈", () => {
		const res = resolveIncomingMessagesDelta(undefined, delta(1, [msg("d")]));
		expect(res.needsFullPull).toBe(true);
		expect(res.messages.map((m) => m.id)).toEqual(["d"]);
	});

	it("正常增量（replaceFrom <= 本地长度）不触发自愈", () => {
		const res = resolveIncomingMessagesDelta([msg("a")], delta(1, [msg("b")]));
		expect(res.needsFullPull).toBe(false);
	});
});

describe("prompt 历史重建耦合", () => {
	it("全量基线 + 未初始化 + 含用户消息 → 输出最新在前的历史", () => {
		const res = resolveIncomingMessagesDelta(
			[],
			delta(0, [msg("u1"), msg("u2", "assistant"), msg("u3")]),
		);
		expect(res.promptHistory).toEqual(["msg-u3", "msg-u1"]);
	});

	it("已初始化 → 跳过重建（幂等保护）", () => {
		const res = resolveIncomingMessagesDelta([], delta(0, [msg("u1")]), { inited: true });
		expect(res.promptHistory).toBeNull();
	});

	it("占位/空基线（无有效用户消息）→ 跳过且不置初始化标记", () => {
		// 仅 system/assistant 消息的加载占位基线
		const res = resolveIncomingMessagesDelta(
			[],
			delta(0, [msg("p1", "system"), msg("p2", "assistant")]),
		);
		expect(res.promptHistory).toBeNull();
	});

	it("增量 delta 即使含用户消息也不重建历史（避免不完整历史）", () => {
		const res = resolveIncomingMessagesDelta([msg("u1")], delta(1, [msg("u2")]));
		expect(res.promptHistory).toBeNull();
	});

	it("过滤：非 user 角色、空白文本、以 ! 开头的 bash 命令不进历史", () => {
		const res = resolveIncomingMessagesDelta(
			[],
			delta(0, [
				msg("u1"),
				msg("tool", "tool", "tool-result"),
				msg("blank", "user", "   "),
				msg("bang", "user", "!ls"),
				msg("u2", "user", "  keep me  "),
			]),
		);
		expect(res.promptHistory).toEqual(["keep me", "msg-u1"]);
	});

	it("与已有历史去重合并：incoming 权威在前、existing 补旧、按文本去重、限长", () => {
		const res = resolveIncomingMessagesDelta(
			[],
			delta(0, [msg("u1", "user", "new"), msg("u2", "user", "new"), msg("u3", "user", "old")]),
			{ existingHistory: ["older", " old ", "new"], limit: 3 },
		);
		// incoming 最新在前去重后为 ["old", "new"]，existing 补 "older"（"new"/"old" 已存在被去重）
		expect(res.promptHistory).toEqual(["old", "new", "older"]);
	});

	it("默认条数上限与 App 的 PROMPT_HISTORY_LIMIT 一致（100）", () => {
		const many = Array.from({ length: 120 }, (_, i) => msg(`u${i}`, "user", `prompt-${i}`));
		const res = resolveIncomingMessagesDelta([], delta(0, many));
		expect(res.promptHistory!.length).toBe(100);
	});
});

describe("空/边界输入", () => {
	it("prev 缺省为空数组：全量基线直接成为新状态", () => {
		const res = resolveIncomingMessagesDelta(undefined, delta(0, [msg("a")]));
		expect(res.messages.map((m) => m.id)).toEqual(["a"]);
		expect(res.needsFullPull).toBe(false);
	});

	it("全量基线 messages 为空 → 清空消息且不重建历史", () => {
		const res = resolveIncomingMessagesDelta([msg("a")], delta(0, []));
		expect(res.messages).toEqual([]);
		expect(res.promptHistory).toBeNull();
	});

	it("空增量（messages 为空、replaceFrom 越界）→ 自愈标记且本地不变", () => {
		const res = resolveIncomingMessagesDelta([msg("a")], delta(2, []));
		expect(res.needsFullPull).toBe(true);
		expect(res.messages).toEqual([msg("a")]);
	});
});