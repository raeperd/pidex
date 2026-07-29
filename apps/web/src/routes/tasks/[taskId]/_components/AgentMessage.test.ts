import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import AgentMessage from "./AgentMessage.svelte";

describe("AgentMessage", () => {
  it("uses the first thinking line as the collapsed planning label", () => {
    const body = render(AgentMessage, {
      props: {
        complete: true,
        text: "Repository summary",
        theme: "dark",
        thinking: "Planning repository inspection\nReading the project files.",
        timestamp: "2026-07-29T00:00:00.000Z",
      },
    }).body;

    expect(body).toContain("Planning repository inspection");
    expect(body).not.toContain(">Thought</summary>");
  });
});
