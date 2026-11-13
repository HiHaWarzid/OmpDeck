import { describe, expect, it } from "vitest";
import {
	EMPTY_PANEL_STATE,
	applyPanelIntent,
	forgetStoredProject,
	loadExpandedDirs,
	loadStoredPanel,
	saveExpandedDirs,
	saveStoredPanel,
	selectPanelView,
	type PanelEnv,
	type PanelState,
	type StorageLike,
} from "./sessionPanelState";

const ENV: PanelEnv = { activeProjectId: "p1", gitEnabled: true };

function memoryStorage(seed: Record<string, string> = {}): StorageLike & {
	dump: () => Record<string, string>;
} {
	const data = { ...seed };
	return {
		getItem: (key) => (key in data ? data[key]! : null),
		setItem: (key, value) => {
			data[key] = value;
		},
		removeItem: (key) => {
			delete data[key];
		},
		dump: () => ({ ...data }),
	};
}

function run(state: PanelState, env: PanelEnv, ...intents: Parameters<typeof applyPanelIntent>[1][]) {
	return intents.reduce(
		(acc, intent) => applyPanelIntent(acc.state, intent, env),
		{ state, effects: [] } as ReturnType<typeof applyPanelIntent>,
	);
}

describe("applyPanelIntent", () => {
	it("persists the opened panel for the active project and refreshes the file tree", () => {
		const result = applyPanelIntent(EMPTY_PANEL_STATE, { type: "open-panel", panel: "files" }, ENV);
		expect(result.state.panel).toBe("files");
		expect(result.state.collapsed).toBe(false);
		expect(result.effects).toEqual([
			{ type: "refresh-files", projectId: "p1" },
			{ type: "persist", projectId: "p1", panel: "files", pinned: false },
		]);
	});

	it("folds the legacy editor panel into files when it is read back from storage", () => {
		const storage = memoryStorage({
			"pid:project-drawer:p1": JSON.stringify({ panel: "editor", pinned: true }),
		});
		expect(loadStoredPanel(storage, "p1", [])).toEqual({ panel: "files", pinned: true });
	});

	it("refuses to open git while the feature is disabled", () => {
		const env: PanelEnv = { activeProjectId: "p1", gitEnabled: false };
		const result = applyPanelIntent(EMPTY_PANEL_STATE, { type: "open-panel", panel: "git" }, env);
		expect(result.state).toBe(EMPTY_PANEL_STATE);
		expect(result.effects).toEqual([]);
	});

	it("blocks a different panel while one is pinned, and keeps the pin after close", () => {
		const pinned = run(
			EMPTY_PANEL_STATE,
			ENV,
			{ type: "open-panel", panel: "git" },
			{ type: "toggle-pin" },
		);
		expect(pinned.state.pinnedByProject).toEqual({ p1: "git" });

		const blocked = applyPanelIntent(pinned.state, { type: "open-panel", panel: "files" }, ENV);
		expect(blocked.state.panel).toBe("git");

		const closed = applyPanelIntent(pinned.state, { type: "close" }, ENV);
		expect(closed.state).toBe(pinned.state);
		expect(closed.effects).toEqual([]);

		const collapsed = applyPanelIntent(pinned.state, { type: "collapse" }, ENV);
		expect(collapsed.state.collapsed).toBe(false);
	});

	it("treats hide as a no-op on a pinned panel and a non-persisting close otherwise", () => {
		const pinned = run(
			EMPTY_PANEL_STATE,
			ENV,
			{ type: "open-panel", panel: "browser" },
			{ type: "toggle-pin" },
		);
		expect(applyPanelIntent(pinned.state, { type: "hide" }, ENV).state.panel).toBe("browser");

		const unpinned = applyPanelIntent(EMPTY_PANEL_STATE, { type: "open-panel", panel: "browser" }, ENV);
		const hidden = applyPanelIntent(unpinned.state, { type: "hide" }, ENV);
		expect(hidden.state.panel).toBeNull();
		// 临时让位不改持久化偏好：唯一落盘发生在 open-panel 那一步。
		expect(hidden.effects).toEqual([]);
	});

	it("lets a drag collapse the panel but never collapses a pinned one", () => {
		const open = applyPanelIntent(EMPTY_PANEL_STATE, { type: "open-panel", panel: "files" }, ENV).state;
		expect(applyPanelIntent(open, { type: "resize-collapse", collapsed: true }, ENV).state.collapsed).toBe(true);
		expect(applyPanelIntent(open, { type: "resize-collapse", collapsed: false }, ENV).state.collapsed).toBe(false);

		const pinned = applyPanelIntent(open, { type: "toggle-pin" }, ENV).state;
		expect(applyPanelIntent(pinned, { type: "resize-collapse", collapsed: true }, ENV).state.collapsed).toBe(false);
	});

	it("restores the saved panel per project and clears state for a project without a record", () => {
		const restored = applyPanelIntent(
			EMPTY_PANEL_STATE,
			{ type: "project-restored", saved: { panel: "sessions", pinned: true } },
			ENV,
		);
		expect(restored.state.panel).toBe("sessions");
		expect(restored.state.pinnedByProject).toEqual({ p1: "sessions" });
		expect(restored.state.sessionsProjectId).toBe("p1");

		const cleared = applyPanelIntent(
			restored.state,
			{ type: "project-restored", saved: null },
			ENV,
		);
		expect(cleared.state.panel).toBeNull();
		expect(cleared.state.pinnedByProject).toEqual({});
	});

	it("does not restore a saved git panel once the feature is off", () => {
		const result = applyPanelIntent(
			EMPTY_PANEL_STATE,
			{ type: "project-restored", saved: { panel: "git", pinned: true } },
			{ activeProjectId: "p1", gitEnabled: false },
		);
		expect(result.state.panel).toBeNull();
		expect(result.state.pinnedByProject).toEqual({});
		// 存储里的 git 记录必须一起清掉，否则重新打开功能后一切回该项目就复活面板。
		expect(result.effects).toEqual([
			{ type: "persist", projectId: "p1", panel: null, pinned: false },
		]);
	});

	it("drops every git pin and closes the git panel when the feature is turned off", () => {
		const state: PanelState = {
			...EMPTY_PANEL_STATE,
			panel: "git",
			pinnedByProject: { p1: "git", p2: "files" },
			lastToolPanel: "git",
		};
		const result = applyPanelIntent(
			state,
			{ type: "git-disabled", saved: null },
			{ activeProjectId: "p1", gitEnabled: false },
		);
		expect(result.state.panel).toBeNull();
		expect(result.state.pinnedByProject).toEqual({ p2: "files" });
		// lastToolPanel 不清：关闭期间 toggle-header 已经降到 files，重新打开 Git 后要能回到 Git。
		expect(result.state.lastToolPanel).toBe("git");
		expect(result.effects).toEqual([
			{ type: "persist", projectId: "p1", panel: null, pinned: false },
		]);
	});

	it("clears a stored git record that was never restored", () => {
		// 启动时 Git 就是关的：内存里没有 git 面板，但存储里有，必须清掉。
		const result = applyPanelIntent(
			EMPTY_PANEL_STATE,
			{ type: "git-disabled", saved: { panel: "git", pinned: false } },
			{ activeProjectId: "p1", gitEnabled: false },
		);
		expect(result.state.panel).toBeNull();
		expect(result.effects).toEqual([
			{ type: "persist", projectId: "p1", panel: null, pinned: false },
		]);
	});

	it("leaves storage alone when the feature is off and the record is not git", () => {
		const result = applyPanelIntent(
			EMPTY_PANEL_STATE,
			{ type: "git-disabled", saved: { panel: "files", pinned: true } },
			{ activeProjectId: "p1", gitEnabled: false },
		);
		expect(result.effects).toEqual([]);
	});

	it("forgets the pin and the stored record of a removed project", () => {
		const state: PanelState = { ...EMPTY_PANEL_STATE, pinnedByProject: { p1: "files", p2: "git" } };
		const result = applyPanelIntent(state, { type: "projects-removed", projectIds: ["p2"] }, ENV);
		expect(result.state.pinnedByProject).toEqual({ p1: "files" });
		// 删除即删键（面板 + 展开目录），不留空记录。
		expect(result.effects).toEqual([{ type: "forget-project", projectId: "p2" }]);
		// 未删除的项目不受影响，也不会重复清盘。
		const untouched = applyPanelIntent(result.state, { type: "projects-removed", projectIds: ["p1"] }, ENV);
		expect(untouched.state.pinnedByProject).toEqual({});
	});

	it("cleans up every project that vanished in one pass", () => {
		// 关闭工作区模式会一次性删掉某父项目下所有 worktree 子项目，差集可能不止一个 id。
		const state: PanelState = {
			...EMPTY_PANEL_STATE,
			pinnedByProject: { p1: "files", p2: "git", p3: "browser" },
		};
		const result = applyPanelIntent(
			state,
			{ type: "projects-removed", projectIds: ["p2", "p3"] },
			ENV,
		);
		expect(result.state.pinnedByProject).toEqual({ p1: "files" });
		expect(result.effects).toEqual([
			{ type: "forget-project", projectId: "p2" },
			{ type: "forget-project", projectId: "p3" },
		]);
	});

	it("treats an empty removal set as a no-op", () => {
		const state: PanelState = { ...EMPTY_PANEL_STATE, pinnedByProject: { p1: "files" } };
		const result = applyPanelIntent(state, { type: "projects-removed", projectIds: [] }, ENV);
		expect(result.state).toBe(state);
		expect(result.effects).toEqual([]);
	});

	it("closes the history panel of a removed project and forgets its pin", () => {
		const state = applyPanelIntent(
			EMPTY_PANEL_STATE,
			{ type: "project-restored", saved: { panel: "sessions", pinned: true } },
			ENV,
		).state;
		const result = applyPanelIntent(state, { type: "projects-removed", projectIds: ["p1"] }, ENV);
		expect(result.state.panel).toBeNull();
		expect(result.state.sessionsProjectId).toBeUndefined();
		expect(result.state.pinnedByProject).toEqual({});
	});

	it("opens the header toggle onto the last tool panel and skips git when it is off", () => {
		const state: PanelState = { ...EMPTY_PANEL_STATE, lastToolPanel: "git" };
		const result = applyPanelIntent(state, { type: "toggle-header" }, { activeProjectId: "p1", gitEnabled: false });
		expect(result.state.panel).toBe("files");
	});
});

describe("selectPanelView", () => {
	it("reports the pinned panel of the active project and keeps the last content while collapsed", () => {
		const state: PanelState = {
			...EMPTY_PANEL_STATE,
			panel: "files",
			collapsed: true,
			pinnedByProject: { p2: "git" },
		};
		expect(selectPanelView(state, "p1", "browser")).toEqual({
			panel: "files",
			collapsed: true,
			pinned: false,
			contentPanel: "browser",
		});
		expect(selectPanelView(state, "p2", "browser").pinned).toBe(true);
	});
});

describe("localStorage codec", () => {
	it("round-trips panel state and migrates the legacy per-agent key", () => {
		const storage = memoryStorage({ "pid:agent-drawer:a1": JSON.stringify({ panel: "git", pinned: true }) });
		const loaded = loadStoredPanel(storage, "p1", ["a1"]);
		expect(loaded).toEqual({ panel: "git", pinned: true });
		// 迁移后旧键失效，避免下次再从 agent 键读一次。
		expect(storage.dump()["pid:agent-drawer:a1"]).toBeUndefined();
		expect(storage.dump()["pid:project-drawer:p1"]).toBeDefined();
	});

	it("rejects malformed records instead of surfacing junk panel names", () => {
		const storage = memoryStorage({
			"pid:project-drawer:p1": JSON.stringify({ panel: "nope", pinned: false }),
		});
		expect(loadStoredPanel(storage, "p1", [])).toBeNull();
	});

	it("round-trips expanded dirs and ignores non-array payloads", () => {
		const storage = memoryStorage();
		saveExpandedDirs(storage, "p1", new Set(["src", "src/main"]));
		expect([...loadExpandedDirs(storage, "p1", [])].sort()).toEqual(["src", "src/main"]);

		const broken = memoryStorage({ "pid:project-expanded-dirs:p1": JSON.stringify({ a: 1 }) });
		expect([...loadExpandedDirs(broken, "p1", [])]).toEqual([]);
	});

	it("migrates expanded dirs from the newest legacy agent key", () => {
		const storage = memoryStorage({
			"pid:agent-expanded-dirs:a2": JSON.stringify(["lib"]),
		});
		expect([...loadExpandedDirs(storage, "p9", ["a1", "a2"])]).toEqual(["lib"]);
		expect(storage.dump()["pid:agent-expanded-dirs:a2"]).toBeUndefined();
	});

	it("forgets both persisted keys of a deleted project", () => {
		const storage = memoryStorage({
			"pid:project-drawer:p1": JSON.stringify({ panel: "git", pinned: true }),
			"pid:project-expanded-dirs:p1": JSON.stringify(["src"]),
			"pid:project-drawer:p2": JSON.stringify({ panel: "files", pinned: false }),
		});
		forgetStoredProject(storage, "p1");
		// 删的是键本身：留一份空记录会让「从未展开过」和「展开过但清空」无法区分。
		expect(storage.dump()).not.toHaveProperty("pid:project-drawer:p1");
		expect(storage.dump()).not.toHaveProperty("pid:project-expanded-dirs:p1");
		expect(storage.dump()["pid:project-drawer:p2"]).toBeDefined();
	});

	it("survives a storage that throws", () => {
		const throwing: StorageLike = {
			getItem: () => {
				throw new Error("quota");
			},
			setItem: () => {
				throw new Error("quota");
			},
			removeItem: () => {
				throw new Error("quota");
			},
		};
		expect(loadStoredPanel(throwing, "p1", [])).toBeNull();
		expect(() => saveStoredPanel(throwing, "p1", { panel: "files", pinned: false })).not.toThrow();
	});
});
