import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import AgentMessage from "./AgentMessage.svelte";

describe("AgentMessage", () => {
  it("renders every thinking paragraph inline instead of collapsing it to one label", () => {
    const body = render(AgentMessage, {
      props: {
        complete: true,
        text: "Repository summary",
        theme: "dark",
        thinking: "Planning repository inspection\n\nReading the project files.",
        timestamp: "2026-07-29T00:00:00.000Z",
      },
    }).body;

    expect(body).toContain("Planning repository inspection");
    expect(body).toContain("Reading the project files.");
    expect(body).not.toContain("<details");
    expect(body).not.toContain("<summary");
  });

  it("renders markdown inside the inline thinking section", () => {
    const body = render(AgentMessage, {
      props: {
        complete: true,
        text: "Repository summary",
        theme: "dark",
        thinking: "**Locating README and package docs**\nReading the project files.",
        timestamp: "2026-07-29T00:00:00.000Z",
      },
    }).body;
    expect(body).toContain("<strong");
    expect(body).toContain("Locating README and package docs");
    expect(body).not.toContain("**");
  });
});
