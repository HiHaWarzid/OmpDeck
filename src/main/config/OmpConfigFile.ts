import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { isMap, parseDocument, type Document } from "yaml";
import type { ConfigFileReadResult, OmpConfigPatch } from "../../shared/types";
import { JsonFileStore } from "../storage/JsonFileStore";
import type { ConfigValidationResult } from "./ConfigManager";

/**
 * OmpConfigFile -- omp 全局设置权威源 config.yml 的通用读写（原文 + 点路径补丁）。
 *
 * 领域语义（见 docs/research/omp-feature-coverage.md P0-3）：
 * - omp 18 只把 config.yml/config.yaml 当全局 settings 权威源；settings.json 仅在
 *   config.yml 缺失时被一次性迁移，之后不再读取。因此任何「设置页保存」都必须落
 *   config.yml，否则用户改了也不生效。
 * - 键是 schema 里注册的扁平/嵌套键（`omp config list --json` 为唯一事实源）：
 *   retry.maxRetries、compaction.keepRecentTokens、enabledModels ...
 *
 * 不变式：
 * 1. 一次补丁 = 一次 parse-mutate-write（JsonFileStore 按路径串行，外部并发写不丢键）；
 * 2. YAML round-trip 保留注释与 schema 外其它键（模型角色等由 OmpRolesStore 写，
 *    两者共享同一路径队列，不会互相覆盖）；
 * 3. 文件名由 resolveOmpConfigFileName 决定：已存在的 config.yml 优先，其次
 *    config.yaml，都不存在则新建 config.yml（与 OmpRolesStore 共用同一函数）；
 * 4. 永不抛错：形状/解析/写盘失败都以 {valid:false} 返回，且不落盘覆盖；
 * 5. 空文件 = 空映射（合法），顶层非映射（数组/标量）视为损坏。
 */

/**
 * 实际生效的 YAML 文件名。
 *
 * omp 的规范写入目标是 config.yml；已存在的 config.yaml 作为兼容文件名被就地更新。
 * 两者同时存在时 omp 实测读 config.yml（`omp config get` 返回 config.yml 的值），
 * 所以这里必须同序优先 config.yml——否则会出现「读一个文件、写另一个文件」，
 * 用户在设置页改的值永远不生效。
 */
export function resolveOmpConfigFileName(configDir: string): "config.yaml" | "config.yml" {
	if (existsSync(join(configDir, "config.yml"))) return "config.yml";
	if (existsSync(join(configDir, "config.yaml"))) return "config.yaml";
	return "config.yml";
}

function isMapping(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 点路径 → 键数组；空路径直接拒绝（避免把整份文档替换掉）。 */
function splitPath(path: string): string[] {
	const keys = path
		.split(".")
		.map((key) => key.trim())
		.filter(Boolean);
	if (keys.length === 0) throw new Error(`非法的配置键路径：${path}`);
	return keys;
}

/**
 * 删除后清理空的父节点：unset("retry.maxRetries") 不应残留 `retry: {}`。
 * 只向上清理到根之前的层级，不删除用户其它键。
 */
function pruneEmptyAncestors(doc: Document, keys: string[]): void {
	for (let depth = keys.length - 1; depth >= 1; depth--) {
		const parent = doc.getIn(keys.slice(0, depth), true);
		if (isMap(parent) && parent.items.length === 0) {
			doc.deleteIn(keys.slice(0, depth));
		}
	}
}

/** 解析并校验 YAML 原文 → 映射；失败返回错误信息（不抛错）。 */
function parseMapping(raw: string): { mapping: Record<string, unknown> } | { error: string } {
	const doc = parseDocument(raw, { prettyErrors: false });
	// parseDocument 对损坏输入不抛异常，错误收集在 doc.errors；toJS() 才可能恢复出半边内容。
	// 配置写入宁可拒绝也不要基于残缺文档改写（会把丢失的键静默固化）。
	if (doc.errors.length > 0) {
		return { error: `YAML 格式错误：${doc.errors[0].message}` };
	}
	const value: unknown = doc.toJS();
	if (value === null || value === undefined) return { mapping: {} };
	if (!isMapping(value)) return { error: "config.yml 顶层必须是映射（key: value）" };
	return { mapping: value };
}

export interface OmpConfigFileDeps {
	resolveConfigDir: () => string;
}

export class OmpConfigFile {
	private readonly deps: OmpConfigFileDeps;
	private readonly files = new Map<string, JsonFileStore<string>>();

	constructor(deps: OmpConfigFileDeps) {
		this.deps = deps;
	}

	/** 当前生效的 config.yml/config.yaml 绝对路径（WSL 切换时随 configDir 变化）。 */
	filePath(): string {
		const configDir = this.deps.resolveConfigDir();
		return join(configDir, resolveOmpConfigFileName(configDir));
	}

	private store(filePath: string): JsonFileStore<string> {
		const existing = this.files.get(filePath);
		if (existing) return existing;
		const created = JsonFileStore.text(filePath);
		this.files.set(filePath, created);
		return created;
	}

	/** 读取原文 + 解析后的映射；文件缺失按空配置，损坏时 parsed 为空并带 diagnostic。 */
	async read(): Promise<ConfigFileReadResult<Record<string, unknown>>> {
		const filePath = this.filePath();
		let raw: string;
		try {
			raw = (await this.store(filePath).readRaw()) ?? "";
		} catch (error) {
			return {
				raw: "",
				parsed: {},
				diagnostic: {
					fileName: basename(filePath),
					message: error instanceof Error ? error.message : String(error),
					docsUrl: "https://pi.dev/docs/latest/settings",
				},
			};
		}
		if (!raw.trim()) return { raw, parsed: {} };
		const parsed = parseMapping(raw);
		if ("error" in parsed) {
			return {
				raw,
				parsed: {},
				diagnostic: {
					fileName: basename(filePath),
					message: parsed.error,
					docsUrl: "https://pi.dev/docs/latest/settings",
				},
			};
		}
		return { raw, parsed: parsed.mapping };
	}

	/** 原样保存（源文件编辑器）；先校验 YAML 映射，损坏内容不落盘。 */
	async writeRaw(raw: string): Promise<ConfigValidationResult> {
		if (raw.trim()) {
			const parsed = parseMapping(raw);
			if ("error" in parsed) return { valid: false, error: parsed.error };
		}
		try {
			await this.store(this.filePath()).write(raw);
			return { valid: true };
		} catch (error) {
			return {
				valid: false,
				error: `config.yml 写入失败：${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	/**
	 * 点路径补丁：set 逐键写入，unset 逐键删除（value === undefined 等价于 unset）。
	 * 基于最新磁盘内容做一次文档变更，保留注释与未触及的键。
	 */
	async patch(patch: OmpConfigPatch): Promise<ConfigValidationResult> {
		const set = patch.set ?? [];
		const unset = patch.unset ?? [];
		if (set.length === 0 && unset.length === 0) return { valid: true };
		try {
			await this.store(this.filePath()).update((current) => {
				const doc = parseDocument(current ?? "", { prettyErrors: false });
				if (doc.errors.length > 0) {
					throw new Error(`现有 config.yml 无法解析，已中止写入：${doc.errors[0].message}`);
				}
				const root: unknown = doc.toJS();
				if (root !== null && root !== undefined && !isMapping(root)) {
					throw new Error("config.yml 顶层必须是映射（key: value）");
				}
				for (const entry of set) {
					const keys = splitPath(entry.path);
					if (entry.value === undefined) {
						doc.deleteIn(keys);
						pruneEmptyAncestors(doc, keys);
					} else {
						doc.setIn(keys, entry.value);
					}
				}
				for (const path of unset) {
					const keys = splitPath(path);
					doc.deleteIn(keys);
					pruneEmptyAncestors(doc, keys);
				}
				return doc.toString();
			});
			return { valid: true };
		} catch (error) {
			return {
				valid: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
}
