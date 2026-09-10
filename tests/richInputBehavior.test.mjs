import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadRichInputHelpers() {
  const source = readFileSync("src/renderer/src/components/app/RichInput.tsx", "utf8");
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
          forwardRef: (fn) => fn,
          useCallback: (fn) => fn,
          useLayoutEffect: () => undefined,
          useMemo: (fn) => fn(),
          useRef: (init) => ({ current: init }),
          useState: (init) => [init, () => undefined],
        };
      }
      if (id === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null };
      throw new Error(`Unexpected require: ${id}`);
    },
    window: {},
    document: {},
  };
  vm.runInNewContext(outputText, sandbox, { filename: "RichInput.tsx" });
  return sandbox.exports;
}

/**
 * RichInput 纯 helper 行为（不断言源码文本）：
 * chip 路径往返一致；@ 裸名不成 chip 由 parse 保证（此处锚定 unwrap/format 互逆）。
 */
test("file path format round-trips through unwrap", () => {
  const { formatFilePathRef, unwrapFileChipPath } = loadRichInputHelpers();
  assert.equal(formatFilePathRef("src", { isDirectory: true }), "@src/");
  assert.equal(unwrapFileChipPath("@src/"), "src");
  assert.equal(unwrapFileChipPath('@"my dir/"'), "my dir");
});

test("parses @file chips and skips bare mentions", () => {
  const { parseRichInputChips } = loadRichInputHelpers();
  const chips = parseRichInputChips("看 @src/a.ts 和 @alice");
  const files = chips.filter((c) => c.kind === "file");
  assert.equal(files.length, 1);
  assert.ok(files[0].raw.includes("src/a.ts"));
});
