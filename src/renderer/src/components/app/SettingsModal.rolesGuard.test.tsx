// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../../../shared/types";
import { SettingsModal } from "./SettingsModal";
import { setI18nLocale, t } from "../../i18n";

/**
 * 设置弹框的关闭守卫必须覆盖模型角色 tab 的附加项草稿。
 *
 * 回归来源：循环顺序 / 供应商顺序 / 角色存储在 ModelRolesTab 内自带保存按钮，
 * 不进 AppSettings 草稿。守卫只看 settingsDraft 时，「改完直接关」会被放行、
 * 静默丢弃改动，「保存并关闭」也只写 AppSettings 却宣称成功。
 * 这里驱动真实弹框：改角色 tab 的顺序 → 点关闭 → 必须弹未保存确认 → 保存必须真的写盘。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settings = {
	useNativeTitleBar: false,
	showNativeMenu: false,
	sendShortcut: "enter-send",
	theme: "system",
	lightBackground: "white",
	language: "system",
	startupWindowMode: "last",
	piEnvironmentChecked: false,
	enableGitManagement: true,
	gitCommitMessagePrompt: "",
	closeToTray: false,
	singleInstance: true,
	enableNotifications: true,
	showThinking: true,
	showDevTools: false,
	electronChromiumSandbox: false,
	piProxyEnabled: false,
	piProxyUrl: "",
	piProxyBypass: "",
	desktopProxyEnabled: false,
	desktopProxyUrl: "",
	desktopProxyBypass: "",
	customPiPath: "",
	wslEnabled: false,
	wslDistro: "Ubuntu",
	wslUser: "root",
	telemetryEnabled: true,
	webServiceEnabled: false,
	webServiceHost: "127.0.0.1",
	webServicePort: 8765,
	remoteAccessEnabled: false,
	webServiceTokenTtlDays: 30,
	rpcTimeout: 600_000,
	linkOpenMode: "external",
	contentMaxWidth: 1400,
	maxEditorFileSizeMB: 5,
	externalEditors: { editors: [] },
} as unknown as AppSettings;

let writtenOrder: string[] | null = null;
let writtenPreset: string | null = null;
let writtenFallback: Record<string, string[]> | null = null;
let cycleOrder = ["smol", "default", "slow"];

/**
 * 只补本组件真正依赖的返回值；其余 API 用「返回 Promise<undefined>」兜底，
 * 保证 `.catch(...)` 这类链式调用不会因为缺桩而抛错。
 */
const known: Record<string, unknown> = {
	pet: { list: async () => [] },
	projects: { list: async () => [] },
	web: { status: async () => null },
	remoteAccess: { status: async () => null },
	settings: { get: async () => settings },
	logs: { read: async () => "", clear: async () => undefined },
	rpcLogs: { read: async () => "", clear: async () => undefined },
	config: {
		getOmpRoles: async () =>
			Object.fromEntries(
				["default", "smol", "slow", "vision", "plan", "commit", "tiny", "memory", "task", "advisor",
					"image", "web", "speech", "dictation", "judge"].map((role) => [role, { selector: "" }]),
			),
		getOmpModelPresets: async () => ({}),
		getOmpCycleOrder: async () => cycleOrder,
		getOmpFallbackChains: async () => ({}),
		getOmpProviderOrder: async () => [],
		getOmpRoleStorage: async () => "global",
		setOmpCycleOrder: async (order: string[]) => {
			writtenOrder = order;
			cycleOrder = order;
			return { valid: true };
		},
		setOmpProviderOrder: async () => ({ valid: true }),
		setOmpRoleStorage: async () => ({ valid: true }),
		setOmpFallbackChains: async (chains: Record<string, string[]>) => {
			writtenFallback = chains;
			return { valid: true };
		},
		saveOmpModelPreset: async (name: string) => {
			writtenPreset = name;
			return { valid: true };
		},
		applyOmpModelPreset: async () => ({ valid: true }),
		deleteOmpModelPreset: async () => ({ valid: true }),
	},
};

function fallback(): unknown {
	return new Proxy(function named() {}, {
		get: (_target, key) => (key === "then" ? undefined : fallback()),
		apply: () => Promise.resolve(undefined),
	});
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	setI18nLocale("zh-CN");
	writtenOrder = null;
	writtenPreset = null;
	writtenFallback = null;
	(window as unknown as { piDesktop: unknown }).piDesktop = new Proxy(known, {
		get: (target, key) =>
			key in target ? (target as Record<string, unknown>)[key as string] : fallback(),
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

async function flush(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function navButton(label: string): HTMLElement | undefined {
	return Array.from(document.querySelectorAll("button")).find(
		(button) => (button.textContent ?? "").trim() === label,
	) as HTMLElement | undefined;
}

async function click(element: Element | undefined): Promise<void> {
	await act(async () => {
		(element as HTMLElement | undefined)?.click();
	});
	await flush();
}

async function mount(onChange = vi.fn(async () => true)): Promise<ReturnType<typeof vi.fn>> {
	await act(async () => {
		root.render(
			<SettingsModal
				settings={settings}
				onClose={() => undefined}
				onChange={onChange}
				piStatus={null}
				piChecking={false}
				piProxyChecking={false}
				piProxyNotice=""
				piProxyNoticeTone="info"
				webServiceChanging={false}
				appInfo={{ version: "0.0.0", electron: "", chrome: "", node: "", platform: "" } as never}
				customPiPath=""
				customPathValidating={false}
				customPathResult={null}
				updateChecking={false}
				piUpdating={false}
				piUpdateChecking={false}
				piUpdateCheck={null}
				piUpdateResult={null}
				onCustomPathChange={() => undefined}
				onValidateCustomPath={() => undefined}
				onClearCustomPath={() => undefined}
				onCheckPi={() => undefined}
				onTestPiProxy={() => undefined}
				onCheckUpdate={() => undefined}
				onCheckPiUpdate={() => undefined}
				onUpdatePi={() => undefined}
				onToggleDevTools={() => undefined}
				onRestartApp={() => undefined}
				onOpenWebService={() => undefined}
			/>,
		);
	});
	await flush();
	return onChange as unknown as ReturnType<typeof vi.fn>;
}

describe("设置弹框关闭守卫覆盖模型角色草稿", () => {
	it("改了顺序后关闭会先确认，保存并关闭真的写盘", async () => {
		const onChange = await mount();
		await click(navButton(t("settings.tabs.roles")));

		const input = document.querySelector<HTMLInputElement>('input[placeholder="smol, default, slow"]');
		expect(input, "角色 tab 应渲染循环顺序输入框").toBeTruthy();
		await act(async () => {
			const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setValue?.call(input, "slow, smol");
			input!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await flush();

		// 切到别的 tab 也不能让草稿蒸发（tab 首次访问后保持挂载）
		await click(navButton(t("settings.tabs.common")));

		await click(document.querySelector(`button[aria-label='${t("common.close")}']`) ?? undefined);
		const saveAndClose = navButton(t("modal.saveAndClose"));
		expect(saveAndClose, "有未保存的角色草稿时关闭必须先确认").toBeTruthy();

		await click(saveAndClose);
		expect(writtenOrder, "确认框的「保存并关闭」必须把角色草稿写盘").toEqual(["slow", "smol"]);
		// 没有任何 AppSettings 字段被改，不该顺手写全局设置
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe("设置弹框关闭守卫覆盖角色 tab 的文本草稿", () => {
	it("只填了预设名也算未保存，保存并关闭会真的保存预设", async () => {
		const onChange = await mount();
		await click(navButton(t("settings.tabs.roles")));

		// 预设名不写 extrasDraft：它是「填好再点旁边按钮」的动作。
		// 但它同样是用户的未保存输入，守卫不能把它当成没发生。
		const input = document.querySelector<HTMLInputElement>(
			`input[placeholder="${t("settings.modelPresets.namePlaceholder")}"]`,
		);
		expect(input, "角色 tab 应渲染预设名输入框").toBeTruthy();
		await act(async () => {
			const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setValue?.call(input, "fast-coding");
			input!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await flush();

		await click(document.querySelector(`button[aria-label='${t("common.close")}']`) ?? undefined);
		const saveAndClose = navButton(t("modal.saveAndClose"));
		expect(saveAndClose, "有未保存的预设名时关闭必须先确认").toBeTruthy();

		await click(saveAndClose);
		expect(writtenPreset, "确认框的「保存并关闭」必须把预设名提交出去").toBe("fast-coding");
		// 附加项表单本身没脏，不该顺手写回循环顺序
		expect(writtenOrder).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe("设置弹框关闭守卫覆盖回退链文本草稿", () => {
	it("只填了回退链也算未保存，保存并关闭会真的写入该链", async () => {
		const onChange = await mount();
		await click(navButton(t("settings.tabs.roles")));

		const chainInput = document.querySelector<HTMLInputElement>(
			`input[placeholder="${t("settings.modelFallback.chainPlaceholder")}"]`,
		);
		expect(chainInput, "角色 tab 应渲染回退链输入框").toBeTruthy();
		await act(async () => {
			const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setValue?.call(chainInput, "anthropic/claude, openai/gpt:high");
			chainInput!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await flush();

		await click(document.querySelector(`button[aria-label='${t("common.close")}']`) ?? undefined);
		const saveAndClose = navButton(t("modal.saveAndClose"));
		expect(saveAndClose, "有未保存的回退链时关闭必须先确认").toBeTruthy();

		await click(saveAndClose);
		// 键取输入框默认的 default：与点「添加」按钮完全同一条路径。
		expect(writtenFallback).toEqual({
			default: ["anthropic/claude", "openai/gpt:high"],
		});
		expect(writtenOrder).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe("回退链文本写不进去时不得假装保存成功", () => {
	it("回退键为空时「保存并关闭」留在弹层并说明原因，不丢文本", async () => {
		const onChange = await mount();
		await click(navButton(t("settings.tabs.roles")));

		// 清空回退键（默认 default），只留回退模型：这段文本没有目标键可写。
		const keyInput = document.querySelector<HTMLInputElement>(
			`input[placeholder="${t("settings.modelFallback.keyPlaceholder")}"]`,
		);
		expect(keyInput, "角色 tab 应渲染回退键输入框").toBeTruthy();
		const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		await act(async () => {
			setValue?.call(keyInput, "");
			keyInput!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const chainInput = document.querySelector<HTMLInputElement>(
			`input[placeholder="${t("settings.modelFallback.chainPlaceholder")}"]`,
		);
		await act(async () => {
			setValue?.call(chainInput, "anthropic/claude");
			chainInput!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await flush();

		await click(document.querySelector(`button[aria-label='${t("common.close")}']`) ?? undefined);
		const saveAndClose = navButton(t("modal.saveAndClose"));
		expect(saveAndClose, "输入框里有文本就必须先确认").toBeTruthy();
		await click(saveAndClose);

		// 关键：不能一边宣称保存成功一边丢掉这段文本。
		expect(writtenFallback, "没有回退键时不得写入").toBeNull();
		expect(
			document.body.textContent ?? "",
			"应说明为什么保存不了",
		).toContain(t("settings.modelFallback.missingKey"));
		// 仍留在弹层里，文本还在输入框中，用户可以补上键再保存。
		expect(chainInput?.isConnected).toBe(true);
		expect(chainInput?.value).toBe("anthropic/claude");
		expect(onChange).not.toHaveBeenCalled();
	});
});
