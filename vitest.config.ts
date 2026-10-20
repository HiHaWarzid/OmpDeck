import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    // 与 electron.vite.config.ts 的 renderer alias 保持一致：否则引用 @renderer/@shared
    // 的渲染层模块（组件、工具）无法在单测里导入，只能靠源码正则断言间接覆盖。
    alias: {
      "@renderer": resolve("src/renderer/src"),
      "@shared": resolve("src/shared"),
    },
  },
  test: {
    environment: "node",
    // 只收集 src 下的 TS 单测；tests/*.test.mjs 是 node:test 源码审查套件，
    // 由 `npm run test:node`（node --test tests/）运行，vitest 不接管。
    // node:sqlite（opencodeImportAdapter）实验模块：flag 固化在配置里，
    // 无论 `npm test` 还是直接 `npx vitest run` 都会传给 worker 进程
    // （跨平台，避免 NODE_OPTIONS 差异；Node <22.5 无此模块会报错）。
    execArgv: ["--experimental-sqlite"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
