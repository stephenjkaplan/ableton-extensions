import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWav, sumAudio, writeWav24, type Audio } from "../src/audio.js";
import type { Pass } from "../src/plan.js";
import {
  advance, applyPass, beginRun, ordinalKeys, clearRunState, discardRunState, finalize, findCollisions, isStemRender,
  loadRunState, recoverRun, restoreAuthorState, runStatePath, saveRunState,
  type LiveBridge, type RunState,
} from "../src/run.js";

/**
 * A fake Live. Like the real SDK, it only accepts mutations while inside `transaction`'s
 * synchronous callback: setMute/setSolo/setEnabled throw if called outside it. A mutation
 * started after an `await` inside the callback is therefore caught too.
 */
function fakeBridge(
  names: string[], muted: string[] = [], master: string[] = [], soloed: string[] = [],
  returns: Record<string, boolean> = {},   // return track name -> soloed
) {
  const mutes = new Map(names.map((n) => [n, muted.includes(n)]));
  const solos = new Map(names.map((n) => [n, soloed.includes(n)]));
  const enabled = new Map(master.map((n) => [n, true]));
  const returnSolos = new Map(Object.entries(returns));
  const returnMutes = new Map(Object.keys(returns).map((n) => [n, false]));
  let inTx = false;
  const guard = (what: string) => {
    if (!inTx) throw new Error(`${what} called outside a transaction`);
  };
  const bridge: LiveBridge = {
    tracks: async () => names.map((key) => ({
      key,
      getMute: () => mutes.get(key)!,
      setMute: (v: boolean) => { guard("setMute"); mutes.set(key, v); },
      getSolo: () => solos.get(key)!,
      setSolo: (v: boolean) => { guard("setSolo"); solos.set(key, v); },
    })),
    returnTracks: async () => [...returnSolos.keys()].map((n) => ({
      key: `return:${n}`,
      getMute: () => returnMutes.get(n)!,
      setMute: (v: boolean) => { guard("setMute"); returnMutes.set(n, v); },
      getSolo: () => returnSolos.get(n)!,
      setSolo: (v: boolean) => { guard("setSolo"); returnSolos.set(n, v); },
    })),
    masterDevices: async () => master.map((name) => ({
      name,
      isEnabled: async () => enabled.get(name)!,
      setEnabled: async (v: boolean) => { guard("setEnabled"); enabled.set(name, v); },
    })),
    transaction: async <T,>(fn: () => T | Promise<T>) => {
      inTx = true;
      let r: T | Promise<T>;
      try { r = fn(); } finally { inTx = false; }   // sync callback, as in the SDK
      return r;
    },
  };
  return { bridge, mutes, solos, enabled, returnSolos, returnMutes };
}

const pass = (name: string, include: string[], exclude: string[]): Pass =>
  ({ kind: "stem", name, include, exclude, outputName: `Song (${name}).wav` });
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const statePathIn = (song = "Song") => runStatePath(tmp("sk-state-"), song);

describe("run engine", () => {
  it("the fake enforces the transaction rule (so the tests below mean something)", async () => {
    const { bridge } = fakeBridge(["Kick"], [], ["Limiter"]);
    const [t] = await bridge.tracks();
    const [d] = await bridge.masterDevices();
    expect(() => t.setMute(true)).toThrow(/outside a transaction/);
    expect(() => t.setSolo(true)).toThrow(/outside a transaction/);
    await expect(d.setEnabled(false)).rejects.toThrow(/outside a transaction/);
    await bridge.transaction(() => t.setMute(true));
    expect(t.getMute()).toBe(true);
    // A mutation started after an await inside the callback is outside the transaction.
    await expect(bridge.transaction(async () => { await Promise.resolve(); t.setMute(false); }))
      .rejects.toThrow(/outside a transaction/);
  });

  it("captures author state and bypasses master before mutating", async () => {
    const { bridge, enabled } = fakeBridge(["Kick", "Bass"], ["Bass"], ["Limiter"]);
    const s = await beginRun(bridge, [pass("Drums", ["Kick"], ["Bass"])], "Song", statePathIn());
    expect(s.author.mutes).toEqual({ Kick: false, Bass: true });
    expect(s.author.masterEnabled).toEqual({ Limiter: true });
    expect(enabled.get("Limiter")).toBe(false);
  });

  it("applyPass mutes exactly the excluded tracks", async () => {
    const { bridge, mutes } = fakeBridge(["Kick", "Bass"]);
    const s = await beginRun(bridge, [pass("Drums", ["Kick"], ["Bass"])], "Song", statePathIn());
    await applyPass(bridge, s);
    expect(mutes.get("Kick")).toBe(false);
    expect(mutes.get("Bass")).toBe(true);
  });

  it("restores author state exactly, including pre-existing mutes", async () => {
    const { bridge, mutes, enabled } = fakeBridge(["Kick", "Bass"], ["Bass"], ["Limiter"]);
    const s = await beginRun(bridge, [pass("Drums", ["Kick"], ["Bass"])], "Song", statePathIn());
    await applyPass(bridge, s);
    await restoreAuthorState(bridge, s);
    expect(mutes.get("Kick")).toBe(false);
    expect(mutes.get("Bass")).toBe(true);
    expect(enabled.get("Limiter")).toBe(true);
  });

  it("clears an active solo for the run and restores it exactly", async () => {
    const { bridge, solos, mutes } = fakeBridge(["Kick", "Bass", "Pad"], ["Pad"], [], ["Bass"]);
    const s = await beginRun(bridge, [pass("Drums", ["Kick"], ["Bass", "Pad"])], "Song", statePathIn());
    expect(s.author.solos).toEqual({ Kick: false, Bass: true, Pad: false });
    expect([...solos.values()]).toEqual([false, false, false]);   // nothing soloed after beginRun
    await applyPass(bridge, s);
    expect([...solos.values()]).toEqual([false, false, false]);
    await restoreAuthorState(bridge, s);
    expect(Object.fromEntries(solos)).toEqual({ Kick: false, Bass: true, Pad: false });
    expect(mutes.get("Pad")).toBe(true);
  });

  it("ordinalKeys numbers only genuine duplicates, in order", () => {
    expect(ordinalKeys(["A", "B", "A", "C"])).toEqual(["A#1", "B", "A#2", "C"]);
    expect(ordinalKeys(["A-Reverb", "B-Delay"])).toEqual(["A-Reverb", "B-Delay"]);
  });

  it("a soloed RETURN is cleared by beginRun and restored afterwards", async () => {
    const f = fakeBridge(["Kick", "Bass"], [], [], [], { "A-Reverb": true, "B-Delay": false });
    const s = await beginRun(f.bridge, [pass("Drums", ["Kick"], ["Bass"])], "Song", statePathIn());
    expect(s.author.returnSolos).toEqual({ "return:A-Reverb": true, "return:B-Delay": false });
    expect(s.author.solos).toEqual({ Kick: false, Bass: false });   // keyed apart from tracks
    expect([...f.returnSolos.values()]).toEqual([false, false]);    // nothing soloed
    await applyPass(f.bridge, s);
    expect([...f.returnSolos.values()]).toEqual([false, false]);
    await restoreAuthorState(f.bridge, s);
    expect(Object.fromEntries(f.returnSolos)).toEqual({ "A-Reverb": true, "B-Delay": false });
  });

  it("returns are never muted by applyPass, whatever the pass excludes", async () => {
    const f = fakeBridge(["Kick", "Bass"], [], [], [], { "A-Reverb": false });
    const s = await beginRun(f.bridge, [pass("Drums", ["Kick"], ["Bass"])], "Song", statePathIn());
    await applyPass(f.bridge, s);
    expect(f.returnMutes.get("A-Reverb")).toBe(false);
  });

  it("applyPass clears a return solo the author switched on between passes", async () => {
    const f = fakeBridge(["Kick"], [], [], [], { "A-Reverb": false });
    const s = await beginRun(f.bridge, [pass("Drums", ["Kick"], [])], "Song", statePathIn());
    f.returnSolos.set("A-Reverb", true);
    await applyPass(f.bridge, s);
    expect(f.returnSolos.get("A-Reverb")).toBe(false);
  });

  it("a return solo survives a crash: cold-start recovery restores it", async () => {
    const path = statePathIn();
    const f = fakeBridge(["Kick"], [], [], [], { "A-Reverb": true });
    await beginRun(f.bridge, [pass("Drums", ["Kick"], [])], "Song", path);
    expect(f.returnSolos.get("A-Reverb")).toBe(false);
    expect((await recoverRun(f.bridge, path, "Song")).status).toBe("restored");
    expect(f.returnSolos.get("A-Reverb")).toBe(true);
  });

  it("rolls back a cleared return solo if the bypass fails", async () => {
    const f = fakeBridge(["Kick"], [], [], [], { "A-Reverb": true });
    const bridge: LiveBridge = {
      ...f.bridge,
      masterDevices: async () => [{
        name: "A", isEnabled: async () => true,
        setEnabled: async (v: boolean) => { if (!v) throw new Error("boom"); },
      }],
    };
    await expect(beginRun(bridge, [pass("D", [], [])], "Song", statePathIn())).rejects.toThrow("boom");
    expect(f.returnSolos.get("A-Reverb")).toBe(true);
  });

  it("restore reports a return that has gone, and still restores the rest", async () => {
    const f = fakeBridge(["Kick"], [], [], [], { "A-Reverb": true, "B-Delay": true });
    const s = await beginRun(f.bridge, [pass("D", ["Kick"], [])], "Song", statePathIn());
    const g = fakeBridge(["Kick"], [], [], [], { "B-Delay": false });
    await expect(restoreAuthorState(g.bridge, s)).rejects.toThrow(/return track "return:A-Reverb" is no longer/);
    expect(g.returnSolos.get("B-Delay")).toBe(true);
  });

  it("applyPass clears a solo the author switched on between passes", async () => {
    const { bridge, solos } = fakeBridge(["Kick", "Bass"]);
    const s = await beginRun(bridge, [pass("Drums", ["Kick"], ["Bass"])], "Song", statePathIn());
    solos.set("Bass", true);
    await applyPass(bridge, s);
    expect(solos.get("Bass")).toBe(false);
  });

  it("restores a Master device the author had already switched off as off", async () => {
    const { bridge, enabled } = fakeBridge(["Kick"], [], ["Limiter", "Glue"]);
    enabled.set("Glue", false);
    const s = await beginRun(bridge, [pass("D", ["Kick"], [])], "Song", statePathIn());
    expect(s.author.masterEnabled).toEqual({ Limiter: true, Glue: false });
    await restoreAuthorState(bridge, s);
    expect(enabled.get("Limiter")).toBe(true);
    expect(enabled.get("Glue")).toBe(false);
  });

  it("keeps same-named Master devices apart", async () => {
    const { bridge } = fakeBridge(["Kick"]);
    // The fake keys devices by name, so build the duplicate case by hand.
    const state = [true, false];
    const b: LiveBridge = {
      ...bridge,
      masterDevices: async () => state.map((_, i) => ({
        name: "EQ Eight",
        isEnabled: async () => state[i],
        setEnabled: async (v: boolean) => void (state[i] = v),
      })),
    };
    const s = await beginRun(b, [pass("D", ["Kick"], [])], "Song", statePathIn());
    expect(s.author.masterEnabled).toEqual({ "EQ Eight#1": true, "EQ Eight#2": false });
    expect(state).toEqual([false, false]);
    await restoreAuthorState(b, s);
    expect(state).toEqual([true, false]);
  });

  describe("author state is sacred", () => {
    it("persists the author state to disk BEFORE the first mutation", async () => {
      const path = statePathIn();
      const seenOnDisk: (RunState | null)[] = [];
      const { bridge } = fakeBridge(["Kick", "Bass"], ["Bass"], ["Limiter"]);
      const spying: LiveBridge = {
        ...bridge,
        masterDevices: async () => (await bridge.masterDevices()).map((d) => ({
          ...d,
          setEnabled: async (v: boolean) => { seenOnDisk.push(loadRunState(path)); await d.setEnabled(v); },
        })),
      };
      await beginRun(spying, [pass("Drums", ["Kick"], ["Bass"])], "Song", path);
      expect(seenOnDisk).toHaveLength(1);
      expect(seenOnDisk[0]!.author).toEqual({
        mutes: { Kick: false, Bass: true }, solos: { Kick: false, Bass: false }, returnSolos: {},
        masterEnabled: { Limiter: true } });
    });

    it("run state survives a cold start so a crash is recoverable", async () => {
      const path = statePathIn();
      const { bridge, mutes, enabled, solos } = fakeBridge(["Kick", "Bass"], ["Bass"], ["Limiter"], ["Kick"]);
      const s = await beginRun(bridge, [pass("Drums", ["Kick"], ["Bass"])], "Song", path);
      await applyPass(bridge, s);
      mutes.set("Kick", true);   // the crash left the Set in a mutated state
      // ...new process: nothing in memory except the file.
      const r = await recoverRun(bridge, path, "Song");
      expect(r.status).toBe("restored");
      expect(mutes.get("Kick")).toBe(false);
      expect(mutes.get("Bass")).toBe(true);
      expect(solos.get("Kick")).toBe(true);
      expect(enabled.get("Limiter")).toBe(true);
      expect(existsSync(path)).toBe(false);
    });

    it("recoverRun with no file does nothing", async () => {
      const { bridge } = fakeBridge(["Kick"]);
      expect(await recoverRun(bridge, statePathIn(), "Song")).toEqual({ status: "none" });
    });

    it("state files are per song, so project B never sees project A's", () => {
      const dir = tmp("sk-per-song-");
      expect(runStatePath(dir, "A")).not.toBe(runStatePath(dir, "B"));
      expect(runStatePath(dir, "AC/DC").startsWith(dir)).toBe(true);
      expect(runStatePath(dir, "AC/DC")).not.toContain("AC/DC");
    });

    it("recoverRun refuses a state recorded for a different song, touching nothing", async () => {
      const path = statePathIn("A");
      const a = fakeBridge(["Kick", "Bass"], ["Bass"], ["Limiter"]);
      await beginRun(a.bridge, [pass("D", ["Kick"], ["Bass"])], "A", path);
      const before = readFileSync(path, "utf8");
      // Project B has same-named tracks in a different state, opened under A's file path.
      const b = fakeBridge(["Kick", "Bass"], [], ["Limiter"]);
      const r = await recoverRun(b.bridge, path, "B");
      expect(r.status).toBe("different-song");
      expect((r as { state: RunState }).state.song).toBe("A");
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(b.mutes.get("Bass")).toBe(false);          // A's mute NOT applied to B
      expect(b.enabled.get("Limiter")).toBe(true);      // nor A's bypass
    });

    it("recoverRun keeps the file when the restore fails", async () => {
      const path = statePathIn();
      const { bridge } = fakeBridge(["Kick"], [], ["Limiter"]);
      await beginRun(bridge, [pass("D", ["Kick"], [])], "Song", path);
      const gone = fakeBridge([], [], []);   // Set no longer has any of it
      await expect(recoverRun(gone.bridge, path, "Song")).rejects.toThrow(/Could not fully restore/);
      expect(existsSync(path)).toBe(true);
    });

    it("discardRunState unblocks a run that can never be restored, without touching Live", async () => {
      const path = statePathIn();
      const { bridge, enabled } = fakeBridge(["Kick"], [], ["Limiter"]);
      await beginRun(bridge, [pass("D", ["Kick"], [])], "Song", path);
      const gone = fakeBridge([], [], []);
      await expect(recoverRun(gone.bridge, path, "Song")).rejects.toThrow();
      await expect(beginRun(gone.bridge, [pass("D", [], [])], "Song", path)).rejects.toThrow(/never restored/);
      expect(discardRunState(path)).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(enabled.get("Limiter")).toBe(false);   // Live untouched: still the mutated state
      expect(discardRunState(path)).toBe(false);    // idempotent
      await beginRun(gone.bridge, [pass("D", [], [])], "Song", path);   // now allowed
    });

    it("discardRunState works on a corrupt file", () => {
      const path = statePathIn();
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "{not json");
      expect(discardRunState(path)).toBe(true);
      expect(existsSync(path)).toBe(false);
    });

    it("refuses to begin while an unrestored run exists, and leaves everything alone", async () => {
      const path = statePathIn();
      const { bridge, mutes, enabled } = fakeBridge(["Kick", "Bass"], ["Bass"], ["Limiter"]);
      const first = await beginRun(bridge, [pass("D", ["Kick"], ["Bass"])], "Song", path);
      await applyPass(bridge, first);                  // the Set is now mutated
      const before = readFileSync(path, "utf8");
      await expect(beginRun(bridge, [pass("D", ["Kick"], ["Bass"])], "Song", path))
        .rejects.toThrow(/never restored/);
      expect(readFileSync(path, "utf8")).toBe(before); // true original NOT overwritten
      expect(JSON.parse(before).author.mutes.Bass).toBe(true);
      expect(enabled.get("Limiter")).toBe(false);      // untouched by the refused call
      void mutes;
    });

    it("a corrupt state file also blocks a new run rather than being overwritten", async () => {
      const path = statePathIn();
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "{not json");
      const { bridge } = fakeBridge(["Kick"]);
      await expect(beginRun(bridge, [pass("D", ["Kick"], [])], "Song", path)).rejects.toThrow(/never restored/);
      expect(readFileSync(path, "utf8")).toBe("{not json");
    });

    it("rolls back and clears the file if bypassing the Master fails partway", async () => {
      const path = statePathIn();
      const on = new Map([["A", true], ["B", true]]);
      const f = fakeBridge([]);
      const bridge: LiveBridge = {
        ...f.bridge,
        masterDevices: async () => ["A", "B"].map((name) => ({
          name,
          isEnabled: async () => on.get(name)!,
          setEnabled: async (v: boolean) => {
            if (name === "B" && v === false) throw new Error("boom");
            on.set(name, v);
          },
        })),
      };
      await expect(beginRun(bridge, [pass("D", [], [])], "Song", path)).rejects.toThrow("boom");
      expect(on.get("A")).toBe(true);
      expect(on.get("B")).toBe(true);
      expect(existsSync(path)).toBe(false);
    });

    it("rollback does not race a disable that is still in flight when another one fails", async () => {
      const path = statePathIn();
      const on = new Map([["Slow", true], ["Bad", true]]);
      const f = fakeBridge([]);
      const bridge: LiveBridge = {
        ...f.bridge,
        // Bad is first and fails at once; Slow's disable lands later.
        masterDevices: async () => ["Bad", "Slow"].map((name) => ({
          name,
          isEnabled: async () => on.get(name)!,
          setEnabled: async (v: boolean) => {
            if (name === "Bad" && v === false) throw new Error("boom");
            if (name === "Slow" && v === false) await new Promise((r) => setTimeout(r, 25));
            on.set(name, v);
          },
        })),
      };
      await expect(beginRun(bridge, [pass("D", [], [])], "Song", path)).rejects.toThrow("boom");
      await new Promise((r) => setTimeout(r, 60));   // let any stray late write land
      expect(on.get("Slow")).toBe(true);
      expect(on.get("Bad")).toBe(true);
    });

    it("rolls back solo clearing too if the bypass fails", async () => {
      const path = statePathIn();
      const f = fakeBridge(["Kick", "Bass"], [], [], ["Bass"]);
      const bridge: LiveBridge = {
        ...f.bridge,
        masterDevices: async () => [{
          name: "A", isEnabled: async () => true,
          setEnabled: async (v: boolean) => { if (!v) throw new Error("boom"); },
        }],
      };
      await expect(beginRun(bridge, [pass("D", [], [])], "Song", path)).rejects.toThrow("boom");
      expect(f.solos.get("Bass")).toBe(true);
      expect(existsSync(path)).toBe(false);
    });

    it("keeps the file if that rollback itself fails", async () => {
      const path = statePathIn();
      const bridge: LiveBridge = {
        ...fakeBridge([]).bridge,
        masterDevices: async () => [{
          name: "A", isEnabled: async () => true,
          setEnabled: async () => { throw new Error("nope"); },
        }],
      };
      await expect(beginRun(bridge, [pass("D", [], [])], "Song", path)).rejects.toThrow("nope");
      expect(existsSync(path)).toBe(true);
    });

    it("restore carries on past a missing track and reports it", async () => {
      const { bridge, mutes } = fakeBridge(["Kick", "Bass"], ["Bass"], ["Limiter"]);
      const s = await beginRun(bridge, [pass("D", ["Kick"], ["Bass"])], "Song", statePathIn());
      await applyPass(bridge, s);
      const without = fakeBridge(["Bass"], [], ["Limiter"]);   // Kick was deleted
      without.enabled.set("Limiter", false);   // the bridge being restored, not the original
      await expect(restoreAuthorState(without.bridge, s)).rejects.toThrow(/"Kick" is no longer/);
      expect(without.mutes.get("Bass")).toBe(true);            // still restored
      expect(without.enabled.get("Limiter")).toBe(true);       // still restored
      void mutes;
    });

    it("loadRunState: null when absent, throws on an invalid file", () => {
      const p = statePathIn();
      expect(loadRunState(p)).toBeNull();
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, JSON.stringify({ song: "x" }));
      expect(() => loadRunState(p)).toThrow(/Invalid run state/);
    });

    it("saveRunState / loadRunState round-trip, clearRunState is idempotent", () => {
      const path = statePathIn();
      const s: RunState = { song: "S", passIndex: 1, passes: [pass("A", [], [])],
        author: { mutes: { A: true }, solos: { A: false }, returnSolos: { "return:R": true }, masterEnabled: { L: false } }, collected: { A: "/t/a.wav" } };
      saveRunState(s, path);
      expect(loadRunState(path)).toEqual(s);
      clearRunState(path);
      clearRunState(path);
      expect(existsSync(path)).toBe(false);
    });
  });

  it("a state file saved before solos existed still loads, with no solos to restore", () => {
    const p = statePathIn();
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify({ song: "S", passIndex: 0, passes: [], collected: {},
      author: { mutes: { A: true }, masterEnabled: {} } }));
    expect(loadRunState(p)!.author.solos).toEqual({});
    expect(loadRunState(p)!.author.returnSolos).toEqual({});
  });

  describe("applyPass", () => {
    it("an include track the author muted STAYS muted (author's mute is honoured)", async () => {
      const { bridge, mutes } = fakeBridge(["Kick", "Bass"], ["Kick"]);
      const s = await beginRun(bridge, [pass("Drums", ["Kick"], ["Bass"])], "Song", statePathIn());
      await applyPass(bridge, s);
      expect(mutes.get("Kick")).toBe(true);    // not unmuted just because it is in include
      expect(mutes.get("Bass")).toBe(true);
    });

    it("always works from the author baseline, not the previous pass", async () => {
      const { bridge, mutes } = fakeBridge(["Kick", "Bass", "Old"], ["Old"]);
      const passes = [pass("Drums", ["Kick"], ["Bass"]), pass("Bass", ["Bass"], ["Kick"])];
      let s = await beginRun(bridge, passes, "Song", statePathIn());
      await applyPass(bridge, s);
      expect([mutes.get("Kick"), mutes.get("Bass")]).toEqual([false, true]);
      s = advance(s);
      await applyPass(bridge, s);
      expect([mutes.get("Kick"), mutes.get("Bass")]).toEqual([true, false]);  // Bass un-muted again
      expect(mutes.get("Old")).toBe(true);                                    // author mute kept
    });

    it("refuses, mutating nothing, when an excluded track is gone", async () => {
      const { bridge, mutes } = fakeBridge(["Kick"]);
      const s = await beginRun(bridge, [pass("D", ["Kick"], ["Ghost"])], "Song", statePathIn());
      await expect(applyPass(bridge, s)).rejects.toThrow(/Ghost/);
      expect(mutes.get("Kick")).toBe(false);
    });

    it("throws when there is no pass left", async () => {
      const { bridge } = fakeBridge(["Kick"]);
      let s = await beginRun(bridge, [pass("D", ["Kick"], [])], "Song", statePathIn());
      s = advance(s);
      await expect(applyPass(bridge, s)).rejects.toThrow(/No pass/);
      expect(() => advance(s)).toThrow(/past the last/);
    });
  });

  it("advance moves to the next pass", () => {
    const s = { song: "Song", passIndex: 0, passes: [pass("A", [], []), pass("B", [], [])],
                author: { mutes: {}, solos: {}, returnSolos: {}, masterEnabled: {} }, collected: {} };
    expect(advance(s).passIndex).toBe(1);
    expect(s.passIndex).toBe(0);  // does not mutate its input
  });

  it("beginRun rejects passes that would overwrite each other, before touching anything", async () => {
    const { bridge, enabled } = fakeBridge(["Kick"], [], ["Limiter"]);
    const path = statePathIn();
    const extra: Pass = { kind: "extra", name: "Drums", include: [], exclude: [], outputName: "Song (Drums).wav" };
    await expect(beginRun(bridge, [pass("Drums", ["Kick"], []), extra], "Song", path))
      .rejects.toThrow(/Cannot start/);
    expect(enabled.get("Limiter")).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});

// ---------------------------------------------------------------- finalize

const SR = 48000;
function tone(freq: number, amp = 0.1, seconds = 1): Audio {
  const frames = SR * seconds, ch = new Float64Array(frames);
  for (let i = 0; i < frames; i++) ch[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return { channels: [ch, Float64Array.from(ch)], sampleRate: SR, frames };
}
const Float64Copy = (a: Audio): Audio =>
  ({ ...a, channels: a.channels.map((c) => Float64Array.from(c)) });
const silence = (seconds = 1): Audio => tone(220, 0, seconds);

interface Fixture { state: RunState; man: any; dir: string; song: string }
function fixture(opts: {
  song?: string;
  stems?: Record<string, Audio>;
  master?: Audio | null;
  extras?: Record<string, Audio>;
  outputName?: (kind: string, name: string) => string;
} = {}): Fixture {
  const song = opts.song ?? "Song";
  const dir = tmp("sk-out-");
  const renders = tmp("sk-renders-");
  const stems = opts.stems ?? { Drums: tone(220), Bass: tone(330) };
  const extras = opts.extras ?? {};
  const master = opts.master === undefined ? sumAudio(Object.values(stems)) : opts.master;
  const out = opts.outputName ?? ((k, n) => `${song} (${k === "master" ? "MASTER" : n}).wav`);

  const passes: Pass[] = [];
  const collected: Record<string, string> = {};
  const add = (kind: Pass["kind"], name: string, a: Audio) => {
    const p = join(renders, `${passes.length}.wav`);
    writeWav24(p, a);
    passes.push({ kind, name, include: [], exclude: [], outputName: out(kind, name) });
    collected[name] = p;
  };
  for (const [n, a] of Object.entries(stems)) add("stem", n, a);
  if (master) add("master", "— Master reference —", master);
  for (const [n, a] of Object.entries(extras)) add("extra", n, a);

  return {
    state: { song, passIndex: passes.length, passes, collected, author: { mutes: {}, solos: {}, returnSolos: {}, masterEnabled: {} } },
    man: { song, targetLufs: -18, truePeakCeilingDb: -6, appliedGainDb: null, stems: {}, extras: [] },
    dir, song,
  };
}
const codes = (r: ReturnType<typeof finalize>) => r.problems.map((p) => p.code);

describe("finalize", () => {
  it("writes gained stems under <outDir>/<song>/, nulls against the master, and reports ok", () => {
    const f = fixture();
    const r = finalize(f.state, f.man, f.dir);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.residualDb).toBeLessThan(-100);
    expect(typeof r.appliedGainDb).toBe("number");
    expect(r.files.map((x) => x.slice(f.dir.length + 1)).sort())
      .toEqual(["Song/Song (Bass).wav", "Song/Song (Drums).wav", "Song/Song (MASTER).wav"]);
    // The same gain landed on every file: written sum == master * gain.
    const sum = sumAudio(r.files.filter((x) => !x.includes("MASTER")).map((x) => readWav(x)));
    const ref = readWav(f.state.collected["— Master reference —"]);
    const g = 10 ** (r.appliedGainDb! / 20);
    let worst = 0;
    for (let i = 0; i < sum.frames; i += 97) worst = Math.max(worst, Math.abs(sum.channels[0][i] - ref.channels[0][i] * g));
    expect(worst).toBeLessThan(1e-5);
  });

  it("writes the Master reference too, with the same gain, so sum(stems) == master on disk", () => {
    const f = fixture();
    const r = finalize(f.state, f.man, f.dir);
    expect(r.ok).toBe(true);
    const names = r.files.map((x) => x.slice(f.dir.length + 1)).sort();
    expect(names).toEqual(["Song/Song (Bass).wav", "Song/Song (Drums).wav", "Song/Song (MASTER).wav"]);
    const written = (n: string) => readWav(join(f.dir, "Song", n));
    const stemSum = sumAudio([written("Song (Bass).wav"), written("Song (Drums).wav")]);
    const m = written("Song (MASTER).wav");
    let worst = 0;
    for (let i = 0; i < m.frames; i += 89) worst = Math.max(worst, Math.abs(stemSum.channels[0][i] - m.channels[0][i]));
    expect(worst).toBeLessThan(1e-5);
    // and it really was gained, not copied
    const orig = readWav(f.state.collected["— Master reference —"]);
    expect(Math.abs(r.appliedGainDb!)).toBeGreaterThan(0.1);
    expect(m.channels[0][1234]).toBeCloseTo(orig.channels[0][1234] * 10 ** (r.appliedGainDb! / 20), 5);
    expect(m.channels[0][1234]).not.toBeCloseTo(orig.channels[0][1234], 3);
  });

  it("puts extras in Extras/ with the same gain as the stems", () => {
    const f = fixture({ extras: { "Vox Only": tone(440) } });
    const r = finalize(f.state, f.man, f.dir);
    expect(r.ok).toBe(true);
    const extra = r.files.find((x) => x.includes("Extras"))!;
    expect(extra.slice(f.dir.length + 1)).toBe("Song/Extras/Song (Vox Only).wav");
    const written = readWav(extra), orig = readWav(f.state.collected["Vox Only"]);
    const g = 10 ** (r.appliedGainDb! / 20);
    expect(written.channels[0][1234]).toBeCloseTo(orig.channels[0][1234] * g, 5);
  });

  it("finalize keeps output inside outDir even for a hostile song name", () => {
    const f = fixture({ song: "AC/DC", outputName: (_k, n) => `AC/DC (${n}).wav` });
    const out = finalize(f.state, f.man, f.dir);
    expect(out.files.length).toBeGreaterThan(0);
    for (const file of out.files) {
      expect(file.startsWith(f.dir)).toBe(true);
      expect(file).not.toContain(`${f.dir}/AC/DC`);   // "/" must not have created a nested dir
    }
    expect(readdirSync(f.dir)).toEqual(["AC_DC"]);
  });

  it("sanitises output names that try to climb out of the song folder", () => {
    const g = fixture({ outputName: (_k, n) => `../../escape-${n}.wav` });
    const r = finalize(g.state, g.man, g.dir);
    expect(r.ok).toBe(true);
    for (const file of r.files) expect(file.startsWith(join(g.dir, "Song") + "/")).toBe(true);
    expect(r.files.map((x) => x.slice(g.dir.length + 1)).sort())
      .toEqual(["Song/.._.._escape-Bass.wav", "Song/.._.._escape-Drums.wav",
                "Song/.._.._escape-— Master reference —.wav"]);
    expect(existsSync(join(g.dir, "..", "..", "escape-Drums.wav"))).toBe(false);
  });

  describe("silent master is not a pass", () => {
    it("flags a digitally silent Master reference rather than trusting the -Infinity null", () => {
      const f = fixture({ master: silence() });
      const r = finalize(f.state, f.man, f.dir);
      expect(r.ok).toBe(false);
      expect(codes(r)).toEqual(["master-silent"]);
      expect(r.residualDb).toBeNull();
    });

    it("flags silent stems AND silent master as a failure, writing nothing", () => {
      const f = fixture({ stems: { Drums: silence(), Bass: silence() }, master: silence() });
      const r = finalize(f.state, f.man, f.dir);
      expect(r.ok).toBe(false);
      expect(r.files).toEqual([]);
      expect(codes(r)).toEqual(["unreadable"]);   // gainFor cannot measure silence
      expect(readdirSync(f.dir)).toEqual([]);
    });

    it("flags a quiet-but-above-the-LUFS-gate Master: the case that would otherwise null to -Infinity", () => {
      // About -65 dBFS: loud enough to pass gainFor's -70 LUFS gate, so nothing else notices.
      const q = tone(220, 10 ** (-65 / 20));
      const f = fixture({ stems: { Drums: q }, master: Float64Copy(q) });
      const r = finalize(f.state, f.man, f.dir);
      expect(Number.isFinite(r.appliedGainDb!)).toBe(true);       // gainFor did not object
      expect(r.ok).toBe(false);
      expect(codes(r)).toEqual(["master-silent"]);
      expect(r.residualDb).toBeNull();                            // not the -Infinity that would "pass"
    });

    it("flags a Master that is below the null threshold as meaningless", () => {
      const f = fixture({ master: tone(220, 1e-5) });   // about -100 dBFS
      const r = finalize(f.state, f.man, f.dir);
      expect(codes(r)).toEqual(["master-silent"]);
    });
  });

  it("fails the null test when the stems do not account for the Master", () => {
    const f = fixture({ master: sumAudio([tone(220), tone(330), tone(550)]) });
    const r = finalize(f.state, f.man, f.dir);
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(["null-failed"]);
    expect(r.residualDb).toBeGreaterThan(-60);
    expect(r.files).toHaveLength(3);   // still delivered; the verdict is the flag
  });

  it("the null bar is relative: a quiet Master cannot pass on a residual only 10 dB under it", () => {
    // Master peaks near -48 dBFS; the stems miss a -65 dBFS component. 17 dB under the Master
    // is under the old absolute -60 but nowhere near 60 dB under it.
    const stem = tone(220, 10 ** (-50 / 20));
    const f = fixture({ stems: { Drums: stem }, master: sumAudio([stem, tone(1000, 10 ** (-65 / 20))]) });
    const r = finalize(f.state, f.man, f.dir);
    expect(r.residualDb).toBeLessThan(-60);
    expect(codes(r)).toEqual(["null-failed"]);
  });

  it("reports a missing Master reference pass", () => {
    const f = fixture({ master: null });
    const r = finalize(f.state, f.man, f.dir);
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(["no-master-reference"]);
    expect(r.files).toHaveLength(2);
    expect(r.residualDb).toBeNull();
  });

  it("reports a Master with a different length as a failed null, not a crash", () => {
    const f = fixture({ master: tone(220, 0.1, 2) });
    const r = finalize(f.state, f.man, f.dir);
    expect(codes(r)).toEqual(["null-failed"]);
  });

  describe("collisions", () => {
    it("an extra named the same as a stem does not overwrite it", () => {
      const f = fixture({ extras: { Drums: tone(440) } });
      f.state.passes[f.state.passes.length - 1].outputName = "Song (Drums).wav";
      const r = finalize(f.state, f.man, f.dir);
      expect(r.ok).toBe(false);
      expect(codes(r)).toContain("collision");
      expect(r.files).toEqual([]);
      expect(readdirSync(f.dir)).toEqual([]);
    });

    it("two names that only differ by an unsafe character collide", () => {
      const f = fixture({ outputName: (_k, n) => (n === "Drums" ? "a/b.wav" : "a_b.wav") });
      expect(codes(finalize(f.state, f.man, f.dir))).toContain("collision");
    });

    it("names that differ only by case collide (case-insensitive volumes)", () => {
      const f = fixture({ outputName: (_k, n) => (n === "Drums" ? "Mix.wav" : "MIX.WAV".replace("WAV", "wav")) });
      expect(codes(finalize(f.state, f.man, f.dir))).toContain("collision");
    });

    it("the Master reference output collides with a stem of the same file name", () => {
      const ps: Pass[] = [pass("A", [], []),
        { kind: "master", name: "M", include: [], exclude: [], outputName: "Song (A).wav" }];
      expect(findCollisions(ps)).toHaveLength(1);
    });

    it("two passes sharing a pass name are caught (collected is keyed by it)", () => {
      const ps: Pass[] = [pass("Drums", [], []), { ...pass("Drums", [], []), kind: "extra", outputName: "x.wav" }];
      expect(findCollisions(ps).join()).toMatch(/both named "Drums"/);
    });

    it("a stem cannot take the name of the Extras folder", () => {
      const ps: Pass[] = [{ ...pass("A", [], []), outputName: "extras" }];
      expect(findCollisions(ps)).toHaveLength(1);
    });

    it("the same file name is fine as a stem and as an extra (different folders)", () => {
      const ps: Pass[] = [pass("A", [], []), { ...pass("B", [], []), kind: "extra", outputName: "Song (A).wav" }];
      expect(findCollisions(ps)).toEqual([]);
    });
  });

  it("does not silently clip an extra that is louder than the stem sum", () => {
    // Quiet stems get a large positive song gain; an extra at 0.5 then lands far over full scale.
    const f = fixture({ stems: { Drums: tone(220, 0.02), Bass: tone(330, 0.02) }, extras: { "Hot": tone(440, 0.5) } });
    const r = finalize(f.state, f.man, f.dir);
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(["clipped"]);
    expect(r.problems[0].message).toContain("Hot");
    expect(r.files.some((x) => x.includes("Extras"))).toBe(false);   // not written
    expect(existsSync(join(f.dir, "Song", "Extras", "Song (Hot).wav"))).toBe(false);
    expect(r.files).toHaveLength(3);   // the rest still delivered
  });

  it("an extra that stays under full scale after gain is fine", () => {
    const f = fixture({ extras: { "Vox": tone(440, 0.1) } });
    expect(finalize(f.state, f.man, f.dir).ok).toBe(true);
  });

  it("reports a render that was never collected, writing nothing", () => {
    const f = fixture();
    delete f.state.collected.Bass;
    const r = finalize(f.state, f.man, f.dir);
    expect(codes(r)).toEqual(["missing-render"]);
    expect(r.files).toEqual([]);
  });

  it("reports a render that vanished from disk", () => {
    const f = fixture();
    f.state.collected.Bass = join(f.dir, "gone.wav");
    expect(codes(finalize(f.state, f.man, f.dir))).toEqual(["missing-render"]);
  });

  it("refuses to sum stems of different lengths, writing nothing", () => {
    const f = fixture({ stems: { Drums: tone(220, 0.1, 1), Bass: tone(330, 0.1, 2) }, master: tone(220) });
    const r = finalize(f.state, f.man, f.dir);
    expect(codes(r)).toEqual(["stems-unusable"]);
    expect(r.files).toEqual([]);
  });

  it("does not leave .partial files behind", () => {
    const f = fixture();
    finalize(f.state, f.man, f.dir);
    expect(readdirSync(join(f.dir, "Song")).filter((n) => n.endsWith(".partial"))).toEqual([]);
  });

  it("reports which files replaced existing ones, and nothing on a first export", () => {
    const f = fixture();
    const first = finalize(f.state, f.man, f.dir);
    expect(first.overwritten).toEqual([]);
    // A partial earlier export: only one of the three files is already there.
    const g = fixture();
    mkdirSync(join(g.dir, "Song"), { recursive: true });
    writeFileSync(join(g.dir, "Song", "Song (Bass).wav"), "old");
    const r = finalize(g.state, g.man, g.dir);
    expect(r.ok).toBe(true);                       // reported, not blocked
    expect(r.overwritten).toEqual([join(g.dir, "Song", "Song (Bass).wav")]);
    expect(r.files).toHaveLength(3);
    expect(readWav(join(g.dir, "Song", "Song (Bass).wav")).frames).toBeGreaterThan(0);  // really replaced
  });

  it("overwrites its own earlier export of the same song", () => {
    const f = fixture();
    finalize(f.state, f.man, f.dir);
    const again = finalize(f.state, f.man, f.dir);
    expect(again.ok).toBe(true);
    expect(again.overwritten.sort()).toEqual([...again.files].sort());
    expect(again.files).toHaveLength(3);
  });
});

describe("isStemRender", () => {
  it("ignores files that are not renders", () => {
    expect(isStemRender("Song (Drums).wav")).toBe(true);
    expect(isStemRender("Song (Drums).WAV")).toBe(true);
    expect(isStemRender("Song (Drums).aif")).toBe(true);
    expect(isStemRender("Song (Drums).AIFF")).toBe(true);
    expect(isStemRender("Song (Drums).wav.asd")).toBe(false);
    expect(isStemRender("Song (Drums).asd")).toBe(false);
    expect(isStemRender(".DS_Store")).toBe(false);
    expect(isStemRender("/x/y/.hidden.wav")).toBe(false);
    expect(isStemRender("notes.txt")).toBe(false);
    expect(isStemRender("noext")).toBe(false);
  });

  it("rejects empty files (still being written), directories, accepts real ones", () => {
    const dir = tmp("sk-isr-");
    writeFileSync(join(dir, "empty.wav"), "");
    writeFileSync(join(dir, "full.wav"), "RIFF");
    mkdirSync(join(dir, "folder.wav"));
    expect(isStemRender(join(dir, "empty.wav"))).toBe(false);
    expect(isStemRender(join(dir, "full.wav"))).toBe(true);
    expect(isStemRender(join(dir, "folder.wav"))).toBe(false);
  });
});
