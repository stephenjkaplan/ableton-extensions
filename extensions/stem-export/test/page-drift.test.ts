import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { check, manifestFromResponse, requestFor } from "../src/commands.js";
import { emptyManifest, type Manifest } from "../src/manifest-core.js";
import { snapshotSong, type TrackLike } from "../src/snapshot.js";
import type { KeyTap } from "../src/validate.js";
import { encodeRequest, type MappingRequest } from "../src/ui/protocol.js";

/**
 * The page validates with the bundled copy of the host's own modules. This test is what keeps that true: it
 * assembles the page exactly as `encodeRequest` does, runs ALL of its scripts (bundle, bridge, dialog) in a
 * `node:vm` context, presses Continue, and compares the findings the page computed with the findings the host
 * computes on Continue for the SAME reply. Any drift (a rule re-implemented in the page, a snapshot that does
 * not survive the data round trip, a different registry) shows up as a diff.
 */

type Scenario = {
  name: string;
  tracks: TrackLike[];
  master?: { name: string; enabled?: boolean }[];
  manifest: (m: Manifest) => void;
  taps?: KeyTap[];
  /** Selections made in the open dialog before Continue: [row index, stem ("" clears)]. */
  edits?: [number, string][];
  /** Rules that must be present, so a scenario cannot pass by both sides producing nothing. */
  expectRules: string[];
};

const mk = (name: string, groupTrack: TrackLike | null = null, o: Partial<TrackLike> = {}): TrackLike =>
  ({ name, mute: false, groupTrack, devices: [], ...o });

function simpleSet(): Record<string, TrackLike> {
  const grp = mk("Grp", null, { devices: [{ name: "EQ Eight" }] });
  return {
    grp, kick: mk("Kick", grp), snare: mk("Snare", grp), vox: mk("Vox"), pad: mk("Pad", null, { mute: true }), bass: mk("Bass"),
  };
}
const S = simpleSet();
// A muted group with an UNMUTED child: the child is silent only through its group (own mute false, effective true).
const OLD = mk("Old", null, { mute: true });
const HELD = [OLD, mk("Kid", OLD), mk("Lead")];
const ALL = Object.values(S);
const assign = (m: Manifest, stem: string, ...keys: string[]) => { (m.stems[stem] ??= { trackKeys: [] }).trackKeys.push(...keys); };

const SCENARIOS: Scenario[] = [
  { name: "clean", tracks: ALL, expectRules: ["master-clean", "backing-fallthrough", "muted-held-out"],
    manifest: (m) => { assign(m, "Drums", "Grp/Kick", "Grp/Snare"); assign(m, "Vocals", "Vox"); } },
  { name: "processed group split across stems", tracks: ALL, expectRules: ["split-group"],
    manifest: (m) => { assign(m, "Drums", "Grp/Kick"); assign(m, "Vocals", "Grp/Snare"); } },
  { name: "unknown stem name", tracks: ALL, expectRules: ["unknown-stem"],
    manifest: (m) => assign(m, "Drumz", "Vox") },
  { name: "a stem whose only track is muted", tracks: ALL, expectRules: ["muted-held-out"],
    manifest: (m) => { assign(m, "Drums", "Grp/Kick"); assign(m, "Keys - Played", "Pad"); } },
  { name: "an extra naming a muted track, and one naming a missing track (the page prunes the latter)", tracks: ALL,
    expectRules: ["extras-unresolved"],
    manifest: (m) => { m.extras.push({ name: "Held", trackKeys: ["Pad", "Vox"] }, { name: "Gone", trackKeys: ["Nope"] }); } },
  { name: "a sidechain key cut from a pass, with an enabled Main device", tracks: ALL, master: [{ name: "Limiter" }],
    expectRules: ["post-mixer-key", "master-live"],
    taps: [{ trackKey: "Bass", keyTrackKey: "Grp/Kick", keyTrackName: "Kick", tap: "Post Mixer" }],
    manifest: (m) => { assign(m, "Drums", "Grp/Kick"); assign(m, "Vocals", "Bass"); },
  },
  { name: "a child of a muted group: assigned to a stem and named in an extra", tracks: HELD,
    expectRules: ["muted-held-out", "extras-unresolved"],
    manifest: (m) => { assign(m, "Drums", "Old/Kid"); assign(m, "Vocals", "Lead"); m.extras.push({ name: "Kids", trackKeys: ["Old/Kid"] }); } },
  { name: "findings change after edits in the open dialog (clean seed, then a split)", tracks: ALL, expectRules: ["split-group"],
    manifest: (m) => { assign(m, "Drums", "Grp/Kick", "Grp/Snare"); },
    edits: [[2, "Vocals"]] },
];

function pageHarness(page: string) {
  const posted: string[] = [];
  const ctx: Record<string, unknown> = {};
  const rows: any[] = [];
  const node = (): any => ({
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    querySelector: () => null, querySelectorAll: () => [], appendChild() {}, setAttribute() {},
  });
  const nodes = new Map<string, any>();
  const document = {
    querySelector: (sel: string) => {
      if (!nodes.has(sel)) {
        const n = node();
        if (sel === "#rows") {
          n.appendChild = (r: unknown) => void rows.push(r);
          Object.defineProperty(n, "innerHTML", { set: () => { rows.length = 0; }, get: () => "" });
        }
        nodes.set(sel, n);
      }
      return nodes.get(sel);
    },
    querySelectorAll: () => [],
    createElement: () => {
      const row = node();
      const sel = node();
      row.querySelector = (s: string) => (s === "select" ? sel : null);
      return row;
    },
    addEventListener() {},
    body: node(),
  };
  Object.assign(ctx, {
    document, console,
    webkit: { messageHandlers: { live: { postMessage: (m: { params: string[] }) => posted.push(m.params[0]) } } },
  });
  ctx.window = ctx;
  vm.createContext(ctx);

  // The page as the dialog receives it: request, core, bridge, then the dialog script (the stylesheet has no JS).
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(scripts).toHaveLength(4);
  const [request, core, bridge, dialog] = scripts;
  vm.runInContext(request, ctx);
  vm.runInContext(core, ctx);
  // Record what the page's `StemCore.check` returns (the bundle's exports are getters, so replace the object), then run the dialog.
  vm.runInContext(
    `{ const real = StemCore.check; StemCore = { ...StemCore, check() { const r = real.apply(this, arguments); globalThis.__findings = r.findings; return r; } }; }`,
    ctx);
  vm.runInContext(bridge, ctx);
  vm.runInContext(dialog, ctx);

  return {
    findings: () => JSON.parse(JSON.stringify((ctx as { __findings: unknown }).__findings)),
    pick(i: number, stem: string) {
      const se = rows[i].querySelector("select");
      se.value = stem;
      se.onchange();
    },
    continue() {
      document.querySelector("#ok").onclick();
      return JSON.parse(posted.at(-1)!);
    },
  };
}

describe("the page's pre-flight findings equal the host's, for the same reply", () => {
  it.each(SCENARIOS)("$name", (sc) => {
    const song = "Drift";
    const snap = snapshotSong({
      tracks: sc.tracks,
      mainTrack: mk("Main", null, { devices: (sc.master ?? []).map((d) => ({ name: d.name, enabled: d.enabled })) } as Partial<TrackLike>) as never,
    }, song);
    const base = emptyManifest(song);
    sc.manifest(base);
    const taps = sc.taps ?? [];
    const req: MappingRequest = requestFor(snap, base, "/tmp/x", taps);

    const page = pageHarness(decodeURIComponent(encodeRequest(req)));
    for (const [i, stem] of sc.edits ?? []) page.pick(i, stem);
    const seen = page.findings();   // what the pre-flight panel was built from, last draw
    const reply = page.continue();  // what the host receives on Continue

    // The host's side, on its OWN snapshot (not the data copy): what `configure` does with the reply.
    const hostManifest = manifestFromResponse(base, reply, reply.song);
    const host = JSON.parse(JSON.stringify(check(snap, hostManifest, taps).findings));

    expect(seen).toEqual(host);
    for (const rule of sc.expectRules) expect(host.map((f: { rule: string }) => f.rule), `${sc.name}: ${rule}`).toContain(rule);
  });
});

describe("dialog payload size", () => {
  /**
   * An ENGINEERING BUDGET to catch accidental growth of the request (for example sending the track list twice,
   * which this test would have flagged). It is NOT a known limit of Live: the dialog is a `data:` URL, and how
   * large a URL Live's webview accepts has not been verified. The Set is a realistic worst case: 70 tracks in 7
   * groups, each with a sub-group and 8 leaves, 3 devices per track, long real-world names, every leaf assigned.
   * Measured 104,158 bytes when written (it was 125,089 while `tracks` and `snapshot.tracks` both carried the
   * track list); the budget is that plus about 15 percent. Non-ASCII names are not covered by it: the same Set with
   * every ASCII letter replaced by one Cyrillic letter measured 168,908 bytes, and by one Japanese character
   * 207,758 (one-off measurements, not asserted).
   */
  const BUDGET_BYTES = 120_000;

  it("a realistic worst-case 70-track Set stays within the budget", () => {
    const leaves = [
      "46-91V_SR_70_vocal_hook_take_it_slow_dry_A#m.wav_80bpm", "Slynk Sub Bass + CC Control", "Cam Drums Overhead L (Comp)",
      "Acid V MIDI Arp Layer", "Rhodes DI Print", "Guitar Lead Double Tracked", "Vocal Chop Resample Wet", "FX Riser Reverse Tail",
    ];
    const stems = ["Drums", "Vocals", "Keys - Played", "Guitar - Played", "Samples"];
    const dev = (...names: string[]) => names.map((name) => ({ name }));
    const tracks: TrackLike[] = [];
    for (let g = 0; g < 7; g++) {
      const grp = mk(`Instrument Group ${g + 1}`, null, { devices: dev("EQ Eight", "Glue Compressor", "Utility") });
      const sub = mk(`Sidechained Sub Group ${g + 1}`, grp, { devices: dev("EQ Eight", "Utility", "Limiter") });
      tracks.push(grp, sub);
      for (let i = 0; i < leaves.length; i++) tracks.push(mk(`${leaves[i]} ${g + 1}`, sub, { devices: dev("Pro-Q 3", "Saturator", "Utility") }));
    }
    expect(tracks).toHaveLength(70);
    const song = "Learning to Feel";
    const snap = snapshotSong({ tracks, mainTrack: mk("Main") as never }, song);
    const base = emptyManifest(song);
    snap.tracks.filter((t) => !t.isGroup).forEach((t, i) => (base.stems[stems[i % stems.length]] ??= { trackKeys: [] }).trackKeys.push(t.key));
    const encoded = encodeRequest(requestFor(snap, base, "/Users/someone/Library/Application Support/Ableton/Stem Export/temp", []));
    const bytes = ("data:text/html," + encoded).length;
    expect(bytes).toBeLessThan(BUDGET_BYTES);
    // Guard against the Set quietly becoming small enough that the budget means nothing.
    expect(bytes).toBeGreaterThan(BUDGET_BYTES * 0.75);
  });
});
