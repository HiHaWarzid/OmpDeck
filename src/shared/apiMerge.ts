import type { PiDesktopApi } from "./api";

/**
 * 覆盖层形状：任意命名空间的成员子集（成员签名仍受 PiDesktopApi 编译期校验）。
 * 供 preload（特殊实现成员）与 renderer 假实现（罐头数据）共用。
 */
export type NamespaceOverrides = {
	[Ns in keyof PiDesktopApi]?: Partial<PiDesktopApi[Ns]>;
};

/**
 * 深合并覆盖层：base 生成 + 覆盖成员，逐命名空间合并，
 * 不能让覆盖层顶掉同一命名空间里由 base 提供的其它成员。
 * 接口类型没有索引签名，中间态用 Record 承载；边界处收敛：
 * 入参形状由 NamespaceOverrides 编译期校验，返回值以 PiDesktopApi 收敛断言。
 */
export function mergeApiOverrides(base: PiDesktopApi, overrides: NamespaceOverrides): PiDesktopApi {
	const merged = { ...base } as unknown as Record<string, Record<string, unknown>>;
	for (const [namespace, members] of Object.entries(overrides)) {
		merged[namespace] = {
			...(merged[namespace] ?? {}),
			...(members as unknown as Record<string, unknown>),
		};
	}
	return merged as unknown as PiDesktopApi;
}
