import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import Toast from "./Toast.svelte";

describe("Toast markup", () => {
  it("renders the message as an alert popover with a dismiss button", () => {
    const { body } = render(Toast, {
      props: { message: "Prompt rejected", ondismiss: () => {} },
    });

    expect(body).toContain('role="alert"');
    expect(body).toContain('popover="manual"');
    expect(body).toContain("Prompt rejected");
    expect(body).toContain('aria-label="Dismiss error"');
    expect(body).not.toContain('aria-label="Copy error"');
  });

  it("renders nothing when there is no message", () => {
    const { body } = render(Toast, { props: { message: "", ondismiss: () => {} } });

    expect(body).not.toContain('role="alert"');
    expect(body).not.toContain("popover");
  });

  it("shows a copy button and clamps the display for a long message", () => {
    const long = "E".repeat(120);
    const { body } = render(Toast, { props: { message: long, ondismiss: () => {} } });

    expect(body).toContain('aria-label="Copy error"');
    expect(body).toContain("line-clamp-4");
  });
});
