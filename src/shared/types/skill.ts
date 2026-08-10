import type { PromptStoreItem } from "./prompt";

// ── Skill Store ────────────────────────────────────────────────────────

/** 从 prompts.chat 通过 get_skill 获取的 skill 详情 */
export interface SkillStoreDetail {
	id: string;
	title: string;
	description: string;
	files: Array<{ filename: string; content: string }>;
}

export interface SkillStoreSearchResult {
	query: string;
	count: number;
	items: PromptStoreItem[];
}

// ── SkillHub（api.skillhub.cn） ─────────────────────────────────────

/** SkillHub 搜索结果中的单个 skill 条目 */
export interface SkillHubItem {
	slug: string;
	name: string;
	description: string;
	description_zh?: string;
	iconUrl?: string;
	stars: number;
	downloads: number;
	installs: number;
	category: string;
	subCategories?: Array<{ key: string; name: string }>;
	version: string;
	ownerName: string;
	namespace?: {
		canonicalName: string;
		displayName: string;
		publicSlug: string;
	};
	labels?: Record<string, string>;
	tags?: Record<string, string>;
	source?: string;
	verified?: boolean;
	updatedAt?: number;
	/** 在 skillhub 网站上的详情页 URL，点击卡片时直接跳转 */
	homepage?: string;
}

/** SkillHub skill 详情（含版本信息） */
export interface SkillHubDetail {
	skill: {
		slug: string;
		displayName: string;
		summary: string;
		summary_zh?: string;
		iconUrl?: string;
		stats: {
			comments: number;
			downloads: number;
			installs: number;
			stars: number;
			versions: number;
		};
		category: string;
		subCategories?: Array<{ key: string; name: string }>;
		labels?: Record<string, string>;
		createdAt: number;
		updatedAt: number;
		source?: string;
		verified?: boolean;
	};
	latestVersion: {
		version: string;
		changelog?: string;
		createdAt: number;
	};
	owner: {
		displayName: string;
		handle: string;
		image?: string | null;
	};
	namespace: {
		canonicalName: string;
		displayName: string;
		handle: string;
		publicSlug: string;
	};
	securityReports?: {
		[key: string]: {
			status: string;
			statusText: string;
			reportUrl?: string;
		};
	};
}

/** SkillHub 搜索结果整体 */
export interface SkillHubSearchResult {
	query: string;
	total: number;
	items: SkillHubItem[];
}

/** SkillHub 安装结果 */
export interface SkillHubInstallResult {
	success: boolean;
	slug: string;
	installDir: string;
	message?: string;
	error?: string;
}
