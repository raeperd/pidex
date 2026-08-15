import { describe, expect, it } from "vitest";
import { faviconHref } from "./AppShellFavicon";

describe("faviconHref", () => {
  it("uses the base icon when there is nothing to signal", () => {
    expect(faviconHref("none")).toBe("/favicon.svg");
  });

  it("uses the running variant while a run is active", () => {
    expect(faviconHref("running")).toBe("/favicon-running.svg");
  });

  it("uses the attention variant when the run needs the user", () => {
    expect(faviconHref("attention")).toBe("/favicon-attention.svg");
  });
});
