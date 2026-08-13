import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // 只收集 src 下的 TS 单测；tests/*.test.mjs 是 node:test 源码审查套件，
    // 由 `npm run test:node`（node --test tests/）运行，vitest 不接管。
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
