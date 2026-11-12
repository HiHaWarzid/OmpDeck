import { readFile } from "node:fs/promises";
import { parentPort } from "node:worker_threads";
import {
	extractSessionArchives,
	type SessionArchives,
} from "../pi/sessionArchives";

/**
 * 压缩归档解析 worker。
 *
 * 打开/重载长会话时，parseArchives 需要整文件读取 + 逐行 JSON.parse + parentId 回溯，
 * 在 35MB 级会话上足以卡住主进程事件循环。这里把整段工作搬到 worker：
 * 主线程只传路径与 agentId，回传压缩列表和归档消息（结构化克隆支持 Map）。
 * 没有 compaction 的会话由 extractSessionArchives 先做 substring 短路，连 JSON.parse 都不做。
 */

interface ArchiveParseRequest {
	id: number;
	filePath: string;
	agentId: string;
}

type ArchiveParseResponse =
	| { id: number; ok: true; archives: SessionArchives }
	| { id: number; ok: false; error: string; code?: string };

const port = parentPort;
if (!port) throw new Error("sessionArchiveWorker requires worker_threads");

port.on("message", async (request: ArchiveParseRequest) => {
	let response: ArchiveParseResponse;
	try {
		const raw = await readFile(request.filePath, "utf8");
		response = {
			id: request.id,
			ok: true,
			archives: extractSessionArchives(raw, request.agentId),
		};
	} catch (error) {
		response = {
			id: request.id,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
			// 主进程按 code 区分「文件尚未落盘（ENOENT，正常竞态）」与真实读取失败。
			code:
				error instanceof Error && "code" in error
					? String((error as NodeJS.ErrnoException).code)
					: undefined,
		};
	}
	port.postMessage(response);
});
