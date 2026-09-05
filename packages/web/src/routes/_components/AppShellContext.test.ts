import { describe, expect, it, vi } from "vitest";
import { createTaskViewControllerRegistry } from "./AppShellContext.svelte";

describe("createTaskViewControllerRegistry", () => {
  it("delegates to the currently attached composer", () => {
    const firstComposer = { focus: vi.fn(), resize: vi.fn() };
    const secondComposer = { focus: vi.fn(), resize: vi.fn() };
    const registry = createTaskViewControllerRegistry();

    registry.attachComposer(firstComposer);
    registry.focusComposer();
    registry.resizeComposer();
    registry.attachComposer(secondComposer);
    registry.focusComposer();

    expect(firstComposer.focus).toHaveBeenCalledOnce();
    expect(firstComposer.resize).toHaveBeenCalledOnce();
    expect(secondComposer.focus).toHaveBeenCalledOnce();
  });

  it("releases the composer reference on disposal", () => {
    const composer = { focus: vi.fn(), resize: vi.fn() };
    const registry = createTaskViewControllerRegistry();
    registry.attachComposer(composer);

    registry.dispose();
    registry.focusComposer();
    registry.resizeComposer();

    expect(composer.focus).not.toHaveBeenCalled();
    expect(composer.resize).not.toHaveBeenCalled();
  });

  it("focuses a composer that attaches after focus was requested", () => {
    const composer = { focus: vi.fn(), resize: vi.fn() };
    const registry = createTaskViewControllerRegistry((callback) => callback());

    registry.focusComposer();
    registry.attachComposer(composer);

    expect(composer.focus).toHaveBeenCalledOnce();
  });
});
