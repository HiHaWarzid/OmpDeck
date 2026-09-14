import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectStore } from "./ProjectStore";

// electron mock：ProjectStore 的路径在实例构造时求值，故 userData 用可变持有者，
// 每个用例切到独立临时目录（与被测类同模块加载，工厂先于普通 const 执行 → vi.hoisted）。
const electronState = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
	app: {
		getPath: () => electronState.userData,
	},
	dialog: {
		showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
	},
}));

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "project-store-"));
	electronState.userData = dir;
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function tmpLeftovers(): Promise<string[]> {
	const names = await readdir(dir);
	return names.filter((name) => name.endsWith(".tmp"));
}

describe("ProjectStore chat-path.json 持久化", () => {
	it("setChatProjectPath 后新实例可读回自定义目录（紧凑 JSON 格式不变）", async () => {
		const store = new ProjectStore();
		await store.load();
		const target = join(dir, "custom-chat");
		await store.setChatProjectPath(target);

		// 落盘仍是紧凑 JSON（无缩进/换行），形状保持 { path }
		const raw = await readFile(join(dir, "chat-path.json"), "utf8");
		expect(raw).toBe(JSON.stringify({ path: store.getChatProjectPath() }));

		// 新实例（无缓存）走 load() 的读回路径
		const reloaded = new ProjectStore();
		await reloaded.load();
		expect(reloaded.getChatProjectPath()).toBe(store.getChatProjectPath());
	});

	it("损坏的 chat-path.json 回落默认目录，不抛错", async () => {
		await writeFile(join(dir, "chat-path.json"), "{ 半个 JSON", "utf8");
		const store = new ProjectStore();
		await store.load();
		expect(store.getChatProjectPath()).toBe(join(dir, "chat-workspace"));
	});

	it("并发切换聊天目录：落盘始终是可解析的一份完整 JSON，且不留 tmp", async () => {
		const store = new ProjectStore();
		await store.load();
		const first = join(dir, "chat-a");
		const second = join(dir, "chat-b");
		await Promise.all([
			store.setChatProjectPath(first),
			store.setChatProjectPath(second),
		]);

		const raw = await readFile(join(dir, "chat-path.json"), "utf8");
		const parsed: unknown = JSON.parse(raw);
		expect(Object.keys(parsed as Record<string, unknown>)).toEqual(["path"]);
		expect([first, second]).toContain((parsed as { path: string }).path);
		// projects.json 同样原子落盘（两次 save 串行）
		const projects: unknown = JSON.parse(await readFile(join(dir, "projects.json"), "utf8"));
		expect(Array.isArray(projects)).toBe(true);
		expect(await tmpLeftovers()).toEqual([]);
	});
});
