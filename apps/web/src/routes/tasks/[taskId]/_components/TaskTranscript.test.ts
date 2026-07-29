import type { ToolItem } from "@pidex/api";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import TaskTranscript from "./TaskTranscript.svelte";

describe("TaskTranscript", () => {
  it("renders every tool call in chronological order", () => {
    const commands = ["pwd", "git status", "find .", "go test ./..."];
    const tools = commands.map(
      (command, index): ToolItem => ({
        type: "tool",
        id: `tool-${index}`,
        name: "bash",
        argumentSummary: JSON.stringify({ command }),
        state: "success",
        preview: `result ${index}`,
        truncated: false,
      }),
    );

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

    expect(body).not.toContain("previous tool");
    for (const command of commands) expect(body).toContain(command);
    expect(body.indexOf("pwd")).toBeLessThan(body.indexOf("git status"));
    expect(body.indexOf("git status")).toBeLessThan(body.indexOf("find ."));
    expect(body.indexOf("find .")).toBeLessThan(body.indexOf("go test ./..."));
  });
});
