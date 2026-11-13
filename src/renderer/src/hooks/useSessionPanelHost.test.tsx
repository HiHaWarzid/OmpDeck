// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { DRAWER_ANIMATION_MS } from "../components/app/panel/sessionPanelState";
import { useSessionPanelHost, type SessionPanelHost } from "./useSessionPanelHost";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let latest: SessionPanelHost;
let refreshFiles: Mock<(projectId: string) => void>;

interface HarnessProps {
	activeProjectId?: string;
	gitEnabled?: boolean;
	legacyAgentIdsFor?: (projectId: string) => string[];
}

function Probe({ activeProjectId, gitEnabled = true, legacyAgentIdsFor }: HarnessProps) {
	latest = useSessionPanelHost({
		activeProjectId,
		gitEnabled,
		legacyAgentIdsFor,
		storage: localStorage,
		onRefreshFiles: refreshFiles,
	});
	return null;
}

async function mount(props: HarnessProps) {
	await act(async () => {
		root.render(<Probe {...props} />);
	});
}

async function rerender(props: HarnessProps) {
	await act(async () => {
		root.render(<Probe {...props} />);
	});
}

async function run(action: () => void) {
	await act(async () => {
		action();
	});
}

beforeEach(() => {
	localStorage.clear();
	refreshFiles = vi.fn<(projectId: string) => void>();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.useRealTimers();
});

describe("useSessionPanelHost", () => {
	it("restores the panel and expanded dirs of the project it lands on", async () => {
		localStorage.setItem(
			"pid:project-drawer:p2",
			JSON.stringify({ panel: "files", pinned: true }),
		);
		localStorage.setItem("pid:project-expanded-dirs:p2", JSON.stringify(["src"]));

		await mount({ activeProjectId: "p2" });

		expect(latest.panel).toBe("files");
		expect(latest.pinned).toBe(true);
		expect([...latest.expandedDirs]).toEqual(["src"]);
	});

	it("migrates from the legacy per-agent key on first restore", async () => {
		localStorage.setItem(
			"pid:agent-drawer:a1",
			JSON.stringify({ panel: "browser", pinned: false }),
		);

		await mount({ activeProjectId: "p7", legacyAgentIdsFor: () => ["a1"] });

		expect(latest.panel).toBe("browser");
		expect(localStorage.getItem("pid:agent-drawer:a1")).toBeNull();
		expect(localStorage.getItem("pid:project-drawer:p7")).not.toBeNull();
	});

	it("persists the opened panel and refreshes the file tree once", async () => {
		await mount({ activeProjectId: "p1" });

		await run(() => latest.openPanel("files"));

		expect(refreshFiles).toHaveBeenCalledWith("p1");
		expect(JSON.parse(localStorage.getItem("pid:project-drawer:p1")!)).toEqual({
			panel: "files",
			pinned: false,
		});
	});

	it("keeps a pinned panel through close and blocks switching tabs", async () => {
		await mount({ activeProjectId: "p1" });
		await run(() => latest.openPanel("git"));
		await run(() => latest.togglePin());
		expect(latest.pinned).toBe(true);

		await run(() => latest.close());
		expect(latest.panel).toBe("git");
		await run(() => latest.openPanel("files"));
		expect(latest.panel).toBe("git");

		await run(() => latest.togglePin());
		expect(latest.pinned).toBe(false);
		await run(() => latest.openPanel("files"));
		expect(latest.panel).toBe("files");
	});

	it("keeps the last content rendered until the collapse animation finishes", async () => {
		vi.useFakeTimers();
		await mount({ activeProjectId: "p1" });
		await run(() => latest.openPanel("browser"));
		expect(latest.contentPanel).toBe("browser");

		await run(() => latest.collapse());
		expect(latest.collapsed).toBe(true);
		// 收起瞬间仍渲染旧内容，Grid 列宽过渡期间文字不会先消失。
		expect(latest.contentPanel).toBe("browser");

		await act(async () => {
			vi.advanceTimersByTime(DRAWER_ANIMATION_MS);
		});
		expect(latest.contentPanel).toBeNull();

		await run(() => latest.restore());
		expect(latest.collapsed).toBe(false);
		expect(latest.contentPanel).toBe("browser");
	});

	it("hides the panel without touching the persisted preference", async () => {
		await mount({ activeProjectId: "p1" });
		await run(() => latest.openPanel("files"));
		const stored = localStorage.getItem("pid:project-drawer:p1");

		await run(() => latest.hide());

		expect(latest.panel).toBeNull();
		expect(localStorage.getItem("pid:project-drawer:p1")).toBe(stored);
	});

	it("closes the sessions panel when its project is forgotten", async () => {
		await mount({ activeProjectId: "p1" });
		await run(() => latest.openSessions("p3"));
		expect(latest.sessionsProjectId).toBe("p3");

		await run(() => latest.forgetProject("p3"));

		expect(latest.sessionsProjectId).toBeUndefined();
		expect(latest.panel).toBeNull();
	});

	it("toggles directories through the host and persists them for the project", async () => {
		await mount({ activeProjectId: "p1" });

		await run(() => latest.toggleDirectory("src"));
		expect([...latest.expandedDirs]).toEqual(["src"]);
		expect(JSON.parse(localStorage.getItem("pid:project-expanded-dirs:p1")!)).toEqual(["src"]);

		await run(() => latest.toggleDirectory("src"));
		expect([...latest.expandedDirs]).toEqual([]);
	});

	it("drops the git panel when the feature is switched off", async () => {
		await mount({ activeProjectId: "p1", gitEnabled: true });
		await run(() => latest.openPanel("git"));
		expect(latest.panel).toBe("git");

		await rerender({ activeProjectId: "p1", gitEnabled: false });

		expect(latest.panel).toBeNull();
		expect(JSON.parse(localStorage.getItem("pid:project-drawer:p1")!).panel).toBeNull();
	});

	it("reports a refused tab switch so callers can hold their own side effects", async () => {
		await mount({ activeProjectId: "p1" });
		await run(() => latest.openPanel("git"));
		await run(() => latest.togglePin());

		// 钉选时切到别的 Tab 必须被拒，且调用方要能知道「没切」。
		let accepted = true;
		await run(() => {
			accepted = latest.openPanel("files");
		});
		expect(accepted).toBe(false);
		expect(latest.panel).toBe("git");
	});

	it("reports a refused git open while the feature is off", async () => {
		await mount({ activeProjectId: "p1", gitEnabled: false });
		let accepted = true;
		await run(() => {
			accepted = latest.openPanel("git");
		});
		expect(accepted).toBe(false);
		expect(latest.panel).toBeNull();
	});

	it("restores per project across a switch and drops the pin of a forgotten project", async () => {
		localStorage.setItem(
			"pid:project-drawer:a",
			JSON.stringify({ panel: "files", pinned: true }),
		);
		localStorage.setItem(
			"pid:project-drawer:b",
			JSON.stringify({ panel: "browser", pinned: true }),
		);

		await mount({ activeProjectId: "a" });
		expect(latest.panel).toBe("files");

		await rerender({ activeProjectId: "b" });
		expect(latest.panel).toBe("browser");

		await rerender({ activeProjectId: "a" });
		expect(latest.panel).toBe("files");

		// 项目真正被删除时才清它的钉选与存储记录；切回来不会复活。
		await run(() => latest.forgetProject("b"));
		expect(latest.pinned).toBe(true);
		expect(JSON.parse(localStorage.getItem("pid:project-drawer:b")!)).toEqual({
			panel: null,
			pinned: false,
		});
		await rerender({ activeProjectId: "b" });
		expect(latest.pinned).toBe(false);
		expect(latest.panel).toBeNull();
	});

	it("clears a stored git record even when the panel was never restored", async () => {
		// 启动即关 Git：内存里没有 git 面板，存储里却有记录。
		localStorage.setItem(
			"pid:project-drawer:p1",
			JSON.stringify({ panel: "git", pinned: false }),
		);

		await mount({ activeProjectId: "p1", gitEnabled: false });

		expect(latest.panel).toBeNull();
		expect(JSON.parse(localStorage.getItem("pid:project-drawer:p1")!)).toEqual({
			panel: null,
			pinned: false,
		});
	});
});
