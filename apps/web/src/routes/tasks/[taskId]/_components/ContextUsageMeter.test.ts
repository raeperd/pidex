import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import ContextUsageMeter from "./ContextUsageMeter.svelte";

describe("ContextUsageMeter", () => {
  it("renders context usage as a read-only indicator", () => {
    const { body } = render(ContextUsageMeter, {
      props: {
        usage: {
          tokens: 5_100,
          contextWindow: 100_000,
          percent: 5.1,
          totalProcessedTokens: 77_849,
          compactsAutomatically: true,
        },
      },
    });

    expect(body).not.toContain("<button");
    expect(body).toContain('role="img"');
    expect(body).toContain('aria-label="Context window 5.1% used"');
    expect(body).not.toContain("Compact task");
  });
});
