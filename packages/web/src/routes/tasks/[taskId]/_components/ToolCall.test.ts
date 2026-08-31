import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import ToolCall from "./ToolCall.svelte";

describe("ToolCall", () => {
  it("renders a shell summary, trailing output, and elapsed time", () => {
    const body = render(ToolCall, {
      props: {
        name: "bash",
        argumentSummary: JSON.stringify({ command: "pnpm test" }),
        status: "success",
        output: "1\n2\n3\n4\n5\n6\n7\n",
        startedAt: 0,
        endedAt: 12_340,
        now: 12_340,
      },
    }).body;

    expect(body).toContain(">pnpm test<");
    expect(body).toContain("… 2 earlier lines");
    expect(body).toContain(">3\n4\n5\n6\n7<");
    expect(body).toContain("Took 12.3s");
  });

  it("expands failed calls and unwraps structured text output", () => {
    const body = render(ToolCall, {
      props: {
        name: "custom_tool",
        argumentSummary: JSON.stringify({ target: "workspace" }),
        status: "error",
        output: JSON.stringify({ content: [{ type: "text", text: "command failed" }] }),
        now: 0,
      },
    }).body;

    expect(body).toContain("Custom tool");
    expect(body).toContain("command failed");
    expect(body).toContain("Failed");
    expect(body).toContain('aria-expanded="true"');
  });

  it("renders concise path details when a call has no output", () => {
    const body = render(ToolCall, {
      props: {
        name: "read",
        argumentSummary: JSON.stringify({ path: "README.md", offset: 1, limit: 20 }),
        status: "success",
        output: "",
        now: 0,
      },
    }).body;

    expect(body).toContain("Read");
    expect(body).toContain("README.md");
    expect(body).toContain(":1-20");
    expect(body).toContain('aria-label="Read README.md:1-20"');
  });
});
