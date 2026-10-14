import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAll } from "../src/extension.js";

// A minimal fake of the SDK context: just enough for registerAll and the abort command
// (which finds no run record and says so).
function fakeContext(env: { storageDirectory?: string; tempDirectory?: string }) {
  const commands = new Map<string, () => Promise<void>>();
  const context = {
    commands: { registerCommand: (id: string, cb: () => Promise<void>) => void commands.set(id, cb) },
    ui: {
      registerContextMenuAction: async () => () => {},
      showModalDialog: async () => "",
    },
    environment: env,
    application: { song: { tracks: [], returnTracks: [], mainTrack: { name: "Main", mute: false, groupTrack: null, devices: [] } } },
    withinTransaction: async (f: () => unknown) => f(),
  };
  return { commands, context };
}

afterEach(() => vi.restoreAllMocks());

describe("lifecycle logging", () => {
  it("logs activation with the pid and both folders", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { context } = fakeContext({ storageDirectory: "/tmp/s", tempDirectory: "/tmp/t" });
    registerAll(context as never);
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("activated"));
    expect(line).toBeDefined();
    expect(line).toContain(`pid=${process.pid}`);
    expect(line).toContain("storage=/tmp/s");
    expect(line).toContain("temp=/tmp/t");
  });

  it("says so when Live supplies no folders, rather than hiding it", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { context } = fakeContext({});
    registerAll(context as never);
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("activated"));
    expect(line).toContain("storage=(none)");
    expect(line).toContain("temp=(none)");
  });

  it("numbers each invocation and logs start and finish, so residency is visible", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { context, commands } = fakeContext({ storageDirectory: "/tmp/s-log", tempDirectory: "/tmp/t-log" });
    registerAll(context as never);
    await commands.get("stem-export.abort")!();
    await commands.get("stem-export.abort")!();
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("stem-export.abort started (invocation #1"))).toBe(true);
    expect(lines.some((l) => l.includes("stem-export.abort started (invocation #2"))).toBe(true);
    expect(lines.filter((l) => l.includes("stem-export.abort finished in")).length).toBe(2);
    expect(lines.every((l) => l.startsWith("[stem-export] "))).toBe(true);
  });
});
