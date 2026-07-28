import type { BrowserWindowConstructorOptions } from "electron";

export function windowTitleBarOptions(
  platform: NodeJS.Platform,
): Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "trafficLightPosition"> {
  if (platform !== "darwin") return {};
  return {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
  };
}
