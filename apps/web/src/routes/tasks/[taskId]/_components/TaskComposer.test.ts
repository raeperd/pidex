import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import TaskComposer, {
  completeSlashCommand,
  composerCommands,
  nextSlashCommand,
  slashCommandSuggestions,
  submitComposerDraft,
} from "./TaskComposer.svelte";

describe("composerCommands", () => {
  it("combines native commands with commands discovered from Pi", () => {
    expect(
      composerCommands([{ name: "review", description: "Review the current changes" }]),
    ).toEqual([
      { name: "compact", description: "Manually compact the session context" },
      { name: "review", description: "Review the current changes" },
    ]);
  });

  it("keeps the native command when Pi provides the same name", () => {
    expect(composerCommands([{ name: "compact", description: "Template command" }])).toEqual([
      { name: "compact", description: "Manually compact the session context" },
    ]);
  });
});

describe("submitComposerDraft", () => {
  it("compacts with optional instructions instead of prompting Pi", async () => {
    const compact = vi.fn(async () => true);
    const send = vi.fn(async () => {});

    expect(
      await submitComposerDraft("/compact Preserve architectural decisions", { compact, send }),
    ).toBe("compact");

    expect(compact).toHaveBeenCalledWith("Preserve architectural decisions");
    expect(send).not.toHaveBeenCalled();
  });

  it("reports a rejected compaction so the composer can retain the command", async () => {
    expect(
      await submitComposerDraft("/compact", {
        compact: async () => false,
        send: async () => {},
      }),
    ).toBe("compact-failed");
  });

  it("passes multiline compact instructions to the compaction action", async () => {
    const compact = vi.fn(async () => true);
    const send = vi.fn(async () => {});

    await submitComposerDraft("/compact Preserve decisions\nand constraints", { compact, send });

    expect(compact).toHaveBeenCalledWith("Preserve decisions\nand constraints");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("slashCommandSuggestions", () => {
  it("filters commands from a leading slash token", () => {
    expect(
      slashCommandSuggestions("/com", [
        { name: "compact", description: "Manually compact the session context" },
        { name: "review", description: "Review the current changes" },
      ]),
    ).toEqual([{ name: "compact", description: "Manually compact the session context" }]);
  });

  it("renders matching commands above the composer", () => {
    const { body } = render(TaskComposer, {
      props: {
        active: false,
        clearQueue: async () => {},
        commands: [],
        compact: async () => true,
        connection: "connected",
        delivery: "steer",
        draft: "/com",
        followUpCount: 0,
        hasConfigurationDraft: false,
        models: [],
        openCompact: () => {},
        persistDraft: () => {},
        requiresAcknowledgement: false,
        runStatus: "idle",
        selectedModel: "",
        selectedThinkingLevel: "low",
        send: async () => {},
        stageConfiguration: () => {},
        stats: { messages: 0, toolCalls: 0, tokens: 0, cost: 0 },
        steeringCount: 0,
        stop: async () => {},
      },
    });

    expect(body).toContain('role="listbox"');
    expect(body).toContain("Manually compact the session context");
  });

  it("completes a selected command in the composer", () => {
    expect(completeSlashCommand({ name: "compact" })).toBe("/compact ");
  });

  it("moves keyboard selection through matching commands", () => {
    expect(
      nextSlashCommand([{ name: "compact" }, { name: "compare" }], { name: "compact" }, 1),
    ).toEqual({ name: "compare" });
  });
});
