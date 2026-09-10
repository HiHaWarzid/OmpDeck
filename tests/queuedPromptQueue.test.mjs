import assert from "node:assert/strict";
import test from "node:test";

import { setI18nLocale, t } from "../src/renderer/src/i18n.ts";
import { mergeAgentRuntimeState } from "../src/renderer/src/utils/agentRuntimeState.ts";

test("retract edit uses action-oriented copy", () => {
  setI18nLocale("zh-CN");
  assert.equal(t("app.retractToInput"), "撤回修改");
  setI18nLocale("en-US");
  assert.equal(t("app.retractToInput"), "Retract to edit");
});

test("queued image count uses the standard i18n interpolation syntax", () => {
  setI18nLocale("zh-CN");
  assert.equal(t("app.queuedImageCount", { count: 3 }), "3 图");
  setI18nLocale("en-US");
  assert.equal(t("app.queuedImageCount", { count: 3 }), "3 img");
});

test("runtime state merge rejects stale tool edges without losing non-tool fields", () => {
  const current = {
    modelId: "new-model",
    isExecutingTool: false,
    toolStateSequence: 4,
  };
  const merged = mergeAgentRuntimeState(current, {
    modelName: "Updated name",
    isExecutingTool: true,
    executingToolName: "read",
    toolStateSequence: 3,
  });

  assert.equal(merged.modelName, "Updated name");
  assert.equal(merged.modelId, "new-model");
  assert.equal(merged.isExecutingTool, false);
  assert.equal(merged.executingToolName, undefined);
  assert.equal(merged.toolStateSequence, 4);
});
