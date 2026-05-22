import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { roomIdForCwd } from "./rooms.js";

describe("roomIdForCwd", () => {
  test("deterministic for the same cwd", () => {
    const a = roomIdForCwd("/tmp/some/path/that/may/not/exist");
    const b = roomIdForCwd("/tmp/some/path/that/may/not/exist");
    expect(a).toBe(b);
  });

  test("different cwds produce different ids", () => {
    const a = roomIdForCwd("/tmp/path/a");
    const b = roomIdForCwd("/tmp/path/b");
    expect(a).not.toBe(b);
  });

  test("id is 12-char base64url (safe in URLs / log lines)", () => {
    const id = roomIdForCwd("/tmp/path/c");
    expect(id).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  test("realpath: symlinks resolve to the same id", () => {
    // Real fs setup: dir + symlink → dir. Both must produce identical ids.
    const tmp = mkdtempSync(join(tmpdir(), "remote-pi-rooms-"));
    const real = join(tmp, "real");
    mkdirSync(real);
    writeFileSync(join(real, "marker"), "x");
    const link = join(tmp, "link");
    symlinkSync(real, link);

    expect(roomIdForCwd(real)).toBe(roomIdForCwd(link));
  });

  test("non-existent cwd falls back to raw-path hash (no throw)", () => {
    const id = roomIdForCwd("/no/such/path/anywhere/xyz");
    expect(id).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });
});
