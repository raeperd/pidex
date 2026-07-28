import path from "node:path";

export function resolveStateDirectory(
  userDataDirectory: string,
  configuredDirectory = process.env.PIDEX_STATE_DIR,
): string {
  return configuredDirectory ?? path.join(userDataDirectory, "state");
}
