import { createHash } from "node:crypto";

export function sessionRouteId(workspaceId: string, nativeSessionKey: string) {
  return createHash("sha256")
    .update(workspaceId)
    .update("\0")
    .update(nativeSessionKey)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}
