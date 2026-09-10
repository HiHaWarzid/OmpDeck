import assert from "node:assert/strict";
import test from "node:test";

/**
 * @/& 建议抑制模型（纯状态机，不读 App 源码）：
 * dismissed 一旦置位，打字/空格/移动光标/点击都不解除；
 * 仅当用户再次按下 @/&// 触发键（且非 IME 合成）时复位。
 * App.dismissSuggestions/handleComposerKeyDown 实现此语义（src/renderer/src/App.tsx）。
 */

function createDismissModel() {
  let dismissed = false;
  return {
    dismiss() { dismissed = true; },
    keyDown({ key, isComposing = false, keyCode = 0 }) {
      if (dismissed && !isComposing && keyCode !== 229 && (key === "@" || key === "&" || key === "/")) {
        dismissed = false;
      }
      return dismissed;
    },
    get dismissed() { return dismissed; },
  };
}

test("dismiss 后打字与移动光标不解除抑制", () => {
  const m = createDismissModel();
  m.dismiss();
  assert.equal(m.dismissed, true);
  // 普通字符 / 空格 / 方向键都不复位
  for (const key of ["a", " ", "ArrowLeft", "Enter"]) {
    m.keyDown({ key });
    assert.equal(m.dismissed, true, `${key} 不应解除抑制`);
  }
});

test("再次按下触发键复位，IME 合成中不算", () => {
  const m = createDismissModel();
  m.dismiss();
  // IME 合成中按 @ 不算新查询
  m.keyDown({ key: "@", isComposing: true });
  assert.equal(m.dismissed, true);
  m.keyDown({ key: "@", keyCode: 229 });
  assert.equal(m.dismissed, true);
  // 真实触发键复位
  for (const key of ["@", "&", "/"]) {
    m.dismiss();
    m.keyDown({ key });
    assert.equal(m.dismissed, false, `${key} 应解除抑制`);
  }
});
