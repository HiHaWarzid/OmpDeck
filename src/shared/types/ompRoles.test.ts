import { describe, expect, it } from "vitest";
import {
  formatRoleSelector,
  isValidOmpRoleSelector,
  parseRoleSelector,
  sortProvidersByOrder,
} from "./ompRoles";

describe("parseRoleSelector", () => {
  it("parses provider/model with thinking suffix", () => {
    expect(parseRoleSelector("commandcode/deepseek/deepseek-v4-flash:high")).toEqual({
      selector: "commandcode/deepseek/deepseek-v4-flash:high",
      provider: "commandcode",
      modelId: "deepseek/deepseek-v4-flash",
      thinkingLevel: "high",
    });
  });

  it("parses provider/model without suffix", () => {
    expect(parseRoleSelector("openai/gpt-4o")).toEqual({
      selector: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      thinkingLevel: undefined,
    });
  });

  it("treats the first slash as provider boundary (nested provider ids)", () => {
    // provider 名本身可含 "/"（如 commandcode/deepseek 命名空间）；首个 "/" 为界
    expect(parseRoleSelector("commandcode/deepseek/deepseek-v4-flash")).toEqual({
      selector: "commandcode/deepseek/deepseek-v4-flash",
      provider: "commandcode",
      modelId: "deepseek/deepseek-v4-flash",
      thinkingLevel: undefined,
    });
  });

  it("falls back to model-only base when no slash present", () => {
    expect(parseRoleSelector("gpt-4o")).toEqual({
      selector: "gpt-4o",
      provider: "",
      modelId: "gpt-4o",
      thinkingLevel: undefined,
    });
  });

  it("keeps role aliases and candidate lists whole (no provider split)", () => {
    expect(parseRoleSelector("@slow:high")).toEqual({
      selector: "@slow:high",
      provider: "",
      modelId: "",
      thinkingLevel: undefined,
    });
    expect(parseRoleSelector("openai/gpt-4o,anthropic/claude:high")).toEqual({
      selector: "openai/gpt-4o,anthropic/claude:high",
      provider: "",
      modelId: "",
      thinkingLevel: undefined,
    });
  });
});

describe("isValidOmpRoleSelector", () => {
  it("accepts provider/model, aliases, candidates, and thinking suffixes", () => {
    for (const selector of [
      "openai/gpt-4o",
      "@slow",
      "pi/default",
      "*",
      "gpt-4o",
      "openai/gpt-4o:high",
      "openai/gpt-4o,anthropic/claude:max",
    ]) {
      expect(isValidOmpRoleSelector(selector), selector).toBe(true);
    }
  });

  it("rejects empty slots, whitespace, and dangling separators", () => {
    for (const selector of ["", "  ", "openai/", "/gpt-4o", "@", ",", "a/b,", "a b"]) {
      expect(isValidOmpRoleSelector(selector), selector).toBe(false);
    }
  });
});

describe("sortProvidersByOrder", () => {
  it("ranks configured providers first and sorts the rest alphabetically", () => {
    expect(sortProvidersByOrder(["zeta", "openai", "alpha", "anthropic"], ["anthropic", "openai"]))
      .toEqual(["anthropic", "openai", "alpha", "zeta"]);
  });
});

describe("formatRoleSelector", () => {
  it("round-trips with parseRoleSelector when level is set", () => {
    const selector = formatRoleSelector("openai", "gpt-4o", "low");
    expect(selector).toBe("openai/gpt-4o:low");
    expect(parseRoleSelector(selector)).toEqual({
      selector: "openai/gpt-4o:low",
      provider: "openai",
      modelId: "gpt-4o",
      thinkingLevel: "low",
    });
  });

  it("omits the suffix when no level is given", () => {
    expect(formatRoleSelector("openai", "gpt-4o")).toBe("openai/gpt-4o");
  });

  it("returns empty string for empty provider or model (unconfigured)", () => {
    expect(formatRoleSelector("", "gpt-4o")).toBe("");
    expect(formatRoleSelector("openai", "")).toBe("");
  });
});
