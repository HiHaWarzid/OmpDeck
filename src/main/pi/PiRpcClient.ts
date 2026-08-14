import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export type RpcResponse = {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

type PendingRequest = {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class PiRpcClient extends EventEmitter {
	/**
	 * 未完成行缓冲：分块数组 + 长度计数。
	 * 流式 chunk 通常含换行，直接 join 处理；超大单行 JSON（get_messages 对大会话
	 * 返回单行响应）跨多个 chunk 到达时只 push 不拼接，避免每次 chunk 都复制
	 * 整个累积 buffer（旧实现 `buffer += chunk` 是 O(n²) 复制，5MB 行约数百次
	 * 累积拷贝）。含换行的 chunk 到来时才 join 一次完整处理。
	 */
	private bufferParts: string[] = [];
	private bufferLength = 0;
	private readonly decoder = new StringDecoder("utf8");
	private readonly pending = new Map<string, PendingRequest>();

	constructor(
		private readonly stdin: NodeJS.WritableStream,
		stdout: NodeJS.ReadableStream,
	) {
		super();
		stdout.on("data", chunk => this.consumeChunk(chunk));
		stdout.on("end", () => this.consumeEnd());
	}

	request(command: Record<string, unknown>, timeoutMs = 30_000): Promise<RpcResponse> {
		const id = String(command.id ?? randomUUID());
		const payload = { ...command, id };

		const promise = new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				// 错误文本带超时时长，方便 toast/诊断卡直接看出是等待过久而非连接断开
				reject(new Error(`RPC command timed out after ${timeoutMs}ms: ${String(command.type)}`));
			}, timeoutMs);

			this.pending.set(id, { resolve, reject, timer });
		});

		this.write(payload);
		return promise;
	}

	notify(command: Record<string, unknown>) {
		this.write(command);
	}

	/** 直接向 pi 的 stdin 写入原始 JSONL，不经过 pending 跟踪（用于 extension_ui_response 等消息） */
	sendRaw(payload: Record<string, unknown>) {
		this.stdin.write(`${JSON.stringify(payload)}\n`);
	}

	close(error?: Error) {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error ?? new Error(`RPC client closed before response: ${id}`));
		}
		this.pending.clear();
		this.bufferParts = [];
		this.bufferLength = 0;
	}

	private write(payload: Record<string, unknown>) {
		// 记录发出的 RPC 命令，方便调试
		this.emit("log", { direction: "send", data: payload });
		// pi RPC 使用严格 JSONL 协议；每条命令必须以 LF 结尾，不能依赖 readline 之类的宽松分行。
		this.stdin.write(`${JSON.stringify(payload)}\n`);
	}

	private consumeChunk(chunk: Buffer | string) {
		const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		this.bufferParts.push(text);
		this.bufferLength += text.length;
		// 防御：无换行的垃圾流也要能被 drain（协议行有上限，正常情况下不会走到）
		if (text.includes("\n") || this.bufferLength > 32 * 1024 * 1024) {
			this.drainLines();
		}
	}

	private consumeEnd() {
		this.bufferParts.push(this.decoder.end());
		this.drainLines(true);
	}

	private drainLines(includePartialLine = false) {
		// join 只在含换行的 chunk 到达（或流结束）时发生；无换行的大单行累积期间
		// 只 push 字符串，总复制量 O(n) 而不是逐 chunk 的 O(n²)。
		const all = this.bufferParts.join("");
		this.bufferParts = [];
		this.bufferLength = 0;
		let start = 0;
		while (true) {
			const newlineIndex = all.indexOf("\n", start);
			if (newlineIndex === -1) break;
			let line = all.slice(start, newlineIndex);
			start = newlineIndex + 1;
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.handleLine(line);
		}
		const remainder = all.slice(start);
		if (remainder.length > 0) {
			if (includePartialLine) {
				// 流结束：末尾无换行的残行也要处理（与旧 consumeEnd 行为一致）
				this.handleLine(remainder.endsWith("\r") ? remainder.slice(0, -1) : remainder);
			} else {
				this.bufferParts = [remainder];
				this.bufferLength = remainder.length;
			}
		}
	}

	private handleLine(line: string) {
		if (!line.trim()) return;

		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			// stdout 被非 JSON 内容污染时保留原文，方便用户排查 PATH、pi 版本或启动脚本问题。
			this.emit("protocol-error", line);
			return;
		}

		// 记录收到的 RPC 消息，方便调试
		this.emit("log", { direction: "recv", data: message });

		if (this.isResponse(message) && message.id && this.pending.has(message.id)) {
			const pending = this.pending.get(message.id)!;
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
			pending.resolve(message);
			return;
		}

		this.emit("event", message);
	}

	private isResponse(value: unknown): value is RpcResponse {
		return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "response");
	}
}
