// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 配置弹框关闭时必须丢弃设置草稿。
 *
 * 回归来源：ConfigModal 常驻挂载（App 里 `<ConfigModal open=…>` 从不卸载），
 * 组件只在 open=false 时 return null。草稿若不在关闭时复位，「放弃更改」只是关窗：
 * 遗留的 dirty 草稿会在下次打开时变成幽灵拦截，并被「保存并关闭」重新写回
 * config.yml —— 导入之后甚至会覆盖刚导入的配置。
 *
 * 这里驱动真实组件：编辑设置项 → 关闭 → 重新打开，断言回到磁盘真值。
 */

const DISK_CONFIG = {
	enabledModels: [] as string[],
	retry: { maxRetries: 3, baseDelayMs: 500 },
	compaction: { enabled: true, reserveTokens: 20000, keepRecentTokens: 8000 },
};

/**
 * 组件在模块顶层抓取 window.piDesktop，必须在 ConfigModal 被求值之前就位。
 * vi.hoisted 的回调先于 import 执行，因此这里用静态 import（不允许为测试便利引入动态 import）。
 */
vi.hoisted(() => {
	const noop = async () => undefined;
	const saveOmpConfigRaw = vi.fn(async () => ({ valid: true }));
	(window as unknown as { piDesktop: unknown; __configSaveSpies: unknown }).piDesktop = {
		config: {
			getModels: async () => ({ parsed: { providers: {} }, raw: "{}", diagnostic: null }),
			getAuth: async () => ({ parsed: {}, diagnostic: null }),
			getOmpConfig: async () => ({
				tparsed: null,
				parsed: structuredClone(DISK_CONFIG),
				raw: "retry:\n  maxRetries: 3\n",
				diagnostic: null,
			}),
			getOmpDefault: async () => ({}),
			getTrust: async () => ({ parsed: {}, diagnostic: null }),
			patchOmpConfig: vi.fn(async () => ({ valid: true })),
			saveModels: noop,
			saveAuth: noop,
			saveRaw: noop,
			saveOmpConfigRaw,
			export: async () => "",
			import: async () => ({ valid: false }),
			clearOmpDefault: noop,
			setDefaultModel: noop,
			fetchModels: async () => [],
			testProvider: async () => ({ success: true }),
		},
		agents: { list: async () => [], refreshModels: noop },
		app: { openExternal: noop },
		skills: { list: async () => ({ skills: [] }) },
		prompts: { list: async () => ({ prompts: [] }) },
		extensions: { list: async () => ({ extensions: [] }) },
	};
	(window as unknown as { __configSaveSpies: unknown }).__configSaveSpies = { saveOmpConfigRaw };
});

import { ConfigModal } from "./ConfigModal";
import { setI18nLocale, t } from "./i18n";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ConfigModal 关闭时丢弃设置草稿", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		// 默认文案来自系统语言（jsdom 是 en-US），断言按 i18n key 取，避免绑死语言。
		setI18nLocale("zh-CN");
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const retryInput = () =>
		Array.from(document.querySelectorAll("input[type=number]"))[0] as HTMLInputElement | undefined;

	const navButton = (label: string) =>
		Array.from(document.querySelectorAll("button")).find(
			(button) => (button.textContent ?? "").trim() === label,
		);

	const click = async (button: Element | undefined) => {
		await act(async () => {
			(button as HTMLElement | undefined)?.click();
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	};

	it("「放弃更改」后重新打开不带着被放弃的改动", async () => {
		const onClose = vi.fn();
		const renderWith = async (open: boolean) => {
			await act(async () => {
				root.render(<ConfigModal open={open} onClose={onClose} onSaved={() => undefined} />);
			});
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		};

		await renderWith(true);
		await click(navButton(t("config.nav.settings")));
		expect(retryInput()?.value, "设置页应载入磁盘真值").toBe("3");

		// 真实编辑：retry.maxRetries 3 -> 5。
		// 直接给 input.value 赋值会被 React 的 value tracker 吃掉、不触发 onChange，
		// 必须走原型上的原生 setter，才能让这次编辑真正进入草稿。
		await act(async () => {
			const input = retryInput();
			if (!input) return;
			const setValue = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set;
			setValue?.call(input, "5");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(retryInput()?.value).toBe("5");

		// 切走再切回：tab 切换会重新回读该 tab，但已有未提交编辑时不得重建草稿。
		await click(navButton(t("config.nav.models")));
		await click(navButton(t("config.nav.settings")));
		expect(retryInput()?.value, "切走再切回不应丢掉设置草稿").toBe("5");

		// 切到别的 tab 再关闭：这正是缺陷的触发路径——停留在设置页时 loadConfig 会顺手
		// 重建草稿，把「没复位」掩盖掉；一旦切走，草稿就带着被放弃的 5 活到下一次打开。
		await click(navButton(t("config.nav.models")));
		await click(document.querySelector(`button[aria-label='${t("common.close")}']`) ?? undefined);
		// 有未保存改动时必须先确认（这一步同时证明上面的编辑真的进了草稿）。
		expect(navButton(t("modal.discardChanges")), "有改动时关闭应先确认").toBeTruthy();
		// 选「放弃更改」，等价于用户明确表示不要这些改动。
		await click(navButton(t("modal.discardChanges")));
		expect(onClose, "放弃更改后应真正关闭").toHaveBeenCalled();

		// 由父组件驱动关闭（守卫确认后 onRequestClose 只是请求，真正的 open 由父亲改）。
		await renderWith(false);
		onClose.mockClear();
		await renderWith(true);

		// 缺陷的可见症状在这里：重新打开后什么都没碰，关闭却弹「未保存的更改」，
		// 而「保存并关闭」会把上一次被放弃的 5 写回 config.yml。
		await click(document.querySelector(`button[aria-label='${t("common.close")}']`) ?? undefined);
		expect(
			navButton(t("modal.discardChanges")),
			"重新打开后没有改动，关闭不应弹未保存确认",
		).toBeUndefined();
		expect(onClose, "没有改动时应直接关闭").toHaveBeenCalled();
	});

	/**
	 * 源文件 tab 的全文编辑同样受关闭守卫保护。
	 *
	 * 回归来源：dirty 判据此前只算设置草稿，raw/trust/models/auth 的编辑在按 Esc 或点关闭时
	 * 被直接丢弃且不给任何提示；而「保存并关闭」也只落 config.yml 的路径补丁。
	 */
	it("源文件 tab 的编辑会被关闭守卫拦下，且「保存并关闭」把它落盘", async () => {
		const spies = (window as unknown as { __configSaveSpies: { saveOmpConfigRaw: ReturnType<typeof vi.fn> } })
			.__configSaveSpies;
		spies.saveOmpConfigRaw.mockClear();
		const onClose = vi.fn();
		await act(async () => {
			root.render(<ConfigModal open onClose={onClose} onSaved={() => undefined} />);
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await click(navButton(t("config.nav.raw")));

		const editor = document.querySelector("textarea.config-raw-editor") as
			| HTMLTextAreaElement
			| null;
		expect(editor, "源文件 tab 应渲染全文编辑器").toBeTruthy();
		expect(editor?.value, "载入后应显示磁盘原文").toBe("retry:\n  maxRetries: 3\n");

		const edited = "retry:\n  maxRetries: 9\n";
		await act(async () => {
			if (!editor) return;
			const setValue = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set;
			setValue?.call(editor, edited);
			editor.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(editor?.value).toBe(edited);

		// 切走再关回来：tab 切换会重新载入，但同一文件已有未保存编辑时必须原样保留，
		// 否则「切出去看一眼」就等于丢弃草稿，而且 dirty 一并消失、关闭时连提示都不给。
		await click(navButton(t("config.nav.models")));
		await click(navButton(t("config.nav.raw")));
		const editorAfterRoundTrip = document.querySelector("textarea.config-raw-editor") as
			| HTMLTextAreaElement
			| null;
		expect(editorAfterRoundTrip?.value, "切走再切回不应丢掉 raw 草稿").toBe(edited);

		// 切走再关闭：这正是 raw 草稿被静默丢弃的历史路径（切 tab 的重载把内容洗回磁盘值）。
		await click(navButton(t("config.nav.models")));
		await click(document.querySelector(`button[aria-label='${t("common.close")}']`) ?? undefined);
		expect(navButton(t("modal.discardChanges")), "raw 有改动时关闭应先确认").toBeTruthy();

		await click(navButton(t("modal.saveAndClose")));
		expect(spies.saveOmpConfigRaw, "「保存并关闭」应把 raw 全文写入").toHaveBeenCalledWith(edited);
		expect(onClose, "落盘成功后应关闭").toHaveBeenCalled();
	});
});
