import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import type { AgentManager } from "../pi/AgentManager";
import type { SettingsStore } from "../settings/SettingsStore";
import type { AgentTab, AppSettings, PetManifest } from "../../shared/types";
import { ipcChannels, ipcTable, type IpcHandlerMap } from "../../shared/ipc";
import type { PiDesktopApi } from "../../shared/api";
import { registerIpcHandlers } from "../ipc/registerIpc";
import { PetWindow, detectPetWindowCaps } from "./PetWindow";
import { PetStateBridge } from "./PetStateBridge";
import { PetPackageManager } from "./PetPackageManager";
import { PetPatrol } from "./PetPatrol";

type PetHandlerMaps = {
	pet: IpcHandlerMap<typeof ipcTable.pet, PiDesktopApi["pet"]> & {
		/** send 通道：宠物窗就绪信号（ipcMain.on） */
		ready: () => void;
	};
};

export type PetSystemDeps = {
	agentManager: AgentManager;
	settingsStore: SettingsStore;
	getMainWindow: () => BrowserWindow | null;
	recreateMainWindow?: () => Promise<BrowserWindow>;
};

export class PetSystem {
	readonly petWindow = new PetWindow();
	readonly packageManager = new PetPackageManager();
	readonly patrol: PetPatrol;
	private bridge: PetStateBridge;

	constructor(private readonly deps: PetSystemDeps) {
		this.patrol = new PetPatrol(
			() => this.petWindow.window,
			() => this.deps.settingsStore.get().petPatrolPauseMin ?? 5,
			(x, y) => this.petWindow.moveTo(x, y),
		);
		this.bridge = new PetStateBridge(
			() => this.petWindow.window,
			this.patrol,
			() => this.deps.settingsStore.get().petPatrolEnabled ?? true,
		);
	}

	async start() {
		// 表驱动注册：通道名/协议取自通道表（pet.ready 为 send → ipcMain.on）
		registerIpcHandlers(this.handlerMaps());
		this.bridge.attach(this.deps.agentManager);

		const s = this.deps.settingsStore.get();
		if (s.petEnabled) {
			await this.petWindow.create(s.petScale ?? 1);
			// 延迟 600ms 兜底推送初始数据，等待宠物窗 React 挂载并注册 IPC 监听器。
			// 立即发送会被新窗口丢弃（监听器尚未就绪）。React 初始态为 idle + null sprite，
			// 即使首次推送丢失也显示降级绘制。主动 petReady 信号到后会再推一次以覆盖兜底。
			setTimeout(() => {
				this.pushCaps();
				this.bridge.pushNow(this.deps.agentManager.list());
				void this.pushCurrentSprite();
			}, 600);
		}
	}

	stop() {
		this.bridge.detach();
		this.petWindow.destroy();
	}

	// ── IPC ──

	private handlerMaps(): PetHandlerMaps {
		const { settingsStore, agentManager, getMainWindow, recreateMainWindow } = this.deps;
		const C = ipcChannels;

		return {
			pet: {

		list: () => this.packageManager.list(),
		getCurrent: () => this.packageManager.get(settingsStore.get().petId),

		setEnabled: async (_e, v: boolean) => {
			const prev = settingsStore.get();
			await this.reactToSettings(prev, await settingsStore.update({ petEnabled: !!v }));
		},
		setId: async (_e, id: string) => {
			const prev = settingsStore.get();
			await this.reactToSettings(prev, await settingsStore.update({ petId: id }));
		},
		moveWindow: async (_e, pos: { x: number; y: number }) => this.petWindow.moveTo(pos.x, pos.y),
		moveBy: async (_e, delta: { dx: number; dy: number }) => {
			if (!this.petWindow.exists) return;
			const [x, y] = this.petWindow.window!.getPosition();
			// ipcMain.handle 对同一通道是串行执行的，setPosition 是同步的，不会产生增量竞争
			this.petWindow.moveTo(x + delta.dx, y + delta.dy);
		},
		setPreviewMode: async (_e, mode: string) => {
			const win = this.petWindow.window;
			if (win && !win.isDestroyed()) win.webContents.send(C.petPreviewMode, mode);
		},

		focusAgent: async () => {
			let main = getMainWindow();
			if ((!main || main.isDestroyed()) && recreateMainWindow) main = await recreateMainWindow();
			if (!main) return;
			if (!main.isVisible()) main.show();
			main.focus();
			const agentId = this.bridge.currentState?.activeAgentId;
			if (agentId) main.webContents.send(C.petFocusAgentTarget, { agentId });
		},

		// 测试：模拟真实的 failed/review 状态 + 通知 + 自动恢复 idle（与 PetStateBridge 行为一致）
		testNotify: async (_e, type: "error" | "done") => {
			const win = this.petWindow.window;
			if (!win || win.isDestroyed()) return;
			const ts = Date.now();
			if (type === "error") {
				win.webContents.send(C.petState, { mode: "failed", runningCount: 0, errorCount: 1, activeAgentId: null, timestamp: ts });
				win.webContents.send(C.petNotify, { type: "error", text: "Agent 出错了", timestamp: performance.now() });
				setTimeout(() => {
					if (win && !win.isDestroyed()) win.webContents.send(C.petState, { mode: "idle", runningCount: 0, errorCount: 0, activeAgentId: null, timestamp: Date.now() });
				}, 4000);
			} else {
				win.webContents.send(C.petState, { mode: "review", runningCount: 0, errorCount: 0, activeAgentId: null, timestamp: ts });
				win.webContents.send(C.petNotify, { type: "done", text: "任务完成，记得 Review", timestamp: performance.now() });
				setTimeout(() => {
					if (win && !win.isDestroyed()) win.webContents.send(C.petState, { mode: "idle", runningCount: 0, errorCount: 0, activeAgentId: null, timestamp: Date.now() });
				}, 4000);
			}
		},

		tease: async () => this.bridge.tease(),
		// 拖拽起止：开始时停巡游；结束时先纠正透明窗可能产生的尺寸漂移，再按 idle 状态恢复巡游。
		setDragging: async (_e, dragging: boolean) => {
			const isDragging = !!dragging;
			this.bridge.onDragState(isDragging);
			if (!isDragging) this.petWindow.ensureTargetSize();
		},

		// 宠物窗就绪信号：React 已挂载且 IPC 监听器已注册，安全推送初始数据
		ready: () => {
			const win = this.petWindow.window;
			if (!win || win.isDestroyed()) return;
			this.pushCaps();
			this.bridge.pushNow(this.deps.agentManager.list());
			void this.pushCurrentSprite();
		},

		// 右键上下文菜单：关闭宠物 / 切换宠物
		contextMenu: async () => {
			const pets = await this.packageManager.list();
			const currentId = settingsStore.get().petId;
			const template: MenuItemConstructorOptions[] = [];

			// 切换宠物子菜单
			if (pets.length > 0) {
				template.push({
					label: "切换宠物",
					submenu: pets.map((p) => ({
						label: p.displayName ?? p.id,
						type: "radio" as const,
						checked: p.id === currentId,
						click: async () => {
							const prev = settingsStore.get();
							const next = await settingsStore.update({ petId: p.id });
							await this.reactToSettings(prev, next);
						},
					})),
				});
				template.push({ type: "separator" });
			}

			// 关闭宠物
			template.push({
				label: "关闭宠物",
				click: async () => {
					const prev = settingsStore.get();
					const next = await settingsStore.update({ petEnabled: false });
					await this.reactToSettings(prev, next);
					// 通知主窗口刷新设置状态（如设置页已打开，同步显示 toggle 关闭）
					const main = this.deps.getMainWindow();
					if (main && !main.isDestroyed()) {
						main.webContents.send(C.settingsApplyWindow, next);
					}
				},
			});

			const menu = Menu.buildFromTemplate(template);
			menu.popup({});
		},
			},
		};
	}

	// ── 设置响应 ──

	async reactToSettings(prev: AppSettings, next: AppSettings) {
		// petEnabled 翻转
		if (next.petEnabled !== prev.petEnabled) {
			if (next.petEnabled) {
				await this.petWindow.create(next.petScale ?? 1);
				// 延迟 600ms 兜底推送，petReady 信号到后会再推一次覆盖兜底值
				setTimeout(() => {
					this.pushCaps();
					this.bridge.pushNow(this.deps.agentManager.list());
					void this.pushCurrentSprite();
				}, 600);
			} else {
				this.patrol.stop();
				this.petWindow.destroy();
			}
			return;
		}
		if (!next.petEnabled) return;

		if (next.petId !== prev.petId) await this.pushCurrentSprite();
		if (next.petAlwaysOnTop !== prev.petAlwaysOnTop) this.petWindow.setAlwaysOnTop(next.petAlwaysOnTop);
		if (next.petScale !== prev.petScale && next.petScale) this.petWindow.resize(next.petScale);
		if (next.petPatrolEnabled !== prev.petPatrolEnabled) {
			(next.petPatrolEnabled && this.bridge.currentState?.mode === "idle") ? this.patrol.start() : this.patrol.stop();
		}
	}

	private pushCaps() {
		const win = this.petWindow.window;
		if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.petCaps, detectPetWindowCaps());
	}

	private async pushCurrentSprite() {
		const manifest = await this.packageManager.get(this.deps.settingsStore.get().petId);
		const win = this.petWindow.window;
		if (manifest && win && !win.isDestroyed()) win.webContents.send(ipcChannels.petCurrentSprite, manifest);
	}
}
