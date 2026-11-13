// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelRolesTab, type ModelRolesDraftState } from "./ModelRolesTab";

/**
 * 模型角色 tab 必须把附加项草稿的未保存状态上报给设置弹框。
 *
 * 回归来源：循环顺序 / 供应商顺序 / 角色存储有各自的保存按钮，不进 AppSettings 草稿。
 * 不上报时，用户改完直接关弹层会静默丢弃，而全局「保存并关闭」只会假称保存成功。
 * 这里驱动真实组件，断言上报的 dirty 跟着值 diff 变化，且 save/discard 真的生效。
 */

vi.hoisted(() => {
	const noop = async () => undefined;
	let cycleOrder: string[] = ["smol", "default", "slow"];
	(window as unknown as { piDesktop: unknown }).piDesktop = {
		config: {
			getOmpRoles: async () => ({
				default: { selector: "" },
				smol: { selector: "" },
				slow: { selector: "" },
				vision: { selector: "" },
				plan: { selector: "" },
				commit: { selector: "" },
				tiny: { selector: "" },
				task: { selector: "" },
				advisor: { selector: "" },
			}),
			getOmpModelPresets: async () => ({}),
			getOmpCycleOrder: async () => cycleOrder,
			getOmpFallbackChains: async () => ({}),
			getOmpProviderOrder: async () => ["anthropic"],
			getOmpRoleStorage: async () => "global",
			setOmpCycleOrder: async (order: string[]) => {
				cycleOrder = order;
				return { valid: true };
			},
			setOmpProviderOrder: noop,
			setOmpRoleStorage: noop,
			setOmpFallbackChains: noop,
			saveOmpModelPreset: noop,
			applyOmpModelPreset: noop,
			deleteOmpModelPreset: noop,
		},
		projects: { listModels: async () => [] },
	};
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

/** 等挂载期的一串配置读取落地。 */
async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

async function mount(
	onDraftStateChange: (state: ModelRolesDraftState | null) => void,
): Promise<void> {
	await act(async () => {
		root.render(<ModelRolesTab onDraftStateChange={onDraftStateChange} />);
	});
	await flush();
}

/** 循环顺序输入框（placeholder 与 i18n 一致，按 placeholder 找最稳）。 */
function cycleInput(): HTMLInputElement {
	const input = container.querySelector<HTMLInputElement>(
		'input[placeholder="smol, default, slow"]',
	);
	if (!input) throw new Error("cycle order input not found");
	return input;
}

function typeInto(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	act(() => {
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("ModelRolesTab draft reporting", () => {
	it("reports dirty on edit and clean again after discard", async () => {
		const states: Array<ModelRolesDraftState | null> = [];
		await mount((state) => states.push(state));

		// 载入后草稿与磁盘一致，应当是干净的
		expect(states.at(-1)?.dirty).toBe(false);

		typeInto(cycleInput(), "smol, slow");
		expect(states.at(-1)?.dirty).toBe(true);

		act(() => states.at(-1)?.discard());
		expect(states.at(-1)?.dirty).toBe(false);
		// 丢弃后输入框回到磁盘值
		expect(cycleInput().value).toBe("smol, default, slow");
	});

	it("writes the dirty field and reports clean after save", async () => {
		const states: Array<ModelRolesDraftState | null> = [];
		await mount((state) => states.push(state));

		typeInto(cycleInput(), "slow, smol");
		expect(states.at(-1)?.dirty).toBe(true);

		let ok = false;
		await act(async () => {
			ok = (await states.at(-1)?.save()) ?? false;
		});
		expect(ok).toBe(true);
		// 保存后基线以磁盘真值重建，草稿不再脏
		expect(states.at(-1)?.dirty).toBe(false);
		expect(cycleInput().value).toBe("slow, smol");
	});

	it("withdraws its report when unmounted so the next open starts clean", async () => {
		const states: Array<ModelRolesDraftState | null> = [];
		await mount((state) => states.push(state));
		typeInto(cycleInput(), "slow");

		act(() => root.unmount());
		expect(states.at(-1)).toBeNull();
	});
});

describe("ModelRolesTab text drafts", () => {
	it("treats a typed preset name as dirty and clears it on discard", async () => {
		const states: Array<ModelRolesDraftState | null> = [];
		await mount((state) => states.push(state));
		expect(states.at(-1)?.dirty).toBe(false);

		// 预设名不参与 extrasDraft 的字段 diff，但它同样是没落盘的输入。
		const input = container.querySelector<HTMLInputElement>(
			'input[placeholder="例如 fast-coding"], input[placeholder="e.g. fast-coding"]',
		);
		if (!input) throw new Error("preset name input not found");
		typeInto(input, "fast-coding");
		expect(states.at(-1)?.dirty).toBe(true);

		act(() => states.at(-1)?.discard());
		expect(states.at(-1)?.dirty).toBe(false);
		expect(input.value, "取消后输入框必须清空，否则看起来像没生效").toBe("");
	});
});
