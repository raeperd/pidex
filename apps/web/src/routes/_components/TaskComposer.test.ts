import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import TaskComposer, {
  completeSlashCommand,
  composerCommands,
  formatRunElapsed,
  nextSlashCommand,
  queueSummary,
  runStatusLabel,
  slashCommandSuggestions,
  submitComposerDraft,
} from "./TaskComposer.svelte";

describe("runStatusLabel", () => {
  it("labels running as Working", () => {
    expect(runStatusLabel("running")).toBe("Working");
  });

  it("labels stopping as Stopping", () => {
    expect(runStatusLabel("stopping")).toBe("Stopping");
  });

  it("labels compacting as Compacting context", () => {
    expect(runStatusLabel("compacting")).toBe("Compacting context");
  });

  it("returns a sensible label for idle even though the row never renders it", () => {
    expect(runStatusLabel("idle")).toBe("Idle");
  });

  it("returns a sensible label for error even though the row never renders it", () => {
    expect(runStatusLabel("error")).toBe("Idle");
  });
});

describe("queueSummary", () => {
  it("spells out both queues", () => {
    expect(queueSummary(2, 1)).toBe("2 steering · 1 follow-up queued");
  });

  it("spells out only the steering queue", () => {
    expect(queueSummary(1, 0)).toBe("1 steering queued");
  });

  it("spells out only the follow-up queue", () => {
    expect(queueSummary(0, 1)).toBe("1 follow-up queued");
  });

  it("renders nothing for empty queues", () => {
    expect(queueSummary(0, 0)).toBe("");
  });
});

describe("formatRunElapsed", () => {
  it("formats zero as 0s", () => {
    expect(formatRunElapsed(0)).toBe("0s");
  });

  it("formats sub-minute durations in seconds", () => {
    expect(formatRunElapsed(42_000)).toBe("42s");
  });

  it("formats minute-plus-second durations", () => {
    expect(formatRunElapsed(83_000)).toBe("1m 23s");
  });

  it("formats hour-plus-minute durations", () => {
    expect(formatRunElapsed(3_720_000)).toBe("1h 2m");
  });

  it("clamps negative input to 0s", () => {
    expect(formatRunElapsed(-500)).toBe("0s");
  });
});

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

  it("fuzzy matches and ranks commands like Pi's terminal composer", () => {
    expect(
      slashCommandSuggestions("/rv", [
        { name: "resolve", description: "Resolve comments" },
        { name: "review", description: "Review the current changes" },
        { name: "release", description: "Prepare a release" },
      ]),
    ).toEqual([
      { name: "review", description: "Review the current changes" },
      { name: "resolve", description: "Resolve comments" },
    ]);
  });

  it("uses Pi's alphanumeric fallback when matching commands", () => {
    expect(slashCommandSuggestions("/review2", [{ name: "2-review" }])).toEqual([
      { name: "2-review" },
    ]);
  });

  it("matches Pi's slash-separated fuzzy query tokens", () => {
    expect(slashCommandSuggestions("/skill/diag", [{ name: "skill:diagnose" }])).toEqual([
      { name: "skill:diagnose" },
    ]);
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

  it("shows only the stop action while active, even when a draft is present", () => {
    const body = renderComposer("Send this after the response", true);

    expect(body).toContain('aria-label="Stop"');
    expect(body).not.toContain('aria-label="Delivery mode"');
    expect(body).not.toContain('aria-label="Queue"');
    expect(body).not.toContain('aria-label="Send"');
  });

  it("does not give the disabled start mode control hover styles", () => {
    expect(renderComposer("", true)).toContain(
      "enabled:hover:bg-secondary enabled:hover:text-foreground",
    );
  });

  it("hides immutable workspace controls for an existing task", () => {
    const body = renderComposer("", false, false);

    expect(body).not.toContain('aria-label="Task workspace"');
    expect(body).not.toContain('aria-label="Start in Work locally"');
  });

  it("renders context details without a stats strip or session cost", () => {
    const body = renderComposer("", false);

    expect(body).not.toContain('data-testid="composer-stats"');
    expect(body).not.toContain("Session cost");
  });

  it("shows the human status label instead of the raw run-status enum while active", () => {
    const body = renderComposer("", true);

    expect(body).toContain("Working");
    expect(body).not.toContain("running");
  });

  it("reserves the status row's height and hides its content when inactive", () => {
    const body = renderComposer("", false);

    expect(body).toContain("invisible");
  });

  it("shows the status row's content when active", () => {
    const body = renderComposer("", true);

    expect(body).not.toContain("invisible");
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

function renderComposer(draft: string, active: boolean, startModeEditable = true) {
  return render(TaskComposer, {
    props: {
      active,
      clearQueue: async () => {},
      commands: [],
      compact: async () => true,
      compactPending: false,
      configure: async () => true,
      configurationPending: false,
      connection: "connected",
      contextUsage: {
        tokens: 68_000,
        contextWindow: 272_000,
        percent: 25,
        totalProcessedTokens: 3_350,
        compactsAutomatically: true,
      },
      creatingTask: false,
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
      startModeEditable,
      steeringCount: 0,
      stop: async () => {},
      taskId: "task-1",
    },
  }).body;
}
