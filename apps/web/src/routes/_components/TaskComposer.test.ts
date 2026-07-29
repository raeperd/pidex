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
    const body = renderComposer("/com", false);

    expect(body).toContain('role="listbox"');
    expect(body).toContain("Manually compact the session context");
    expect(body).toContain('aria-label="Start in Work locally"');
  });

  it("hides commands that cannot be expanded during active delivery", () => {
    expect(renderComposer("/", true)).not.toContain('role="listbox"');
  });

  it("does not give the disabled start mode control hover styles", () => {
    expect(renderComposer("", true)).toContain(
      "enabled:hover:bg-secondary enabled:hover:text-foreground",
    );
  });

  it("renders context details without a stats strip or session cost", () => {
    const body = renderComposer("", false);

    expect(body).not.toContain('data-testid="composer-stats"');
    expect(body).not.toContain("Session cost");
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

function renderComposer(draft: string, active: boolean) {
  return render(TaskComposer, {
    props: {
      active,
      clearQueue: async () => {},
      commands: [],
      compact: async () => true,
      configure: async () => true,
      connection: "connected",
      contextUsage: {
        tokens: 68_000,
        contextWindow: 272_000,
        percent: 25,
        totalProcessedTokens: 3_350,
        compactsAutomatically: true,
      },
      creatingTask: false,
      delivery: "steer",
      draft,
      followUpCount: 0,
      models: [
        {
          id: "openai/gpt-5.6-sol",
          provider: "openai",
          name: "GPT-5.6 Sol",
          reasoning: true,
        },
      ],
      persistDraft: () => {},
      projectName: "pidex",
      requiresAcknowledgement: false,
      runStatus: active ? "running" : "idle",
      selectedModel: "openai/gpt-5.6-sol",
      selectedThinkingLevel: "high",
      send: async () => {},
      setStartMode: () => {},
      startMode: "local",
      startModeEditable: true,
      steeringCount: 0,
      stop: async () => {},
      taskId: "task_test",
    },
  }).body;
}
