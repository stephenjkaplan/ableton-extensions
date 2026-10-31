import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../../../scripts/sync-manifest-version.mjs");

describe("sync-manifest-version", () => {
  const tool = (pkg: string, manifest: object) => {
    const d = mkdtempSync(join(tmpdir(), "sk-version-"));
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "t", version: pkg }));
    writeFileSync(join(d, "manifest.json"), JSON.stringify(manifest, null, 4) + "\n");
    return d;
  };
  const read = (d: string) => readFileSync(join(d, "manifest.json"), "utf8");

  it("copies the version from package.json into manifest.json", () => {
    const d = tool("0.9.0", { name: "t", version: "0.3.0" });
    execFileSync("node", [SCRIPT], { cwd: d });
    expect(JSON.parse(read(d)).version).toBe("0.9.0");
  });

  it("leaves everything else in the manifest as it was, including its formatting", () => {
    const d = tool("0.9.0", { name: "t", entry: "dist/extension.js", version: "0.3.0", minimumApiVersion: "1.0.0" });
    const before = read(d);
    execFileSync("node", [SCRIPT], { cwd: d });
    expect(read(d)).toBe(before.replace("0.3.0", "0.9.0"));
  });
});
