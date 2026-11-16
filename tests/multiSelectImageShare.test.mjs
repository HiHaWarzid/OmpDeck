import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadTimelineProjection() {
  const source = readFileSync("src/renderer/src/components/app/timeline/timelineProjection.ts", "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  // 运行时导入只有 thinkingTiming 与 ../format（其余为 type-only，转译后消除）。
  // 被测的 getMultiSelectImageCaptureIds 不经过两者，但同一模块里的分组函数会用到，
  // 因此仍给最小 stub 保证模块可求值。
  const require = (id) => {
    if (id === "../../../utils/thinkingTiming") return { computeThinkingTiming: () => 0 };
    if (id === "../format")
      return { stripAnsi: (v) => String(v ?? ""), stripThinkingTags: (v) => String(v ?? "") };
    throw new Error(`unexpected import in timelineProjection: ${id}`);
  };
  const sandbox = { exports: {}, require, location: { href: "file:///Users/test/app" } };
  vm.runInNewContext(outputText, sandbox, { filename: "timelineProjection.ts" });
  return sandbox.exports;
}

test("multi-select image export stays renderable for html-to-image", () => {
  const styles = readFileSync("src/renderer/src/styles.css", "utf8");
  const rule = styles.match(/\.multi-select-image-export \{([\s\S]*?)\n\}/)?.[1] ?? "";

  assert.match(rule, /left:\s*0;/);
  assert.doesNotMatch(rule, /-100000px/);
});

test("multi-select image export maps selected assistant messages to their visible run rows", () => {
  const { getMultiSelectImageCaptureIds } = loadTimelineProjection();
  const user = { kind: "message", message: { id: "u1", role: "user", text: "hi", timestamp: 1 } };
  const run = {
    kind: "agent-run",
    id: "run-1",
    startedAt: 2,
    endedAt: 3,
    items: [
      { kind: "message", message: { id: "a1", role: "assistant", text: "first", timestamp: 2 } },
      { kind: "message", message: { id: "a2", role: "assistant", text: "second", timestamp: 3 } },
    ],
  };

  const ids = getMultiSelectImageCaptureIds([user, run], new Set(["u1", "a2"]));

  assert.deepEqual([...ids], ["u1", "run-1"]);
});
