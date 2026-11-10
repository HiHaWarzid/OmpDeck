import { describe, expect, test } from "vitest";
import {
	ensureWebTokenState,
	extractRequestToken,
	generateWebToken,
	isLoopbackAddress,
	normalizeTokenTtlDays,
	tokenExpiresAt,
	verifyWebToken,
} from "./WebTokenAuth";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe("web token auth", () => {
	test("generateWebToken has prefix and enough entropy", () => {
		const token = generateWebToken();
		expect(token.startsWith("omp_")).toBe(true);
		expect(token.length).toBeGreaterThan(40);
		expect(generateWebToken()).not.toBe(token);
	});

	test("normalizeTokenTtlDays clamps invalid and zero", () => {
		expect(normalizeTokenTtlDays(undefined)).toBe(30);
		expect(normalizeTokenTtlDays(0)).toBe(0);
		expect(normalizeTokenTtlDays(-5)).toBe(1);
		expect(normalizeTokenTtlDays(1.9)).toBe(1);
		expect(normalizeTokenTtlDays(99_999)).toBe(3650);
	});

	test("tokenExpiresAt treats zero as never", () => {
		expect(tokenExpiresAt(NOW, 0)).toBeNull();
		expect(tokenExpiresAt(NOW, 7)).toBe(NOW + 7 * DAY);
	});

	test("ensureWebTokenState reuses a valid token and generates when expired", () => {
		const valid = ensureWebTokenState(
			{
				webServiceToken: "omp_existing",
				webServiceTokenGeneratedAt: NOW,
				webServiceTokenExpiresAt: NOW + DAY,
				webServiceTokenTtlDays: 7,
			},
			NOW,
		);
		expect(valid.state.token).toBe("omp_existing");
		expect(valid.changed).toBe(false);

		const expired = ensureWebTokenState(
			{
				webServiceToken: "omp_expired",
				webServiceTokenGeneratedAt: NOW - 2 * DAY,
				webServiceTokenExpiresAt: NOW - DAY,
				webServiceTokenTtlDays: 1,
			},
			NOW,
		);
		expect(expired.changed).toBe(true);
		expect(expired.state.token).not.toBe("omp_expired");
		expect(expired.state.expiresAt).toBe(NOW + DAY);
	});

	test("extractRequestToken accepts bearer, custom header and query", () => {
		expect(
			extractRequestToken({ headers: { authorization: "Bearer omp_a" }, url: "/api/state" }),
		).toBe("omp_a");
		expect(
			extractRequestToken({ headers: { "x-omp-token": "omp_b" }, url: "/api/state" }),
		).toBe("omp_b");
		expect(extractRequestToken({ headers: {}, url: "/api/state?token=omp_c" })).toBe("omp_c");
		expect(extractRequestToken({ headers: {}, url: "/api/state" })).toBeNull();
	});

	test("verifyWebToken distinguishes missing, invalid and expired", () => {
		const state = { token: "omp_ok", generatedAt: NOW, expiresAt: NOW + DAY, ttlDays: 1 };
		expect(verifyWebToken(null, state, NOW)).toBe("token_missing");
		expect(verifyWebToken("omp_bad", state, NOW)).toBe("token_invalid");
		expect(verifyWebToken("omp_ok", state, NOW)).toBeNull();
		expect(verifyWebToken("omp_ok", { ...state, expiresAt: NOW }, NOW)).toBe("token_expired");
	});

	test("isLoopbackAddress covers IPv4, IPv6 and localhost only", () => {
		expect(isLoopbackAddress("127.0.0.1")).toBe(true);
		expect(isLoopbackAddress("127.9.8.7")).toBe(true);
		expect(isLoopbackAddress("::1")).toBe(true);
		expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
		expect(isLoopbackAddress("localhost")).toBe(true);
		expect(isLoopbackAddress("192.168.1.8")).toBe(false);
		expect(isLoopbackAddress(undefined)).toBe(false);
	});
});
