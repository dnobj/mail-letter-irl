import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * The auth key's file is written for this process's user alone (#730), on any
 * platform: the mode asked of the filesystem is read here, since Windows does
 * not report it back (tailscaleDaemon.test.ts reads it back where it can).
 */

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

import { writeFile } from "node:fs/promises";
import { writeSecretFile } from "../../../src/admin/tailscale/daemon.js";

describe("the auth key's file", () => {
  it("is created new, readable and writable by its owner only", async () => {
    const file = await writeSecretFile("tskey-auth-kTEST-secret");
    try {
      expect(vi.mocked(writeFile)).toHaveBeenCalledWith(file.path, "tskey-auth-kTEST-secret", { mode: 0o600, flag: "wx" });
    } finally {
      await file.remove();
    }
  });

  it("leaves no directory behind when the write fails", async () => {
    let written = "";
    vi.mocked(writeFile).mockImplementationOnce(async (path) => {
      written = String(path);
      throw new Error("ENOSPC");
    });
    await expect(writeSecretFile("tskey-auth-kTEST-secret")).rejects.toThrow("ENOSPC");
    expect(written).not.toBe("");
    expect(existsSync(dirname(written))).toBe(false);
  });
});
