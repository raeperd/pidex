import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import UserMessage from "./UserMessage.svelte";

describe("UserMessage", () => {
  it("renders the message text inside the bubble", () => {
    const body = render(UserMessage, { props: { text: "Add a login page" } }).body;

    expect(body).toContain("Add a login page");
  });

  it("renders a copy affordance for a non-empty message", () => {
    const body = render(UserMessage, { props: { text: "Add a login page" } }).body;

    expect(body).toContain('aria-label="Copy message"');
    expect(body).toContain('role="tooltip"');
  });

  it("omits the copy footer for a blank message", () => {
    const body = render(UserMessage, { props: { text: "   " } }).body;

    expect(body).not.toContain('aria-label="Copy message"');
    expect(body).not.toContain('role="tooltip"');
  });
});
