import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const parts = readFileSync("src/renderer/src/components/app/AppParts.tsx", "utf8");
const styles = readFileSync("src/renderer/src/styles.css", "utf8");
const i18n = readFileSync("src/renderer/src/i18n.ts", "utf8");

function cssRule(selector) {
  const matches = [...styles.matchAll(new RegExp(`${selector} \\{([\\s\\S]*?)\\n\\}`, "g"))];
  return matches.at(-1)?.[1] ?? "";
}

test("empty state shows the agent ownership tagline with branded accent", () => {
  // 品牌文案已从 i18n 键改为硬编码「A coding agent with the IDE wired in.」，
  // 强调色从 empty-tagline-yours 类改为内联 oklch 色（与 i18n app.emptyTaglineNew 同文案）。
  assert.match(parts, /className="empty-tagline"/);
  assert.match(parts, />A coding agent<\/span>/);
  assert.match(parts, />with the <\/span>/);
  assert.match(parts, /IDE wired in\.<\/span>/);
  assert.match(parts, /color: "oklch\(0\.29 0\.11 346\.85 \/ 1\)"/);
  assert.doesNotMatch(parts, /<h2>\{t\("app\.startAgent"\)\}<\/h2>/);
  assert.doesNotMatch(parts, /<p>\{t\("app\.emptyGuide"\)\}<\/p>/);
  assert.match(parts, /width="168"[\s\S]*height="168"/);

  assert.match(i18n, /"app\.emptyTaglineNew": "A coding agent\\nwith the IDE wired in\."/);

  const button = cssRule("\\.empty-state button");
  const tagline = cssRule("\\.empty-tagline");

  assert.match(button, /min-width:\s*118px;[\s\S]*height:\s*40px;/);
  assert.match(styles, /--color-accent-soft:\s*#eaf6ed;/i);
  assert.match(button, /color:\s*var\(--color-accent-strong\);/);
  assert.match(button, /font-family:\s*var\(--font-family-base\);/);
  assert.match(button, /font-weight:\s*600;/);
  assert.match(button, /letter-spacing:\s*0;/);
  assert.match(button, /border-radius:\s*var\(--radius-md\);/);
  assert.match(tagline, /font-family:\s*var\(--font-family-brand\)/);
});
