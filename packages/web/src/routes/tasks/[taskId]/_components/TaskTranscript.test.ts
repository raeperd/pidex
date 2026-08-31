import type { SkillItem, ToolItem } from "@pidex/api";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import TaskTranscript from "./TaskTranscript.svelte";

function tool(id: string, name: string, argumentSummary: Record<string, unknown>): ToolItem {
  return {
    type: "tool",
    id,
    name,
    argumentSummary: JSON.stringify(argumentSummary),
    state: "success",
    preview: `${id} result`,
    truncated: false,
  };
}

describe("TaskTranscript", () => {
  it("renders grouped tool activity with an overview disclosure", () => {
    const commands = ["pwd", "git status", "find .", "go test ./..."];
    const tools = commands.map((command, index) => tool(`tool-${index}`, "bash", { command }));

    const body = render(TaskTranscript, {
      props: {
        items: tools,
        loadEarlier: async () => {},
        loadToolOutput: async () => {},
        loadingEarlier: false,
        toolElapsedNow: 0,
        toolOutputs: {},
        toolTimings: {},
        transcriptStart: 0,
      },
    }).body;

    expect(body).toContain("3 previous tool calls");
    expect(body).toContain("Ran 4 commands");
    for (const command of commands) expect(body).toContain(command);
    expect(body.indexOf("pwd")).toBeLessThan(body.indexOf("git status"));
    expect(body.indexOf("git status")).toBeLessThan(body.indexOf("find ."));
    expect(body.indexOf("find .")).toBeLessThan(body.indexOf("go test ./..."));
  });

  it("renders native Pi skill activity with expandable instructions", () => {
    const skill: SkillItem = {
      type: "skill",
      id: "skill-diagnose",
      name: "diagnose",
      content: "Diagnose the failure before proposing a fix.",
      timestamp: "2026-07-30T00:00:00.000Z",
    };

    const body = render(TaskTranscript, {
      props: {
        items: [skill],
        loadEarlier: async () => {},
        loadToolOutput: async () => {},
        loadingEarlier: false,
        toolElapsedNow: 0,
        toolOutputs: {},
        toolTimings: {},
        transcriptStart: 0,
      },
    }).body;

    expect(body).toContain('aria-label="Skill loaded: diagnose"');
    expect(body).toContain("Diagnose the failure before proposing a fix.");
  });

  it("renders the scroll container without scroll-smooth", () => {
    const body = render(TaskTranscript, {
      props: {
        items: [],
        loadEarlier: async () => {},
        loadToolOutput: async () => {},
        loadingEarlier: false,
        toolElapsedNow: 0,
        toolOutputs: {},
        toolTimings: {},
        transcriptStart: 0,
      },
    }).body;

    expect(body).not.toContain("scroll-smooth");
  });
});
