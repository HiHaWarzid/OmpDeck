import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AppSettings } from "../../shared/types";

/**
 * Web 服务访问令牌。
 *
 * 设计约束：
 * - 令牌只在主进程生成/校验，渲染层仅通过 settings IPC 读取本机令牌用于展示二维码。
 * - 非回环请求必须带令牌；回环请求（本机浏览器）保持免令牌，避免桌面端自身排障被挡。
 * - 校验使用 timingSafeEqual，避免通过响应时间猜测令牌。
 * - 令牌与过期时间存 settings.json，应用重启后手机端无需重新扫码。
 */

export type WebTokenSettings = Pick<
	AppSettings,
	"webServiceToken" | "webServiceTokenGeneratedAt" | "webServiceTokenExpiresAt" | "webServiceTokenTtlDays"
>;

export type WebTokenState = {
	token: string;
	generatedAt: number;
	expiresAt: number | null;
	ttlDays: number;
};

export type WebAuthFailureCode = "token_missing" | "token_invalid" | "token_expired";

const DEFAULT_TOKEN_TTL_DAYS = 30;
const MAX_TOKEN_TTL_DAYS = 3650;
const TOKEN_PREFIX = "omp_";

/** 生成新令牌：32 字节随机数，base64url 后约 43 字符，前缀便于日志识别。 */
export function generateWebToken(): string {
	return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** 归一化有效期：非法值回落默认 30 天；0 表示永不过期；上限 10 年。 */
export function normalizeTokenTtlDays(value: number | undefined): number {
	if (value === 0) return 0;
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TOKEN_TTL_DAYS;
	return Math.min(MAX_TOKEN_TTL_DAYS, Math.max(1, Math.floor(value)));
}

export function tokenExpiresAt(generatedAt: number, ttlDays: number): number | null {
	return ttlDays === 0 ? null : generatedAt + ttlDays * 24 * 60 * 60 * 1000;
}

/** 读取/补齐令牌状态；令牌缺失或已过期时自动轮换。返回 changed 供调用方落盘。 */
export function ensureWebTokenState(
	settings: WebTokenSettings,
	now: number = Date.now(),
): { state: WebTokenState; changed: boolean } {
	const ttlDays = normalizeTokenTtlDays(settings.webServiceTokenTtlDays);
	const existingToken = settings.webServiceToken?.trim() ?? "";
	const generatedAt = settings.webServiceTokenGeneratedAt ?? now;
	const expiresAt =
		settings.webServiceTokenExpiresAt === undefined
			? tokenExpiresAt(generatedAt, ttlDays)
			: settings.webServiceTokenExpiresAt;
	if (existingToken && (expiresAt === null || expiresAt > now)) {
		return {
			state: { token: existingToken, generatedAt, expiresAt, ttlDays },
			changed:
				settings.webServiceTokenGeneratedAt !== generatedAt ||
				settings.webServiceTokenExpiresAt !== expiresAt ||
				settings.webServiceTokenTtlDays !== ttlDays,
		};
	}
	const token = generateWebToken();
	return {
		state: { token, generatedAt: now, expiresAt: tokenExpiresAt(now, ttlDays), ttlDays },
		changed: true,
	};
}

/** 令牌状态 → settings patch（只在 changed 时写盘）。 */
export function webTokenPatch(state: WebTokenState): WebTokenSettings {
	return {
		webServiceToken: state.token,
		webServiceTokenGeneratedAt: state.generatedAt,
		webServiceTokenExpiresAt: state.expiresAt,
		webServiceTokenTtlDays: state.ttlDays,
	};
}

function safeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	if (leftBuffer.length !== rightBuffer.length) return false;
	return timingSafeEqual(leftBuffer, rightBuffer);
}

/** 从 Authorization: Bearer / X-Omp-Token / ?token= 提取令牌。 */
export function extractRequestToken(request: {
	headers: { authorization?: string; "x-omp-token"?: string | string[] };
	url?: string;
}): string | null {
	const authorization = request.headers.authorization?.trim();
	if (authorization) {
		const match = authorization.match(/^Bearer\s+(.+)$/i);
		if (match) return match[1].trim();
	}
	const headerToken = request.headers["x-omp-token"];
	const normalizedHeader = Array.isArray(headerToken) ? headerToken[0] : headerToken;
	if (normalizedHeader?.trim()) return normalizedHeader.trim();
	if (request.url) {
		try {
			const url = new URL(request.url, "http://localhost");
			const queryToken = url.searchParams.get("token");
			if (queryToken?.trim()) return queryToken.trim();
		} catch {
			// URL 非法时交给上层 400，不在这里抛错
		}
	}
	return null;
}

/** 校验令牌；返回 null 表示通过，否则为失败分类。 */
export function verifyWebToken(
	token: string | null,
	state: WebTokenState,
	now: number = Date.now(),
): WebAuthFailureCode | null {
	if (!token) return "token_missing";
	if (!state.token) return "token_invalid";
	if (state.expiresAt !== null && state.expiresAt <= now) return "token_expired";
	return safeEqual(token, state.token) ? null : "token_invalid";
}

/** 回环地址免令牌：127.0.0.0/8、::1、localhost（IPv4-mapped IPv6 先还原）。 */
export function isLoopbackAddress(address: string | undefined): boolean {
	const raw = address?.trim().toLowerCase() ?? "";
	const value = raw.startsWith("::ffff:") ? raw.slice("::ffff:".length) : raw;
	return value === "::1" || value === "localhost" || value.startsWith("127.");
}
