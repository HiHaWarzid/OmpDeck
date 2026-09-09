import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	findNearestTrustEntry,
	normalizeTrustPathKey,
	TrustStore,
} from "./TrustStore";

let dir: string;

/** 用户全局 skills 排除位的真实路径（realpath：%TEMP% 常为 8.3 短名，须归一化
 *  到长名才能与祖先链上的真实 home 对齐，避免把用户全局 skills 误判为项目级）。 */
function homeSkillsDir(): string {
	return join(realpathSync(homedir()), ".agents", "skills");
}

beforeEach(async () => {
	const { realpath } = await import("node:fs/promises");
	dir = await realpath(await mkdtemp(join(tmpdir(), "trust-store-")));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function createStore() {
	return new TrustStore({ resolveConfigDir: () => dir });
}

async function writeTrust(entries: Record<string, boolean>) {
	await writeFile(join(dir, "trust.json"), JSON.stringify(entries), "utf8");
}

describe("trust key normalization", () => {
	it("normalizes separators and trailing slashes on win32-style keys", () => {
		expect(normalizeTrustPathKey("C:\\Users\\tester\\")).toBe("c:\\users\\tester");
	});

	it("keeps posix keys case-sensitive", () => {
		expect(normalizeTrustPathKey("/root/Proj/")).toBe("/root/Proj");
		expect(normalizeTrustPathKey("/root/proj")).toBe("/root/proj");
		expect(normalizeTrustPathKey("/root/Proj") !== normalizeTrustPathKey("/root/proj")).toBe(true);
	});

	it("parent-chain lookup inherits ancestor decisions", () => {
		const data = { "C:\\Users": true };
		expect(findNearestTrustEntry(data, "C:\\Users\\tester\\project")).toBe(true);
		expect(findNearestTrustEntry(data, "D:\\other")).toBe(null);
	});

	it("matches win32 keys case-insensitively across the chain", () => {
		const data = { "c:\\users\\tester": true };
		expect(findNearestTrustEntry(data, "C:\\Users\\TESTER\\proj")).toBe(true);
	});
});

describe("TrustStore storage semantics", () => {
	it("ensureTrustedDirectory writes only when no equivalent record exists", async () => {
		const store = createStore();
		await store.ensureTrustedDirectory("C:\\Work\\proj");
		expect(existsSync(join(dir, "trust.json"))).toBe(true);

		// 已有显式 false（不同大小写）→ 不覆盖，尊重用户决策
		await writeTrust({ "c:\\work\\proj": false });
		await store.ensureTrustedDirectory("C:\\WORK\\Proj");
		const { entries } = await store.readTrust();
		expect(entries["c:\\work\\proj"]).toBe(false);
	});

	it("setDecision persists and is idempotent on same value", async () => {
		const store = createStore();
		await store.setDecision("C:\\Work\\proj", true);
		expect(await store.getDecision("C:\\Work\\proj")).toBe(true);
		await store.setDecision("C:\\Work\\proj", true); // 同值不重写
		expect(await store.getDecision("C:\\Work\\proj\\sub")).toBe(true); // 子目录继承
	});
});

describe("resource probe", () => {
	it("flags .omp resources and nested .agents/skills, skipping the user-global one", async () => {
		const store = createStore();
		const host = join(dir, "host");
		// 排除位用真实用户 home 的全局 skills（realpath 归一，避免 8.3 短名误判）
		const globalSkills = homeSkillsDir();
		expect(store.hasRequiringResources(join(host, "clean"), globalSkills)).toBe(false);

		await mkdir(join(host, "omp-res", ".omp"), { recursive: true });
		await writeFile(join(host, "omp-res", ".omp", "settings.json"), "{}");
		expect(store.hasRequiringResources(join(host, "omp-res"), globalSkills)).toBe(true);

		await mkdir(join(host, "agents-skills"), { recursive: true });
		await mkdir(join(host, "agents-skills", ".agents", "skills"), { recursive: true });
		expect(store.hasRequiringResources(join(host, "agents-skills"), globalSkills)).toBe(true);
	});
});

describe("decide matrix", () => {
	it("clean project auto-trusts without asking", async () => {
		const store = createStore();
		const ask = vi.fn();
		const result = await store.decide({
			cwd: "C:\\Work\\clean",
			hostCwd: join(dir, "clean"),
			projectName: "clean",
			ask,
		});
		expect(result).toBeUndefined();
		expect(ask).not.toHaveBeenCalled();
		expect(await store.getDecision("C:\\Work\\clean")).toBe(true);
	});

	it("resource-bearing + trusted → allow without asking", async () => {
		const hostCwd = join(dir, "res");
		await mkdir(join(hostCwd, ".omp"), { recursive: true });
		await writeFile(join(hostCwd, ".omp", "skills"), "{}");
		await writeTrust({ "C:\\Work\\res": true });
		const ask = vi.fn();
		const result = await createStore().decide({
			cwd: "C:\\Work\\res",
			hostCwd,
			projectName: "res",
			ask,
		});
		expect(result).toBeUndefined();
		expect(ask).not.toHaveBeenCalled();
	});

	it("explicit false in trust.json still asks (never silently denies)", async () => {
		const hostCwd = join(dir, "res");
		await mkdir(join(hostCwd, ".omp"), { recursive: true });
		await writeFile(join(hostCwd, ".omp", "skills"), "{}");
		await writeTrust({ "C:\\Work\\res": false });
		const ask = vi.fn().mockResolvedValue("deny");
		const result = await createStore().decide({
			cwd: "C:\\Work\\res",
			hostCwd,
			projectName: "res",
			ask,
		});
		expect(result).toBe("no-approve");
		// false 不落盘覆盖——下次仍可重新决策
		const { entries } = await createStore().readTrust();
		expect(entries["C:\\Work\\res"]).toBe(false);
	});

	it("trust-remember persists true; trust-session approves without persisting", async () => {
		const hostCwd = join(dir, "res");
		await mkdir(join(hostCwd, ".omp"), { recursive: true });
		await writeFile(join(hostCwd, ".omp", "skills"), "{}");

		const remember = await createStore().decide({
			cwd: "C:\\Work\\res",
			hostCwd,
			projectName: "res",
			ask: vi.fn().mockResolvedValue("trust-remember"),
		});
		expect(remember).toBeUndefined();
		expect(await createStore().getDecision("C:\\Work\\res")).toBe(true);

		await writeTrust({}); // 重置
		const session = await createStore().decide({
			cwd: "C:\\Work\\res",
			hostCwd,
			projectName: "res",
			ask: vi.fn().mockResolvedValue("trust-session"),
		});
		expect(session).toBe("approve");
		expect(await createStore().getDecision("C:\\Work\\res")).toBe(null);
	});
});
