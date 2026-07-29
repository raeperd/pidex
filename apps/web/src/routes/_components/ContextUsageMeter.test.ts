import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import ContextUsageMeter from "./ContextUsageMeter.svelte";

describe("ContextUsageMeter", () => {
  it("renders context usage as an interactive details trigger", () => {
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

    expect(body).toContain('<button class="context-meter__trigger');
    expect(body).toContain('type="button"');
    expect(body).toContain('aria-label="Context window 5.1% used"');
    expect(body).toContain('aria-expanded="false"');
    expect(body).toContain('role="tooltip"');
    expect(body).toContain('aria-hidden="true"');
  });
});
