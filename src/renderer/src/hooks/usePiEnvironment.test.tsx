// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, PiInstallStatus } from "../../../shared/types";
import { usePiEnvironment, type PiEnvironment, type PiEnvironmentDeps } from "./usePiEnvironment";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Api = PiEnvironmentDeps["api"];

function installed(command = "pi"): PiInstallStatus {
  return { installed: true, command, version: "1.0.0", searchedDirs: [] };
}

function makeSettings(patch: Partial<AppSettings> = {}): AppSettings {
  return patch as AppSettings;
}

function makeApi(): Api {
  return {
    pi: {
      check: vi.fn(async () => installed()),
      checkCustom: vi.fn(async () => installed("/opt/pi")),
      checkNpm: vi.fn(async () => ({ available: true, version: "10.0.0" })),
      execInstall: vi.fn(async () => ({
        success: true,
        exitCode: 0,
        stdout: "installed",
        stderr: "",
      })),
    },
    settings: {
      get: vi.fn(async () => makeSettings({ customPiPath: "/opt/pi" })),
      update: vi.fn(async () => makeSettings({ piEnvironmentChecked: true })),
    },
  };
}

let container: HTMLDivElement;
let root: Root;
let env: PiEnvironment;
let saved: AppSettings[];
let toasts: string[];
let failedInline: number;

async function renderHook(api: Api, extra: Partial<PiEnvironmentDeps> = {}) {
  function Probe() {
    env = usePiEnvironment({
      api,
      showToast: (message: string) => toasts.push(message),
      onSettingsSaved: (next) => saved.push(next),
      onInlineCheckFailed: () => (failedInline += 1),
      ...extra,
    });
    return null;
  }
  await act(async () => root.render(<Probe />));
}

beforeEach(() => {
  saved = [];
  toasts = [];
  failedInline = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("usePiEnvironment", () => {
  it("启动检测通过：落盘一次环境标记并打开检测弹框", async () => {
    const api = makeApi();
    await renderHook(api);

    await act(async () => {
      await env.check("startup");
    });

    expect(api.settings.update).toHaveBeenCalledWith({ piEnvironmentChecked: true });
    expect(saved).toHaveLength(1);
    expect(env.status?.installed).toBe(true);
    expect(env.dialogOpen).toBe(true);
    expect(env.checking).toBe(false);
  });

  it("内联复检失败：提示安装指引并通知 App 让出弹框位置", async () => {
    const api = makeApi();
    api.pi.check = vi.fn(async () => ({
      installed: false,
      searchedDirs: [],
      error: "not found",
    }));
    await renderHook(api);

    await act(async () => {
      await env.checkInline();
    });

    expect(failedInline).toBe(1);
    expect(env.dialogOpen).toBe(true);
    expect(saved).toHaveLength(0);
    expect(toasts).toHaveLength(0);
  });

  it("校验自定义路径成功：回读归一化路径并回灌设置", async () => {
    const api = makeApi();
    await renderHook(api);

    await act(async () => {
      env.setCustomPath("  /opt/pi  ");
    });
    await act(async () => {
      await env.validateCustomPath();
    });

    expect(api.pi.checkCustom).toHaveBeenCalledWith("/opt/pi");
    expect(env.customPath).toBe("/opt/pi");
    expect(saved).toHaveLength(1);
    expect(toasts).toHaveLength(1);
  });

  it("用户手动改过路径后，检测结果不再覆盖输入框", async () => {
    const api = makeApi();
    await renderHook(api);

    await act(async () => {
      env.setCustomPath("/custom/pi");
    });
    await act(async () => {
      await env.check("manual");
    });

    expect(env.customPath).toBe("/custom/pi");
  });

  it("检测到 pi 且用户未编辑时自动回填检测路径", async () => {
    const api = makeApi();
    await renderHook(api);

    await act(async () => {
      await env.check("manual");
    });

    expect(env.customPath).toBe("pi");
  });

  it("镜像开关与安装命令文本保持同步", async () => {
    await renderHook(makeApi());

    await act(async () => env.toggleInstallMirror());
    expect(env.installUseMirror).toBe(true);
    expect(env.installCommand).toContain("--registry=https://registry.npmmirror.com");

    await act(async () => env.toggleInstallMirror());
    expect(env.installUseMirror).toBe(false);
    expect(env.installCommand).not.toContain("--registry=");
  });

  it("安装命令退出码为 0 才算安装完成", async () => {
    const api = makeApi();
    await renderHook(api);

    await act(async () => {
      await env.execInstallCommand();
    });
    expect(env.installCompleted).toBe(true);

    api.pi.execInstall = vi.fn(async () => ({
      success: false,
      exitCode: 1,
      stdout: "",
      stderr: "EACCES",
    }));
    await act(async () => {
      await env.execInstallCommand();
    });
    expect(env.installCompleted).toBe(false);
    expect(env.installResult?.exitCode).toBe(1);
    expect(env.installExecuting).toBe(false);
  });
});
