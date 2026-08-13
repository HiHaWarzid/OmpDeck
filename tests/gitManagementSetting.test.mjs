import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const settingsModal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
const settingsStore = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
// src/shared/types.ts 已拆为按领域 re-export 的 barrel；AppSettings 声明在 types/settings.ts。
const sharedTypes = readFileSync("src/shared/types/settings.ts", "utf8");
const previewApi = readFileSync("src/renderer/src/previewApi.ts", "utf8");
const i18n = readFileSync("src/renderer/src/i18n.ts", "utf8");

describe("optional Git management entry", () => {
  test("persists an upgrade-safe enabled-by-default setting", () => {
    assert.match(sharedTypes, /enableGitManagement:\s*boolean/);
    assert.match(settingsStore, /enableGitManagement:\s*true/);
    assert.match(previewApi, /enableGitManagement:\s*true/);
    assert.match(app, /enableGitManagement:\s*true/);
  });

  test("exposes a localized settings switch", () => {
    assert.match(settingsModal, /title=\{t\("settings\.gitManagement"\)\}/);
    assert.match(settingsModal, /description=\{t\("settings\.gitManagementDesc"\)\}/);
    assert.match(settingsModal, /updateDraft\(\{ enableGitManagement: checked \}\)/);
    assert.equal(i18n.match(/"settings\.gitManagement":/g)?.length, 2);
    assert.equal(i18n.match(/"settings\.gitManagementDesc":/g)?.length, 2);
  });

  test("places Git beside Files in the drawer tool tabs", () => {
    // 意图变化：Git 入口从会话区浮层工具按钮重设计为右侧抽屉工具 Tab，
    // 仍与 Files Tab 并列，且由 enableGitManagement 开关整体控制（旧 GIT_LOGO_URL 已删除）。
    assert.match(app, /onClick=\{\(\) => switchToolDrawer\("files"\)\}/);
    assert.match(app, /settings\.enableGitManagement && \(\s*<button[\s\S]*?switchToolDrawer\("git"\)/);
    assert.match(app, /t\("drawer\.tabGit"\)/);
    assert.doesNotMatch(app, /GIT_LOGO_URL/);
    assert.doesNotMatch(app, /git-entry-logo/);
  });

  test("removes the old header button and guards the drawer", () => {
    assert.doesNotMatch(app, /title="Git History & Compare"/);
    assert.match(app, /if \(panel === "git" && !settings\.enableGitManagement\) return/);
    assert.match(app, /drawerContentPanel === "git" && settings\.enableGitManagement && \(/);
    assert.match(app, /current === "git" \? null : current/);
    assert.match(app, /filter\(\(\[, panel\]\) => panel !== "git"\)/);
  });
});
