import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hook = readFileSync("src/renderer/src/hooks/useAgentSessions.ts", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const i18n = readFileSync("src/renderer/src/i18n.ts", "utf8");
const scanner = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");

// refreshProjectSessions 在 hook 抽取后位于 useAgentSessions.ts（函数体用 tab 缩进）。
function refreshProjectSessionsBlock() {
  const match = hook.match(
    /async function refreshProjectSessions\(projectId: string, silent = false\) \{[\s\S]*?\n\t\}/,
  );
  assert.ok(match, "refreshProjectSessions implementation should be discoverable in useAgentSessions");
  return match[0];
}

function refreshSessionsBlock() {
  const match = hook.match(/async function refreshSessions\(projectId = activeProjectId, silent = false\) \{[\s\S]*?\n\t\}/);
  assert.ok(match, "refreshSessions implementation should be discoverable in useAgentSessions");
  return match[0];
}

test("queues every refresh collision instead of dropping user-triggered refreshes", () => {
  const block = refreshProjectSessionsBlock();
  assert.match(
    block,
    /if \(sessionRefreshRunningRef\.current\.has\(projectId\)\) \{[\s\S]*?sessionRefreshPendingRef\.current\.add\(projectId\);\s*if \(!silent\) \{[\s\S]*?setSessionLoadingByProject[\s\S]*?\}\s*return;/,
  );
  assert.doesNotMatch(block, /if \(silent\) sessionRefreshPendingRef\.current\.add\(projectId\)/);
  assert.match(block, /if \(sessionRefreshPendingRef\.current\.delete\(projectId\)\)/);
});

test("bounds session list requests so a hung scan releases the single-flight lock", () => {
  const block = refreshProjectSessionsBlock();
  assert.match(hook, /const SESSION_REFRESH_TIMEOUT_MS = 20_000;/);
  // 超时保护收敛到 listSessionsWithRetry：同一常量 + 仅对非静默刷新在超时后重试一次
  // （主进程按扫描根共享进行中的扫描，重试会复用结果而不是叠加一轮新扫描）。
  assert.match(
    hook,
    /async function listSessionsWithRetry[\s\S]*?withTimeout\(\s*api\.sessions\.list\(projectId\),\s*SESSION_REFRESH_TIMEOUT_MS,\s*timeoutMsg,?\s*\)/,
  );
  assert.match(hook, /if \(!silent && error instanceof Error && error\.message === timeoutMsg\)/);
  assert.match(block, /const next = await listSessionsWithRetry\(projectId, silent\);/);
  assert.match(block, /finally \{[\s\S]*?sessionRefreshRunningRef\.current\.delete\(projectId\)/);
  assert.match(i18n, /"app\.sessionRefreshTimeout"/g);
  // 主进程 watchdog：18s 早于 renderer 的 20s，超时会真正终止底层扫描。
  assert.match(scanner, /private scanTimeoutMs = 18_000;/);
  assert.match(scanner, /new AbortController\(\)/);
  assert.match(scanner, /controller\.abort\(new Error\("Session scan timed out"\)\)/);
  assert.match(scanner, /clearTimeout\(scanTimer\)/);
  assert.match(scanner, /collectFromRoots\(scanRoots, signal\)/);
  // 并发 list() 按扫描根共享同一轮扫描，过滤逐调用方进行。
  assert.match(scanner, /private readonly listInFlightByKey = new Map<string, Promise<SessionSummary\[\]>>\(\);/);
  assert.match(scanner, /private scanShared\(scanRoots: string\[\]\)/);
  assert.match(scanner, /private async filterByProject\(summaries: SessionSummary\[\], projectPath: string\)/);
});

test("stale project responses cannot overwrite the sessions drawer list", () => {
  const block = refreshSessionsBlock();
  // 按项目编号请求：快速切换项目时，旧项目的慢响应被序号丢弃。
  assert.match(block, /sessionListSeqRef\.current\[key\] !== request/);
  assert.match(hook, /const sessionListSeqRef = useRef<Record<string, number>>\(\{\}\)/);
});

test("failed project refresh surfaces an error state with a retry entry point", () => {
  const block = refreshProjectSessionsBlock();
  assert.match(block, /setSessionErrorByProject\(\(current\) => \(\{ \.\.\.current, \[projectId\]: msg \}\)/);
  assert.match(block, /setSessionErrorByProject\(\(current\) => \{[\s\S]*?delete next\[projectId\]/);
  assert.match(hook, /const \[sessionErrorByProject, setSessionErrorByProject\] = useState<[\s\S]*?\(\{\}\)/);
  // 侧栏渲染错误行与重试按钮。
  assert.match(app, /sidebar-session-status-row error/);
  assert.match(app, /t\("app\.projectSessionsLoadFailed"\)/);
  assert.match(app, /onClick=\{\(\) => void refreshProjectSessions\(project\.id\)/);
  assert.match(i18n, /"app\.projectSessionsLoadFailed"/g);
});

test("sessions drawer refreshes when the panel becomes active", () => {
  // 抽屉面板随项目从 localStorage 恢复：恢复时同步归属项目 + 激活即刷新，
  // 避免展示上一个项目的残留列表或空列表。
  assert.match(app, /if \(panel === "sessions"\) \{[\s\S]*?setSessionsProjectId\(projectId\);/);
  assert.match(
    app,
    /if \(drawer === "sessions" && !drawerCollapsed && sessionsProjectId\) \{[\s\S]*?void refreshSessions\(sessionsProjectId\);/,
  );
});
