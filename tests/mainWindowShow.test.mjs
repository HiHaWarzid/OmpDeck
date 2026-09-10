import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule() {
  const source = readFileSync("src/main/linuxDisplayBackend.ts", "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const sandbox = {
    exports: {},
    process: { platform: "linux", env: {}, argv: [] },
    require: (id) => {
      if (id === "electron") {
        return {
          app: {
            disableHardwareAcceleration: () => undefined,
            commandLine: { appendSwitch: () => undefined },
          },
        };
      }
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(outputText, sandbox, { filename: "linuxDisplayBackend.ts" });
  return sandbox.exports;
}

/**
 * 窗口显示决策（行为，不断言 index.ts 文本）：
 * shouldShowMainWindowImmediately 即 isUsingLinuxXWaylandWorkaround(petEnabledAtLaunch)——
 * Linux XWayland 兼容层下跳过隐藏预映射直接 show，避免白屏等待。
 * showMainWindowOnce 的幂等由 Electron once 注册 + hasShownMainWindow 守卫保证。
 */

test("Linux Wayland + 宠物启用时走 X11 直接显示", () => {
  const { getLinuxDisplayBackendSwitches, isUsingLinuxXWaylandWorkaround } = loadModule();
  assert.equal(
    isUsingLinuxXWaylandWorkaround(true),
    getLinuxDisplayBackendSwitches({ petEnabled: true }).some(
      (item) => item.name === "ozone-platform" && item.value === "x11",
    ),
  );
});

test("决策值为布尔量（调用方直接用作 show 标志）", () => {
  const { isUsingLinuxXWaylandWorkaround } = loadModule();
  assert.equal(typeof isUsingLinuxXWaylandWorkaround(false), "boolean");
});
