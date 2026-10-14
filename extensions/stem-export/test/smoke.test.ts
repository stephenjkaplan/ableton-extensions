import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("scaffold", () => {
  it("manifest declares the entry point and api version", () => {
    const m = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
    expect(m.entry).toMatch(/dist\/extension\.js$/);
    expect(m.minimumApiVersion).toBe("1.0.0");
    expect(m.name).toBeTruthy();
  });
});
