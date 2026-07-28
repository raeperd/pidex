import { describe, expect, it, vi } from "vitest";
import { createTaskViewControllerRegistry } from "./AppShellContext.svelte";

describe("createTaskViewControllerRegistry", () => {
  it("delegates to the currently attached task views", () => {
    const firstComposer = { focus: vi.fn(), resize: vi.fn() };
    const secondComposer = { focus: vi.fn(), resize: vi.fn() };
    const transcript = { scrollIfNearBottom: vi.fn(), scrollLatest: vi.fn() };
    const registry = createTaskViewControllerRegistry();

    registry.attachComposer(firstComposer);
    registry.attachTranscript(transcript);
    registry.focusComposer();
    registry.resizeComposer();
    registry.scrollIfNearBottom();
    registry.scrollLatest();
    registry.attachComposer(secondComposer);
    registry.focusComposer();

    expect(firstComposer.focus).toHaveBeenCalledOnce();
    expect(firstComposer.resize).toHaveBeenCalledOnce();
    expect(secondComposer.focus).toHaveBeenCalledOnce();
    expect(transcript.scrollIfNearBottom).toHaveBeenCalledOnce();
    expect(transcript.scrollLatest).toHaveBeenCalledOnce();
  });

  it("releases task view references on disposal", () => {
    const composer = { focus: vi.fn(), resize: vi.fn() };
    const transcript = { scrollIfNearBottom: vi.fn(), scrollLatest: vi.fn() };
    const registry = createTaskViewControllerRegistry();
    registry.attachComposer(composer);
    registry.attachTranscript(transcript);

    registry.dispose();
    registry.focusComposer();
    registry.resizeComposer();
    registry.scrollIfNearBottom();
    registry.scrollLatest();

    expect(composer.focus).not.toHaveBeenCalled();
    expect(composer.resize).not.toHaveBeenCalled();
    expect(transcript.scrollIfNearBottom).not.toHaveBeenCalled();
    expect(transcript.scrollLatest).not.toHaveBeenCalled();
  });

  it("focuses a composer that attaches after focus was requested", () => {
    const composer = { focus: vi.fn(), resize: vi.fn() };
    const registry = createTaskViewControllerRegistry((callback) => callback());

    registry.focusComposer();
    registry.attachComposer(composer);

    expect(composer.focus).toHaveBeenCalledOnce();
  });
});
