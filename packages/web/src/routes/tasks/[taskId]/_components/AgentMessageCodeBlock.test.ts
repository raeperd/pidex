import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import AgentMessageCodeBlock from "./AgentMessageCodeBlock.svelte";

describe("AgentMessageCodeBlock", () => {
  it("renders completed code with its language and actions", () => {
    const body = render(AgentMessageCodeBlock, {
      props: { code: "const answer = 42;", language: "typescript", theme: "light" },
    }).body;

    expect(body).toContain('title="typescript"');
    expect(body).toContain("const answer = 42;");
    expect(body).toContain('aria-label="Wrap lines"');
    expect(body).toContain('aria-label="Copy code"');
  });

  it("renders oversized and unknown-language code as readable plain text", () => {
    const code = "hello";
    const body = render(AgentMessageCodeBlock, {
      props: { code, language: "definitely-not-a-language", theme: "dark" },
    }).body;

    expect(body).toContain(code);
    expect(body).toContain('title="definitely-not-a-language"');
  });
});
