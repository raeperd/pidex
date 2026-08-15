import { describe, expect, it } from "vitest";
import { connectionBanner } from "./AppShellConnectionBanner";

describe("connectionBanner", () => {
  it("is always hidden while connected, regardless of history or delay", () => {
    expect(connectionBanner("connected", false, false)).toBeUndefined();
    expect(connectionBanner("connected", true, false)).toBeUndefined();
    expect(connectionBanner("connected", true, true)).toBeUndefined();
  });

  it("stays hidden before the delay elapses, for both non-connected states", () => {
    expect(connectionBanner("reconnecting", false, false)).toBeUndefined();
    expect(connectionBanner("reconnecting", true, false)).toBeUndefined();
    expect(connectionBanner("disconnected", false, false)).toBeUndefined();
    expect(connectionBanner("disconnected", true, false)).toBeUndefined();
  });

  it("shows the first-connect copy once the delay elapses and nothing has connected yet", () => {
    expect(connectionBanner("reconnecting", false, true)).toBe("connecting");
  });

  it("shows the reconnecting copy once the delay elapses after a prior connection", () => {
    expect(connectionBanner("reconnecting", true, true)).toBe("reconnecting");
  });

  it("gates 'disconnected' identically to 'reconnecting' once the delay elapses", () => {
    expect(connectionBanner("disconnected", false, true)).toBe("connecting");
    expect(connectionBanner("disconnected", true, true)).toBe("reconnecting");
  });
});
