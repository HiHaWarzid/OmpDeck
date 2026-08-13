import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const styles = readFileSync("src/renderer/src/styles.css", "utf8");

function cssRule(selector) {
  return styles.match(new RegExp(`${selector} \\{([\\s\\S]*?)\\n\\}`))?.[1];
}

test("通知走统一 sonner toast，而非锚定在新会话控件下方的自制浮层", () => {
  // 意图变化（9d505dc）：通知统一迁移到 sonner 全局 toast。
  // UiRequest notify 经 showNotice 进入 toast；App 根部渲染 <Toaster />。
  // 旧的自制 .app-notice 锚定浮层（position:absolute; top:calc(100% + 20px)）样式已删除。
  assert.match(app, /showNotice\(notifyRequest\.message/);
  assert.match(app, /<Toaster \/>/);

  const notice = cssRule("\\.app-notice");
  if (notice) {
    assert.doesNotMatch(notice, /position:\s*absolute;/);
    assert.doesNotMatch(notice, /top:\s*calc\(100% \+ 20px\);/);
  }
});
