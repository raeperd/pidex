import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStateDirectory } from "./state-path.js";

describe("resolveStateDirectory", () => {
  it("keeps application state below Electron userData by default", () => {
    const userDataDirectory = path.join("native", "pidex");

    expect(resolveStateDirectory(userDataDirectory, undefined)).toBe(
      path.join(userDataDirectory, "state"),
    );
  });

  it("preserves an explicit PIDEX_STATE_DIR override", () => {
    const configuredDirectory = path.join("custom", "state");

    expect(resolveStateDirectory(path.join("native", "pidex"), configuredDirectory)).toBe(
      configuredDirectory,
    );
  });
});
