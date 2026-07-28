import { describe, expect, it } from "vitest";
import { highlightCode } from "./AgentMessageCodeBlock.svelte";

describe("highlightCode", () => {
  it("tokenizes completed code with the real highlighter", async () => {
    const result = await highlightCode("const answer = 42;", "typescript", "light");

    expect(
      result?.lines.map((line) => line.map((token) => token.content).join("")).join("\n"),
    ).toBe("const answer = 42;");
    expect(result?.lines.flat().some((token) => token.color)).toBe(true);
  });

  it("falls back to plain-text highlighting for unknown languages", async () => {
    const result = await highlightCode("hello", "definitely-not-a-language", "dark");

    expect(
      result?.lines
        .flat()
        .map((token) => token.content)
        .join(""),
    ).toBe("hello");
  });

  it("skips oversized blocks", async () => {
    await expect(highlightCode("x".repeat(100_001), "text", "light")).resolves.toBeNull();
  });
});
