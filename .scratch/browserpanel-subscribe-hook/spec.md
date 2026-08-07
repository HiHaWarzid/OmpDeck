# refactor: replace BrowserPanel module-state polling with subscribe hook

**Labels**: `ready-for-agent`

---

## Problem Statement

BrowserPanel uses a module-level mutable state object (`moduleState`) plus a 50ms `setInterval` poll to receive external navigation requests from `navigateTo`. This causes three problems:

1. **Permanent polling** - the 50ms interval runs forever, even when the browser panel is idle and no navigation will ever occur.
2. **Double bookkeeping** - React `useState` mirrors `moduleState` by hand (`persistTabs`, `updateActiveTab`, `switchTab`, `closeTab` all write to both), creating sync bugs.
3. **Leaky module state** - `moduleState` is exported and read/written directly by `App.tsx`, coupling the component's internals to its consumer.

## Solution

Replace the module-level mutable state and polling with a `useBrowserTabs` hook (internal `useRef` for cross-mount persistence) and a subscription-based `navigateTo` (module-level `Set<callback>` + `pendingUrl` fallback). Eliminate `moduleState` entirely.

## User Stories

1. As a developer, I want BrowserPanel to stop polling when idle, so that the app doesn't waste CPU on a 50ms interval that does nothing.
2. As a developer, I want tab state to live in a single source of truth inside a hook, so that I don't have to manually mirror module state into React state.
3. As a developer, I want `navigateTo` to notify the BrowserPanel via a callback subscription, so that navigation happens immediately instead of waiting up to 50ms for the next poll.
4. As a developer, I want `navigateTo` to queue the URL when BrowserPanel is unmounted, so that opening the browser panel later still loads the requested page.
5. As a developer, I want `moduleState` to no longer be exported, so that App.tsx cannot reach into BrowserPanel's internal state.
6. As a user, I want browser tabs to persist when I collapse and re-open the browser drawer, so that I don't lose my open pages.
7. As a user, I want the device mode (PC/mobile/tablet) to persist when I collapse and re-open the browser drawer, so that I don't have to re-select it.
8. As a user, I want external links (from agent events, file previews) to open in a new browser tab immediately, so that I don't wait for a poll cycle.
9. As a user, I want navigating to a new URL while a page is loading to interrupt the current load, so that I'm not stuck waiting.
10. As a developer, I want the dead `navigateKey` field removed, so that there's no confusing unused state in the codebase.
11. As a developer, I want `navigateTo`'s function signature to stay `(url: string) => void`, so that App.tsx call sites don't change.
12. As a developer, I want BrowserPanel's JSX/UI structure to stay unchanged, so that the refactor is purely state-management.

## Implementation Decisions

- **`useBrowserTabs` hook** - new hook internal to BrowserPanel. Uses a single `useRef<{ tabs, activeTabId, device }>` for cross-mount persistence (survives drawer collapse/expand and fullscreen toggle). `useState` mirrors trigger re-renders.

- **Subscription-based `navigateTo`** - module-level function, signature unchanged `(url: string) => void`. Internally: sets module-level `pendingUrl`, then calls all registered subscribers. If no subscribers (BrowserPanel unmounted), `pendingUrl` remains for consumption on mount.

- **Subscriber registration** - BrowserPanel registers a callback on mount (via `useEffect`) that: (a) checks `pendingUrl` for a queued request, (b) receives future `navigateTo` calls directly. Unregisters on unmount.

- **Tab creation on navigate** - `navigateTo` does NOT create tabs. It only sets `pendingUrl` + notifies. The hook's subscriber callback creates the new tab and calls `webview.loadURL`.

- **No load-queueing** - `webview.loadURL` is called directly on navigation. Electron webview automatically interrupts the current load. The only queueing is DOM-ready: if the webview hasn't fired `dom-ready` yet, the URL is held in a ref and consumed on the `dom-ready` event.

- **`moduleState` fully eliminated** - no module-level mutable state object. All state lives inside the hook's ref. `moduleState` export is removed.

- **`navigateKey` deleted** - dead field. Was incremented by `navigateTo`, reset to 0 by the poll and by App.tsx, but never read by any `useEffect` dependency or conditional. Full deletion.

- **App.tsx changes** - remove `moduleState` from import (keep `navigateTo` + `BrowserPanel`). Delete the 2 lines reading/writing `moduleState.navigateKey` (around line 6556). Two `navigateTo(url)` call sites remain unchanged.

- **`device` persistence** - device mode stays in the ref object, preserving current cross-mount behavior.

## Testing Decisions

- **What makes a good test** - test external behavior through the `navigateTo` + hook seam. Do not test internal ref shape or useState calls. Verify: (a) navigateTo with a mounted subscriber triggers navigation, (b) navigateTo without a subscriber queues to pendingUrl, (c) subscriber registration on mount consumes pendingUrl, (d) unmount removes subscriber, (e) tab/device state survives unmount/remount.

- **Modules tested** - the `navigateTo` module-level function and the `useBrowserTabs` hook's subscription/persistence behavior. webview DOM events are not testable in jsdom and are out of scope.

- **Prior art** - `useFeishuBridge` hook in the renderer follows a similar pattern (IPC subscription + state ownership + cleanup on unmount). The existing test pattern in `src/main/pi/messageTimeline.test.ts` and `src/main/sessions/importPipeline.test.ts` uses `node:test` + `node:assert/strict` with no DOM dependencies.

## Out of Scope

- BrowserPanel JSX/UI structure changes
- webview event handler logic (did-navigate, page-title-updated, etc.)
- `navigateTo` signature changes
- Other BrowserPanel consumers beyond App.tsx
- The WSL FileAdapter candidate (#4)
- The IPC seam deepening candidate (#3)
- The App.tsx state extraction candidate (#5)

## Further Notes

This is candidate 6 from the architecture review report. It is the smallest and most self-contained of the 6 deepening candidates. The `useFeishuBridge` hook is the proven pattern to imitate.
