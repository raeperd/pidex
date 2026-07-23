import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalWorkspace, isDescendant, parsePort, safeError } from "./security.js";

describe("local security", () => {
  it("rejects path-prefix traps and symlink escapes", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "pidex-path-")); const root = path.join(base, "work"); const outside = path.join(base, "workspace-evil");
    await mkdir(root); await mkdir(outside); await symlink(outside, path.join(root, "escape")); const canonicalRoot = await realpath(root);
    expect(isDescendant(canonicalRoot, outside)).toBe(false);
    await expect(canonicalWorkspace(path.join(root, "escape"), [canonicalRoot])).rejects.toMatchObject({ status: 403 });
    await expect(canonicalWorkspace(outside, [canonicalRoot])).rejects.toMatchObject({ status: 403 });
  });
  it("validates ports and redacts obvious bearer secrets", () => {
    expect(parsePort("4783")).toBe(4783); expect(() => parsePort("80")).toThrow(/1024/); expect(() => parsePort("oops")).toThrow(/integer/);
    expect(safeError(new Error("Bearer secret-token-value"))).not.toContain("secret-token-value");
  });
});
