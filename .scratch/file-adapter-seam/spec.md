# refactor: extract FileAdapter seam in SessionScanner (WSL + Local)

**Labels**: `ready-for-agent`

---

## Problem Statement

SessionScanner (1295 lines) mixes WSL and local file access with two forms of duplication:

1. **WSL command boilerplate** - 10 methods (`readWslFile`, `readWslFileHead`, `writeWslFile`, `readWslFileVersion`, `deleteWslFile`, `copyWslFile`, `existsWslFile`, `existsWslDir`, `collectWslJsonl`, `deleteWslSiblingDir`) each repeat `execFile(wsl.exe, ["-d", distro, "-u", user, ...])` with the same distro/user/shell/timeout scaffolding.

2. **Leaky environment ternaries** - 7 call sites branch on `isWslPath(filePath) ? wslMethod(x) : localFsMethod(x)`, mixing async (`readFile`/`stat`/`writeFile`) and sync (`readFileSync`/`existsSync`/`statSync`) access. The environment concern leaks into business logic.

## Solution

Extract a `FileAdapter` interface with two implementations - `LocalFileAdapter` (wraps `node:fs/promises`) and `WslFileAdapter` (wraps `wsl.exe`). SessionScanner receives one injected adapter selected at `configureWsl()` time. Business code stops branching on environment.

## User Stories

1. As a developer, I want WSL file operations to share one command-boilerplate implementation, so that distro/user/shell/timeout scaffolding is written once not ten times.
2. As a developer, I want session scan/rename/delete/copy to stop branching on `isWslPath`, so that business logic reads as a single path.
3. As a developer, I want file access to be uniformly async, so that I don't have to reason about sync/async mixing.
4. As a developer, I want `wsl.exe` path resolution to stay at the call site, so that the adapter is constructible with injected values for testing.
5. As a developer, I want the adapter to accept `AbortSignal` on both implementations, so that scan timeouts terminate underlying operations.
6. As a developer, I want the adapter methods to be unit-testable with a mocked execFile, so that WSL command argument construction is verified without a real WSL environment.
7. As a developer, I want LocalFileAdapter to be testable against a real temp directory, so that its fs/promises wrapping is verified.

## Implementation Decisions

- **`FileAdapter` interface** - ten methods: `read`, `readHead`, `write`, `stat`, `exists`, `existsDir`, `rm`, `rmDir`, `copy`, `collectJsonl`. Methods that participate in scan-timeout take `signal?: AbortSignal`.

- **`LocalFileAdapter`** - wraps `node:fs/promises`: `readFile`/`writeFile`/`stat`/`unlink`/`rm`/`copyFile`/`readdir`+`stat`. `stat` returns `{ mtimeMs, size }` matching the WSL `stat -c "%Y %s"` shape. `collectJsonl` recursive scan mirrors `find -name "*.jsonl" -type f`.

- **`WslFileAdapter`** - wraps `execFile(wsl.exe, ["-d", distro, "-u", user, ...])` for each of the ten operations. Constructor takes `{ distro, user, wslExePath, wslShell }`. Timeouts: read/write 10s, head/stat/exists/rm/copy/collect 5s (preserving current values).

- **Seam location** - `src/main/fs/adapters/` alongside the existing `FileSystemService` in `src/main/fs/`.

- **SessionScanner wiring** - `configureWsl(environment)` creates the appropriate adapter: `wslConfig ? new WslFileAdapter({...}) : new LocalFileAdapter()`. `clearWsl()` resets to `LocalFileAdapter`. The private `wslConfig` field stays for path semantics (`wslSessionsDir`, `toWslLinuxPath`), but file operations route through the injected `fileAdapter`.

- **Sync call sites migrate to async** - `readFileSync` (readSessionRawText path), `existsSync` (resolveScanRoots), `statSync` become `await this.fileAdapter.read/stat`. The `nextCopyPath` WSL existence check short-circuit stays.

- **`resolveWslExe()` stays in SessionScanner** - environment probing (`process.arch`, `SystemRoot`) is not file-access concern. Result injected into adapter constructor.

## Testing Decisions

- **What makes a good test** - verify external adapter behavior: WSL command argument construction (mock execFile, assert `["-d", distro, "-u", user, "cat", path]` shapes) and Local adapter real file operations against temp dirs.

- **Modules tested** - `WslFileAdapter` (mocked execFile, verify command + args + timeout per method), `LocalFileAdapter` (real temp dir: read/write/stat/exists/rm/copy/collectJsonl round-trips). SessionScanner's ternaries collapse is verified by typecheck + existing behavior.

- **Prior art** - `piExtensionFilter.test.ts` uses mocked fs on temp dirs; `importPipeline.test.ts` uses fake adapters; `browserPanel.test.ts` uses `node:test` + `node:assert/strict`. Same pattern: `node:test` + `node:assert/strict`, no DOM.

## Out of Scope

- AgentManager / PiProcess WSL path conversion (already encapsulated in WslPaths.ts)
- WslPaths.ts itself
- Other FileSystemService consumers
- SessionScanner's scan/cache logic (behavior must be preserved)
- Candidates 3 (IPC seam), 5 (App.tsx state), 1-remainder (SessionJsonl)

## Further Notes

This is candidate 4 from the architecture review report. Two adapters (local fs + wsl.exe) justify the seam - it's a real variation point, not a hypothetical one. The `configureWsl`/`clearWsl` lifecycle already exists; the change is routing file ops through the adapter instead of ternaries.
