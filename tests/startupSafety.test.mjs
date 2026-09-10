import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadBrowserApiModule() {
  const source = readFileSync("src/renderer/src/browserApi.ts", "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const sandbox = {
    exports: {},
    require: (specifier) => {
      if (specifier === "./i18n") return { t: (key) => key };
      if (specifier === "./previewApi") {
        return {
          createPreviewApi: () => ({
            projects: { list: async () => [{ id: "preview-project" }] },
            agents: {
              list: async () => [{ id: "preview-agent" }],
              onState: () => () => undefined,
              onMessages: () => () => undefined,
            },
            sessions: { list: async () => [] },
            settings: { get: async () => ({ webServiceEnabled: false }) },
          }),
        };
      }
      throw new Error(`Unexpected require: ${specifier}`);
    },
    window: { setInterval: () => 1, clearInterval: () => undefined },
  };
  vm.runInNewContext(outputText, sandbox, { filename: "browserApi.ts" });
  return sandbox.exports;
}

/**
 * 启动安全（行为，不断言源码文本）：
 * web state 非法时保留 fallback 列表，不抛、不吞空。
 */
test("browser API keeps fallback lists on invalid web state", async () => {
  const { createBrowserApi } = loadBrowserApiModule();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200, statusText: "OK",
    json: async () => ({ projects: "nope", agents: null }),
  });
  const api = createBrowserApi();
  try {
    const projects = await api.projects.list();
    const agents = await api.agents.list();
    assert.deepEqual(projects, [{ id: "preview-project" }]);
    assert.deepEqual(agents, [{ id: "preview-agent" }]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("extensions tab resolves API lazily through window.piDesktop", async () => {
  // getExtensionsApi 在模块内非导出：行为锚点是"模块加载时不读 window"。
  // VM 无 window 下转译加载 ExtensionsTab 不应抛（读 API 延迟到事件处理）。
  const source = readFileSync("src/renderer/src/config/ExtensionsTab.tsx", "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const sandbox = {
    exports: {},
    require: (id) => {
      if (id === "react") {
        return {
          useEffect: () => undefined,
          useState: (init) => [init, () => undefined],
        };
      }
      if (id === "react/jsx-runtime") return {};
      if (id === "lucide-react") return new Proxy({}, { get: () => () => null });
      if (id === "../i18n") return { t: (key) => key };
      if (id === "../utils/notice") return { showNotice: () => undefined };
      if (id === "../utils/clipboard") return { writeClipboard: async () => true };
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  // 无 window 全局：顶层求值不得触碰 window.piDesktop
  assert.doesNotThrow(() => vm.runInNewContext(outputText, sandbox, { filename: "ExtensionsTab.tsx" }));
  assert.equal(typeof sandbox.exports.ExtensionsTab, "function");
});
