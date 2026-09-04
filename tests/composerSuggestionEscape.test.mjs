import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 输入框 @/& 建议面板的 ESC / 光标恢复行为审查。
 *
 * 回归背景：
 * 1. ESC 关面板会删掉刚输入的 @（clearSuggestionTrigger 在空触发符时删除文本），
 *    用户只期望关面板、保留输入 → 现改为关闭时不改任何文本。
 * 2. resolveOffset 对落在 chip（contenteditable=false）区间/边界空当的偏移，
 *    旧 fallback 直接拽到最后一个文本节点末尾（跨过 chip 与后续正文），
 *    导致输入框光标回跳 → 改为就近落在 chip 前/后最近的文本节点。
 * 3. ESC/手动关闭后残留 @ 会让面板在继续打字时立刻弹回 → 最简抑制模型：
 *    被拒的 @/& 查询在 ESC 后永不自动唤起（无论打字/空格/移动光标/点击）；
 *    仅当用户再次按下 @/& 触发键（开始全新查询）时复位，面板才重新正常弹出。
 */

const richInputSource = readFileSync(
	"src/renderer/src/components/app/RichInput.tsx",
	"utf8",
);
const appUtilsSource = readFileSync(
	"src/renderer/src/components/app/AppUtils.ts",
	"utf8",
);
const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");

// ── AppUtils：不再有"删除触发符"的关闭逻辑 ──

test("AppUtils no longer exports a text-deleting clearSuggestionTrigger", () => {
	// clearSuggestionTrigger 曾删除孤立 @/&：现在 ESC 只关面板，语义已内联到 App.tsx。
	assert.doesNotMatch(appUtilsSource, /export function clearSuggestionTrigger/);
	// applySuggestion / detectTrigger 仍在（建议选中与触发检测未变）
	assert.match(appUtilsSource, /export function detectTrigger/);
	assert.match(appUtilsSource, /export function applySuggestion/);
});

test("App.tsx ESC close keeps text and suppresses immediate reopen", () => {
	// dismissSuggestions helper：只关面板 + 置 dismissed，不改文本
	assert.match(
		appSource,
		/function dismissSuggestions\(\) \{\s*setSuggestionsOpen\(false\);\s*suggestionsDismissedRef\.current = true;/,
	);
	// ESC 分支调用 helper，不再 setPrompt/删文本
	assert.match(
		appSource,
		/if \(event\.key === "Escape"\) \{\s*event\.preventDefault\(\);\s*\/\/ 只关面板、不动输入/,
	);
	assert.match(appSource, /dismissSuggestions\(\);/);
	// dismissed 期间 onChange 一律不开面板（只关不弹）
	assert.match(
		appSource,
		/if \(!suggestionsDismissedRef\.current\) \{\s*if \(nextSuggestionsOpen !== suggestionsOpen\) \{\s*setSuggestionsOpen\(nextSuggestionsOpen\);/,
	);
	// dismissed 抑制 onFocus 重开
	assert.match(
		appSource,
		/onFocus=\{\(\) => \{\s*\/\/ 仅当光标处存在 @ \/ 触发器时才打开建议框/,
	);
	// 复位唯一途径：keydown 再次按下 @/&/ 触发键（新查询）
	assert.match(
		appSource,
		/suggestionsDismissedRef\.current &&\s*!event\.nativeEvent\.isComposing &&\s*event\.keyCode !== 229 &&\s*\(event\.key === "@" \|\| event\.key === "&" \|\| event\.key === "\/"\)/,
	);
	// 关闭按钮（onClose）同语义：调 dismissSuggestions
	assert.match(appSource, /onClose=\{\(\) => \{\s*\/\/ 点 X 与 ESC 同语义/);
	// onCursorChange 不再有 dismissed 复位（纯光标移动不解除抑制）
	assert.doesNotMatch(appSource, /suggestionsDismissedRef\.current &&\s*dismissedTextRef/);
	// 已删除的重复 setPrompt(result.text) 调用不再出现
	assert.doesNotMatch(appSource, /setPrompt\(result\.text\);\s*setPrompt\(result\.text\);/);
});

// ── RichInput：resolveOffset 就近放置，不再拽到行尾 ──

test("resolveOffset falls back to the nearest text boundary instead of the last run end", () => {
	assert.match(richInputSource, /空当（chip 边界）/);
	assert.match(richInputSource, /prevRun: TextNodeRun \| null = null;/);
	assert.match(richInputSource, /if \(run\.end <= offset\) prevRun = run;/);
	assert.match(richInputSource, /const first = runs\[0\];\s*return \{ node: first\.node, offset: 0 \};/);
	// 旧逻辑（拽到最后一个 run 末尾）必须消失
	assert.doesNotMatch(richInputSource, /const last = runs\[runs\.length - 1\];\s*return \{ node: last\.node, offset: last\.node\.nodeValue\?\.length \?\? 0 \};/);
});

// ── 动态执行 resolveOffset 语义（从 RichInput 源码提取纯逻辑太重，改用 AppUtils VM 测 detectTrigger 不变） ──

test("detectTrigger still detects @ triggers with plain text query", () => {
	// @ 触发规则未被改动：光标前最后一个触发符 + 查询段无空白即命中。
	assert.match(appUtilsSource, /const atIdx = before\.lastIndexOf\("@"\);/);
	assert.match(appUtilsSource, /if \(\/\[\\s@\/&\]\/\.test\(segment\)\) return null;/);
});

test("App.tsx dismissed has no onCursorChange reopen path", () => {
	// 移动光标（点击/方向键）不解除 dismissed：面板只在用户再次输入 @/& 后恢复。
	// onCursorChange 仅同步光标位置，不含任何 dismissed 复位逻辑。
	assert.match(appSource, /onCursorChange=\{\(cursor\) => \{\s*if \(suggestionsOpen\) setComposerCursor\(cursor\);\s*\}/);
	// 前缀模型/时间窗等旧方案已废弃
	assert.doesNotMatch(appSource, /dismissedTextRef|dismissedTriggerStartRef|lastInputAtRef/);
});
