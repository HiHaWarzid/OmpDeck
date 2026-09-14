import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import type { ChatMessage } from "../../shared/types";

// SessionScanner/SessionFileOps 在模块顶层引入 electron（app.getPath / shell.trashItem）；
// vitest 的 node 环境没有 electron 运行时，用最小桩把路径指到本测试的临时 home。
const electronState = vi.hoisted(() => ({ home: "", userData: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "home" ? electronState.home : electronState.userData),
  },
  shell: { trashItem: async () => {} },
}));

import { LocalFileAdapter } from "../fs/adapters/localFileAdapter";
import { SessionJsonl } from "../pi/sessionJsonl";
import { SessionFileOps } from "./SessionFileOps";
import { SessionScanner } from "./SessionScanner";
import {
  nodeEntriesIo,
  readEntries,
  readTailEntries,
  type SessionEntriesIo,
  type SessionTailEntriesIo,
} from "./sessionEntries";

/** 带 UTF-8 BOM 的会话条目：BOM 会让首行 JSON.parse 失败，三条读取路径都必须先剥离。 */
const BOM_ENTRIES: unknown[] = [
  { type: "session", id: "aaa00001", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", cwd: "D:\\proj" },
  { type: "session_info", id: "aaa00002", parentId: "aaa00001", timestamp: "2026-01-01T00:00:00.500Z", name: "BOM 会话" },
  { type: "model_change", id: "aaa00003", parentId: "aaa00002", timestamp: "2026-01-01T00:00:00.700Z", provider: "anthropic", modelId: "claude-sonnet" },
  { type: "message", id: "aaa00004", parentId: "aaa00003", ts: 1767225600000, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello bom" } },
];

const BOM_RAW = `\uFEFF${BOM_ENTRIES.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

const tempDirs: string[] = [];

/** 每个用例独立的临时 home：SessionScanner 的会话根在构造时由 app.getPath("home") 解析。 */
async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "sessionEntries-"));
  tempDirs.push(home);
  electronState.home = home;
  return home;
}

/** 会话文件的标准布局：<home>/.omp/agent/sessions/<encoded-cwd>/session.jsonl */
async function writeSessionFile(home: string, name: string, content: string | Buffer): Promise<string> {
  const filePath = join(home, ".omp", "agent", "sessions", "--D--proj--", name);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return filePath;
}

function makeFileOps(home: string): SessionFileOps {
  return new SessionFileOps({
    getAdapter: () => new LocalFileAdapter(),
    localSessionsRoot: join(home, ".omp", "agent", "sessions"),
    getDefaultSessionsRoot: () => join(home, ".omp", "agent", "sessions"),
  });
}

function makeSessionJsonl(entriesIo?: SessionTailEntriesIo): SessionJsonl {
  return new SessionJsonl({ resolveHostPath: (path) => path, entriesIo });
}

/** 计字节读端口：read 记整文件，readRange 记请求窗口，用于证明尾窗读不整文件读。 */
function createCountingIo(): { io: SessionTailEntriesIo; bytesRead: () => number } {
  let bytesRead = 0;
  const io: SessionTailEntriesIo = {
    read: async (path) => {
      const text = await nodeEntriesIo.read(path);
      bytesRead += Buffer.byteLength(text, "utf8");
      return text;
    },
    readHead: async (path, maxBytes) => {
      bytesRead += maxBytes;
      return nodeEntriesIo.readHead(path, maxBytes);
    },
    stat: nodeEntriesIo.stat,
    readRange: async (path, start, length) => {
      bytesRead += length;
      return nodeEntriesIo.readRange(path, start, length);
    },
  };
  return { io, bytesRead: () => bytesRead };
}

beforeAll(async () => {
  electronState.userData = await mkdtemp(join(tmpdir(), "sessionEntries-userdata-"));
  tempDirs.push(electronState.userData);
});

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

// ── 编码守卫：三条路径必须一致 ──────────────────────────

test("带 BOM 的会话文件在扫描/文件操作/sessionJsonl 三条路径上读到相同内容", async () => {
  const home = await createHome();
  const sessionPath = await writeSessionFile(home, "session.jsonl", BOM_RAW);
  const fileOps = makeFileOps(home);

  // 1) SessionScanner（列表摘要走读取→解码→解析管线）
  const summaries = await new SessionScanner().list();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].name, "BOM 会话");
  assert.equal(summaries[0].preview, "hello bom");
  assert.equal(summaries[0].messageCount, 1);

  // 2) SessionFileOps（消息/元数据）
  assert.deepEqual(await fileOps.readMessages(sessionPath), [
    { role: "user", content: "hello bom", timestamp: 1767225600000 },
  ]);
  assert.deepEqual(await fileOps.readSessionMeta(sessionPath), {
    provider: "anthropic",
    modelId: "claude-sonnet",
    thinkingLevel: undefined,
  });

  // 3) SessionJsonl（查看器时间线）
  const messages = await makeSessionJsonl().readDisplayMessages(sessionPath, "_viewer");
  assert.deepEqual(messages.map((message: ChatMessage) => message.text), ["hello bom"]);

  // 三条路径看到的是同一条用户消息文本
  assert.equal(summaries[0].preview, (await fileOps.readMessages(sessionPath))[0].content);
});

test("UTF-16 会话文件在三条路径上一致判定为不可读", async () => {
  const home = await createHome();
  // UTF-16LE 按 utf8 解码后满是 NUL：不是合法 JSONL，必须三处一致地隐藏/返回空，
  // 而不是某一条路径解析出乱码行、另一条路径显示成空会话。
  const sessionPath = await writeSessionFile(home, "session.jsonl", Buffer.from(BOM_RAW, "utf16le"));
  const fileOps = makeFileOps(home);

  expect(await new SessionScanner().list()).toEqual([]);
  expect(await fileOps.readMessages(sessionPath)).toEqual([]);
  expect(await fileOps.readSessionMeta(sessionPath)).toEqual({
    provider: undefined,
    modelId: undefined,
    thinkingLevel: undefined,
  });
  expect(await makeSessionJsonl().readDisplayMessages(sessionPath, "_viewer")).toEqual([]);
});

// ── 字节预算与截断 ─────────────────────────────────────

test("超过字节预算时只读头部并截断到完整行", async () => {
  const home = await createHome();
  const lines = Array.from({ length: 40 }, (_unused, index) =>
    JSON.stringify({
      id: `e${index}`,
      type: "message",
      message: { role: "user", content: `msg-${index}-${"x".repeat(60)}` },
    }),
  );
  const raw = `${lines.join("\n")}\n`;
  const filePath = await writeSessionFile(home, "truncate.jsonl", raw);

  const budget = 400;
  const truncated = await readEntries(nodeEntriesIo, filePath, { maxBytes: budget });
  assert.equal(truncated.truncated, true);
  assert.ok(truncated.raw.length > 0);
  // 截断发生在行边界：raw 以换行收尾，且每个保留行都能独立解析（没有半个 JSON entry）。
  assert.equal(truncated.raw.endsWith("\n"), true);
  const keptLines = truncated.raw.split("\n").filter(Boolean);
  assert.equal(keptLines.length, truncated.entries.length);
  assert.ok(keptLines.length < lines.length);
  assert.ok(keptLines.every((line) => typeof JSON.parse(line) === "object"));
  assert.ok(keptLines.every((line, index) => line === lines[index]));

  // 预算足够时原样返回整份内容
  const whole = await readEntries(nodeEntriesIo, filePath, { maxBytes: raw.length + 1 });
  assert.equal(whole.truncated, false);
  assert.equal(whole.entries.length, lines.length);
});

// ── 指纹失效 ───────────────────────────────────────────

test("文件被外部修改后重读拿到新内容与新指纹", async () => {
  const home = await createHome();
  const filePath = await writeSessionFile(
    home,
    "fingerprint.jsonl",
    `${JSON.stringify({ id: "a", type: "message", message: { role: "user", content: "first" } })}\n`,
  );

  const first = await readEntries(nodeEntriesIo, filePath);
  assert.equal(first.entries.length, 1);
  assert.equal(first.truncated, false);
  // 未变化时指纹逐字段一致：调用方（扫描摘要/归档缓存）据此命中缓存
  assert.deepEqual((await readEntries(nodeEntriesIo, filePath)).fingerprint, first.fingerprint);

  // 外部进程追加一行（模拟 pi 在应用之外继续写会话文件）
  await appendFile(
    filePath,
    `${JSON.stringify({ id: "b", type: "message", message: { role: "user", content: "second" } })}\n`,
  );

  const second = await readEntries(nodeEntriesIo, filePath);
  assert.equal(second.entries.length, 2);
  assert.ok(second.raw.includes("second"));
  // 指纹是调用方缓存的失效键：内容变了，size（或 mtimeMs）必然不同，缓存因此失效
  assert.notDeepEqual(second.fingerprint, first.fingerprint);
  assert.ok(second.fingerprint.size > first.fingerprint.size);
});

test("扫描摘要缓存随指纹失效：外部改写后列表拿到新标题", async () => {
  const home = await createHome();
  const filePath = await writeSessionFile(
    home,
    "session.jsonl",
    `${JSON.stringify({ type: "session_info", id: "s1", name: "第一版" })}\n`,
  );
  const scanner = new SessionScanner();
  assert.equal((await scanner.list())[0].name, "第一版");

  // 改写为更长的内容：size 变化 ⇒ 指纹变化 ⇒ 摘要缓存不得复用
  await writeFile(
    filePath,
    `${JSON.stringify({ type: "session_info", id: "s1", name: "第二版标题更长" })}\n`,
  );
  assert.equal((await scanner.list())[0].name, "第二版标题更长");
});

// ── 尾窗读不整文件读 ───────────────────────────────────

test("尾窗读只读窗口字节，不整文件读", async () => {
  const home = await createHome();
  const lineCount = 10_000;
  const lines = Array.from({ length: lineCount }, (_unused, index) => {
    const role = index % 2 === 0 ? "user" : "assistant";
    const text = index === lineCount - 1 ? "final-answer" : `line-${index}-${"y".repeat(140)}`;
    return JSON.stringify({ id: `m${index}`, type: "message", message: { role, content: [{ type: "text", text }] } });
  });
  const raw = `${lines.join("\n")}\n`;
  const filePath = await writeSessionFile(home, "large.jsonl", raw);
  const size = (await stat(filePath)).size;
  assert.ok(size > 1024 * 1024, "夹具必须大于尾窗初始窗口，否则证明不了不整读");

  // 模块级：maxBytes 收紧到 128KB，只读窗口，且截断标记为真
  const limited = createCountingIo();
  const tail = await readTailEntries(limited.io, filePath, { minLines: 5, maxBytes: 128 * 1024 });
  assert.equal(tail.truncated, true);
  assert.ok(tail.entries.length >= 5);
  assert.ok(limited.bytesRead() <= 128 * 1024);
  assert.ok(limited.bytesRead() < size);
  assert.ok(tail.raw.includes("final-answer"));

  // sessionJsonl 的尾窗家族共用同一端口：注入计字节 io 后同样不全读
  const counted = createCountingIo();
  const response = await makeSessionJsonl(counted.io).readRecentMessages(filePath, 30);
  const recent = (response.data as { messages?: Array<{ content: Array<{ text: string }> }> }).messages ?? [];
  assert.ok(recent.length > 0);
  assert.equal(recent[recent.length - 1].content[0].text, "final-answer");
  assert.ok(counted.bytesRead() < size, `尾窗读取了 ${counted.bytesRead()} 字节，整文件是 ${size} 字节`);

  // 对照：读端口若退化成整文件 read，字节数会等于文件大小
  const whole = createCountingIo();
  await readEntries(whole.io as SessionEntriesIo, filePath);
  assert.equal(whole.bytesRead(), size);
});
