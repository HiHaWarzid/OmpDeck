## Parent

#1

## What to build

Replace BrowserPanel's module-level mutable state and 50ms polling with a `useBrowserTabs` hook (useRef persistence) and subscription-based `navigateTo` (Set<callback> + pendingUrl fallback). Eliminate `moduleState` entirely. Delete the dead `navigateKey` field. Update App.tsx to remove moduleState import and navigateKey reads.

This is a single coherent change: extract the hook, wire the subscription, delete the polling, delete moduleState, update App.tsx, add tests. No prefactor needed -- the subscription mechanism and moduleState elimination land together.

## Acceptance criteria

- [ ] `useBrowserTabs` hook uses single `useRef<{ tabs, activeTabId, device }>` for cross-mount persistence, useState mirrors trigger re-renders
- [ ] Module-level `navigateTo(url)` uses `Set<(url: string) => void>` subscribers + `pendingUrl` fallback; signature unchanged `(url: string) => void`
- [ ] BrowserPanel registers subscriber on mount (consumes pendingUrl + receives future navigateTo calls), unregisters on unmount
- [ ] Subscriber callback creates new tab + calls `webview.loadURL` directly (webview auto-interrupts current load)
- [ ] DOM-ready queueing: if webview not ready, URL held in ref, consumed on dom-ready event
- [ ] 50ms `setInterval` polling deleted
- [ ] `moduleState` export deleted, `navigateKey` field deleted
- [ ] App.tsx: remove `moduleState` from import, delete `moduleState.navigateKey` read/write (2 lines), `navigateTo` calls unchanged
- [ ] Tab/device state survives unmount/remount (collapse/expand drawer)
- [ ] Tests: navigateTo with subscriber triggers callback, without subscriber queues to pendingUrl, mount consumes pendingUrl, unmount removes subscriber, state persists across remount
- [ ] `npm run typecheck` passes

## Blocked by

- None - can start immediately. (Parent spec: #1)
