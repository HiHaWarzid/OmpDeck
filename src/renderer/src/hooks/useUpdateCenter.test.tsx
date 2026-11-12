// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useUpdateCenter,
  type UpdateCenter,
  type UpdateCenterDeps,
} from "./useUpdateCenter";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type Api = UpdateCenterDeps["api"];

function makeApi(overrides: Partial<Api["app"]> = {}): Api {
  return {
    app: {
      checkUpdate: vi.fn(async () => ({
        currentVersion: "1.0.0",
        latestVersion: "1.0.0",
        hasUpdate: false,
        releaseName: "",
        releaseNotes: "",
        releaseUrl: "https://example.test/release",
        assets: [],
        ...overrides.checkUpdate,
      })) as Api["app"]["checkUpdate"],
      downloadUpdate: vi.fn(async () => ({ filePath: "/tmp/setup.exe" })),
      installUpdate: vi.fn(async () => undefined),
      openExternal: vi.fn(async () => undefined),
      ...overrides,
    },
    pi: {
      checkUpdate: vi.fn(async () => ({ hasUpdate: false })),
      update: vi.fn(async () => ({ command: "npm i -g omp", output: "ok", updated: true })),
    },
  };
}

let container: HTMLDivElement;
let root: Root;
let center: UpdateCenter;
let toasts: string[];

function makeDeps(api: Api, extra: Partial<UpdateCenterDeps> = {}): UpdateCenterDeps {
  return {
    api,
    showToast: (message: string) => toasts.push(message),
    disableUpdateCheck: false,
    releasesUrl: "https://example.test/releases",
    ...extra,
  };
}

async function renderHook(deps: UpdateCenterDeps) {
  function Probe() {
    center = useUpdateCenter(deps);
    return null;
  }
  await act(async () => root.render(<Probe />));
}

beforeEach(() => {
  toasts = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("useUpdateCenter", () => {
  it("手动检查且已是最新：暴露当前版本并给出一次提示", async () => {
    const api = makeApi();
    await renderHook(makeDeps(api));

    await act(async () => {
      await center.checkAppUpdate("manual");
    });

    expect(center.app.upToDateVersion).toBe("1.0.0");
    expect(center.app.info).toBeNull();
    expect(center.app.checking).toBe(false);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("1.0.0");
  });

  it("手动检查失败落错误态；自动检查失败保持静默", async () => {
    const api = makeApi();
    api.app.checkUpdate = vi.fn(async () => {
      throw new Error("network down");
    });
    await renderHook(makeDeps(api));

    await act(async () => {
      await center.checkAppUpdate("auto");
    });
    expect(center.app.error).toBeNull();
    expect(toasts).toHaveLength(0);

    await act(async () => {
      await center.checkAppUpdate("manual");
    });
    expect(center.app.error).toBe("network down");
    expect(center.app.checking).toBe(false);
    expect(toasts.some((message) => message.includes("network down"))).toBe(true);
  });

  it("禁用版本检测时两种检查都不发请求", async () => {
    const api = makeApi();
    await renderHook(makeDeps(api, { disableUpdateCheck: true }));

    await act(async () => {
      await center.checkAppUpdate("manual");
      await center.checkPiCliUpdate();
    });

    expect(api.app.checkUpdate).not.toHaveBeenCalled();
    expect(api.pi.checkUpdate).not.toHaveBeenCalled();
  });

  it("无推荐安装包时下载退化为打开 release 页面", async () => {
    const api = makeApi();
    await renderHook(makeDeps(api));

    await act(async () => {
      await center.downloadAppUpdate();
    });

    expect(api.app.downloadUpdate).not.toHaveBeenCalled();
    expect(api.app.openExternal).toHaveBeenCalledWith("https://example.test/releases");
  });

  it("下载进度 completed 交付路径、failed 落错误并解锁按钮", async () => {
    await renderHook(makeDeps(makeApi()));

    await act(async () => {
      center.ingestAppUpdateProgress({
        assetName: "setup.exe",
        receivedBytes: 10,
        state: "completed",
        filePath: "/tmp/setup.exe",
      });
    });
    expect(center.app.downloadedPath).toBe("/tmp/setup.exe");
    expect(center.app.downloading).toBe(false);

    await act(async () => {
      center.ingestAppUpdateProgress({
        assetName: "setup.exe",
        receivedBytes: 5,
        state: "failed",
        error: "socket hang up",
      });
    });
    expect(center.app.error).toBe("socket hang up");
    expect(center.app.downloading).toBe(false);
  });

  it("pi 升级成功后复检环境并刷新版本信息", async () => {
    const api = makeApi();
    const onPiUpdated = vi.fn(async () => undefined);
    await renderHook(makeDeps(api, { onPiUpdated }));

    await act(async () => {
      await center.updatePiCli();
    });

    expect(onPiUpdated).toHaveBeenCalledTimes(1);
    expect(center.pi.lastResult).toEqual({
      command: "npm i -g omp",
      output: "ok",
      updated: true,
    });
    expect(center.pi.lastCheck).toEqual({ hasUpdate: false });
    expect(center.pi.updating).toBe(false);
  });
});
