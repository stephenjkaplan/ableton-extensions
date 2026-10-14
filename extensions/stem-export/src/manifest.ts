import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeName, type Manifest } from "./manifest-core.js";

// The pure half (types, BACKING, resolve, safeName) lives in manifest-core.ts so it can be bundled for a
// browser; this module adds the file I/O and re-exports the rest so existing imports keep working.
export * from "./manifest-core.js";

export function manifestPath(storageDir: string, song: string): string {
  return join(storageDir, "manifests", `${safeName(song)}.json`);
}

export function saveManifest(m: Manifest, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(m, null, 2), "utf8");
  renameSync(tmpPath, path);
}

export function loadManifest(path: string): Manifest | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (typeof data !== "object" || data === null || typeof data.song !== "string" || typeof data.stems !== "object" || data.stems === null) {
      throw new Error(`Invalid manifest format in ${path}: missing or invalid song/stems`);
    }
    return data as Manifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** True when `m` has everything the rest of the extension iterates over: stems with `trackKeys` arrays, and `extras`. */
export function isSoundManifest(m: Manifest): boolean {
  return Array.isArray(m.extras) && m.extras.every((e) => Array.isArray(e?.trackKeys)) &&
    Object.values(m.stems).every((s) => Array.isArray(s?.trackKeys));
}

/**
 * What is saved at `path`, without ever throwing: nothing, a usable manifest, or a file that exists but
 * cannot be used (unreadable, corrupt JSON, or missing the parts the extension iterates over).
 */
export function readSaved(path: string):
  { kind: "none" } | { kind: "ok"; manifest: Manifest } | { kind: "unreadable" } {
  try {
    const m = loadManifest(path);
    if (m === null) return { kind: "none" };
    return isSoundManifest(m) ? { kind: "ok", manifest: m } : { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
  }
}
