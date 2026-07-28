import { describe, expect, it } from "vitest";
import { windowTitleBarOptions } from "./window-options.js";

describe("windowTitleBarOptions", () => {
  it("integrates the application chrome with the macOS title bar", () => {
    expect(windowTitleBarOptions("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 18 },
    });
  });
});
