import type { ConnectionState } from "./AppShellConnection";

/** `"disconnected"` (offline) is gated the same as `"reconnecting"` — a uniform delay, no special case. */
export function connectionBanner(
  connection: ConnectionState,
  hasEverConnected: boolean,
  delayElapsed: boolean,
): "connecting" | "reconnecting" | undefined {
  if (connection === "connected" || !delayElapsed) return undefined;
  return hasEverConnected ? "reconnecting" : "connecting";
}
