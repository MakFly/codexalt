import { describe, expect, test } from "bun:test";
import { validateAlias, validateLabel } from "../src/validation";

describe("alias validation", () => {
  test.each(["personal", "work-2", "a_b", "x"])("accepts %s", (alias) => {
    expect(validateAlias(alias)).toBe(alias);
  });

  test.each(["../escape", "UPPER", "-bad", "", "a".repeat(33), "account", "doctor"])(
    "rejects %s",
    (alias) => expect(() => validateAlias(alias)).toThrow(),
  );
});

describe("account label validation", () => {
  test("normalizes a human-readable label", () => {
    expect(validateLabel("  kev@example.com  ")).toBe("kev@example.com");
  });

  test.each([
    "", " ", "bad\nlabel", "x".repeat(81), "bad\u009b31m", "left\u202eright", "line\u2028break", "zero\u200bwidth",
  ])("rejects %j", (label) => {
    expect(() => validateLabel(label)).toThrow();
  });
});
