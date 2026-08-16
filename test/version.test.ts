import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { VERSION } from "../src/cli";

describe("version", () => {
  // The release workflow refuses a tag whose name, package version, and binary
  // version disagree. Catch that locally instead of at tag time.
  test("keeps the compiled version in sync with package.json", async () => {
    const manifest = await Bun.file(join(import.meta.dir, "../package.json")).json();
    expect(VERSION).toBe(manifest.version);
  });
});
