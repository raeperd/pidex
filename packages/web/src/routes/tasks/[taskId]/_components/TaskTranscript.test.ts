import type { SkillItem, TextItem, ToolItem } from "@pidex/api";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import {
  groupTranscriptItems,
  resolveFollowing,
  toolActivitySummary,
} from "./TaskTranscript.svelte";
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

function message(id: string, type: "user" | "assistant"): TextItem {
  return {
    type,
    id,
    text: id,
    complete: true,
    timestamp: "2026-07-30T00:00:00.000Z",
  };
}

describe("TaskTranscript", () => {
  it("groups only consecutive tool calls while preserving chronology", () => {
    const rows = groupTranscriptItems([
      message("request", "user"),
      tool("read-one", "read", { path: "README.md" }),
      tool("read-two", "read", { path: "package.json" }),
      message("answer", "assistant"),
      tool("shell-one", "bash", { command: "pnpm test" }),
    ]);

    expect(
      rows.map((row) =>
        row.kind === "tools" ? row.items.map((item: ToolItem) => item.id) : row.item.id,
      ),
    ).toEqual(["request", ["read-one", "read-two"], "answer", ["shell-one"]]);
  });

  it("summarizes dense activity using human actions", () => {
    expect(
      toolActivitySummary([
        tool("read-one", "read", { path: "README.md" }),
        tool("read-two", "read", { path: "package.json" }),
        tool("shell-one", "bash", { command: "pnpm test" }),
        tool("search-one", "grep", { pattern: "TODO" }),
      ]),
    ).toBe("Read 2 files, ran 1 command, and searched once");
  });

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

function position(distanceFromBottom: number) {
  return { scrollTop: 0, scrollHeight: distanceFromBottom, clientHeight: 0 };
}

describe("resolveFollowing", () => {
  it("detaches on a wheel scroll up away from the bottom while following", () => {
    expect(resolveFollowing(true, { kind: "wheel", deltaY: -10 }, position(200))).toBe(false);
  });

  it("detaches on a wheel scroll up while the pre-scroll position still reads at the bottom", () => {
    // The wheel event fires before the browser applies its default scroll, so the position
    // it carries can still read "at the bottom" even though the gesture is about to move away.
    expect(resolveFollowing(true, { kind: "wheel", deltaY: -10 }, position(0))).toBe(false);
  });

  it("stays following on a wheel scroll down at the bottom", () => {
    expect(resolveFollowing(true, { kind: "wheel", deltaY: 10 }, position(0))).toBe(true);
  });

  it("detaches on a touchmove that ends away from the bottom", () => {
    expect(resolveFollowing(true, { kind: "touchmove" }, position(200))).toBe(false);
  });

  it("never detaches from a programmatic scroll event alone while following", () => {
    expect(resolveFollowing(true, { kind: "scroll" }, position(500))).toBe(true);
  });

  it("re-attaches on a scroll back within the bottom threshold while detached", () => {
    expect(resolveFollowing(false, { kind: "scroll" }, position(50))).toBe(true);
  });

  it("stays detached on a scroll far from the bottom while detached", () => {
    expect(resolveFollowing(false, { kind: "scroll" }, position(500))).toBe(false);
  });

  it("stays detached exactly at the 96px threshold", () => {
    expect(resolveFollowing(false, { kind: "scroll" }, position(96))).toBe(false);
  });

  it("re-attaches just inside the 96px threshold", () => {
    expect(resolveFollowing(false, { kind: "scroll" }, position(95))).toBe(true);
  });

  it("stays detached just outside the 96px threshold", () => {
    expect(resolveFollowing(false, { kind: "scroll" }, position(97))).toBe(false);
  });
});
