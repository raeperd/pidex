import type { ChatSnapshot } from "@pidex/api";
import type { ComponentProps } from "svelte";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import TaskComposer from "./TaskComposer.svelte";

describe("composer affordances", () => {
  it("reflects a non-default reason in the rendered send button", () => {
    const body = renderComposer("", false, true, { connection: "disconnected" });

    expect(body).toContain('aria-label="Environment disconnected"');
    expect(body).toContain('title="Environment disconnected"');
  });
});

describe("slash command suggestions", () => {
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

  it("renders a space between the status label and the queue summary, not a glued word", () => {
    // `elapsedLabel` is driven by a client-only `$effect` timer that svelte/server's `render`
    // never executes, so it can't be exercised at this seam; `queueLabel` is a pure `$derived`
    // of props and hits the same `{#if …}{" "}…{/if}` block-boundary-whitespace pattern, so it
    // stands in for the identical class of bug (Svelte trims whitespace immediately inside a
    // block boundary, gluing adjacent text together without an explicit `{" "}`). Svelte's SSR
    // output interleaves invisible hydration-boundary comments between text nodes, so compare
    // against the comment-stripped text a browser would actually display.
    const body = render(TaskComposer, {
      props: {
        ...composerProps("", true),
        snapshot: makeChatSnapshot({
          runStatus: "running",
          steeringQueue: ["First steering message", "Second steering message"],
          followUpQueue: ["Follow-up message"],
        }),
      },
    }).body;
    const visibleText = body.replace(/<!--[\s\S]*?-->/g, "");

    expect(visibleText).toContain("Working · 2 steering · 1 follow-up queued");
    expect(visibleText).not.toContain("Working·");
  });

  it("reserves the status row's height and hides its content when inactive", () => {
    const body = renderComposer("", false);

    expect(body).toContain("invisible");
  });

  it("shows the status row's content when active", () => {
    const body = renderComposer("", true);

    expect(body).not.toContain("invisible");
  });
});

function composerProps(
  draft: string,
  active: boolean,
  startModeEditable = true,
  overrides: Partial<ComponentProps<typeof TaskComposer>> = {},
): ComponentProps<typeof TaskComposer> {
  return {
    actions: {
      clearQueue: async () => {},
      compact: async () => true,
      configure: async () => true,
      persistDraft: () => {},
      send: async () => {},
      setStartMode: () => {},
      stop: async () => {},
    },
    commands: [],
    compactPending: false,
    configurationPending: false,
    connection: "connected",
    creatingTask: false,
    draft,
    models: [
      {
        id: "openai/gpt-5.6-sol",
        provider: "openai",
        name: "GPT-5.6 Sol",
        reasoning: true,
      },
    ],
    projectName: "pidex",
    snapshot: makeChatSnapshot({ runStatus: active ? "running" : "idle" }),
    startMode: "local",
    startModeEditable,
    ...overrides,
  };
}

function makeChatSnapshot(overrides: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return {
    chatId: "chat-1",
    workspaceId: "workspace-1",
    taskId: "task-1",
    revision: 1,
    runStatus: "idle",
    model: "openai/gpt-5.6-sol",
    thinkingLevel: "high",
    items: [],
    transcriptStart: 0,
    transcriptTotal: 0,
    steeringQueue: [],
    followUpQueue: [],
    stats: { messages: 0, toolCalls: 0, tokens: 0, cost: 0, subscription: false },
    contextUsage: {
      tokens: 68_000,
      contextWindow: 272_000,
      percent: 25,
      totalProcessedTokens: 3_350,
      compactsAutomatically: true,
    },
    ...overrides,
  };
}

function renderComposer(
  draft: string,
  active: boolean,
  startModeEditable = true,
  overrides: Partial<ComponentProps<typeof TaskComposer>> = {},
) {
  return render(TaskComposer, { props: composerProps(draft, active, startModeEditable, overrides) })
    .body;
}
