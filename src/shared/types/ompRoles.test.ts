import { describe, expect, it } from "vitest";
import { formatRoleSelector, parseRoleSelector } from "./ompRoles";

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
