import { describe, expect, it } from "vitest";
import template from "../src/ui/mapping.html";
import { bundlePageCore } from "../build-page-core.js";
import type { MappingRequest } from "../src/ui/protocol.js";
import { buildRequest, type PageTrack } from "./page-fixtures.js";

// The page script needs the global `StemCore` the host injects ahead of it; evaluate the same bundle here.
const loadCore = () => new Function(`${bundlePageCore()};\nreturn StemCore;`)();
const CORE = loadCore();

/**
 * The page builds its table, dropdowns and chips with innerHTML, and that is where track names, stem
 * names, devices and findings actually land. There is no DOM library here, so the page script runs against
 * a recording stub: every element is a Proxy, and every innerHTML write is captured for inspection.
 */
function runPage(req: MappingRequest, core: unknown = CORE) { return runPageWith(req, () => {}, core); }
function runPageWith(req: MappingRequest, sink: (r: unknown) => void, core: unknown = CORE) {
  const script = template.split("<script>").pop()!.split("</script>")[0];
  const writes: string[] = [];
  const nodes = new Map<string, any>();

  // Rows appended to #rows since it was last cleared, so a test can reach a row's <select> and fire its handler.
  let rows: any[] = [];
  const makeRow = (): any => {
    const row = makeNode();
    const found = new Map<string, any>();
    row.querySelector = (sel: string) => {
      if (!found.has(sel)) found.set(sel, makeNode());
      return found.get(sel);
    };
    return row;
  };
  const makeNode = (onSet?: (prop: string | symbol, value: unknown) => void): any => {
    const store: Record<string | symbol, unknown> = {};
    const children = new Map<string | symbol, unknown>();
    const target = function () {};
    const node: any = new Proxy(target, {
      get(_t, prop) {
        if (prop in store) return store[prop];
        if (typeof prop === "symbol") return undefined;
        if (!children.has(prop)) children.set(prop, makeNode());
        return children.get(prop);
      },
      set(_t, prop, value) {
        store[prop] = value;
        if (prop === "innerHTML") writes.push(String(value));
        onSet?.(prop, value);
        return true;
      },
      apply: () => makeNode(),
    });
    return node;
  };

  const document: any = {
    querySelector: (sel: string) => {
      if (!nodes.has(sel)) {
        const n = makeNode(sel === "#rows" ? (p) => { if (p === "innerHTML") rows = []; } : undefined);
        if (sel === "#rows") n.appendChild = (r: unknown) => void rows.push(r);
        nodes.set(sel, n);
      }
      return nodes.get(sel);
    },
    querySelectorAll: () => makeNode(),
    createElement: () => makeRow(),
    addEventListener: () => {},
    body: makeNode(),
  };
  const window = { __REQUEST__: req };
  new Function("window", "document", "closeWithResult", "StemCore", script)(window, document, sink, core);
  const pick = (i: number, stem: string) => {
    const se = rows[i].querySelector("select");
    se.value = stem;
    se.onchange();
  };
  return { writes, node: (sel: string) => document.querySelector(sel), pick };
}

const HOSTILE = `"><img src=x onerror=alert(1)>`;
const SCRIPTY = `<script>alert(2)</script>`;

const req: MappingRequest = buildRequest({
  song: `Song ${HOSTILE}`,
  tempDirectory: "/tmp/x",
  tracks: [
    { key: `G/${HOSTILE}`, name: `Grp ${HOSTILE}`, depth: 0, isGroup: true, muted: false, devices: [] },
    { key: `G/${HOSTILE}/Kick`, name: `Kick ${SCRIPTY}`, depth: 1, isGroup: false, muted: false, devices: [`Dev ${HOSTILE}`] },
    { key: `G/${HOSTILE}/Old`, name: `Old '<b>x</b>'`, depth: 1, isGroup: false, muted: true, devices: [] },
    { key: "Snare", name: "Snare", depth: 0, isGroup: false, muted: false, devices: [] },
  ],
  stemNames: [`St ${HOSTILE}`, "Backing"],
  current: {
    assignments: { [`G/${HOSTILE}/Kick`]: `Gone ${HOSTILE}`, Snare: `St ${HOSTILE}` },   // not a known stem: rendered as a warning option
    extras: [{ name: `Ex ${HOSTILE}`, trackKeys: [`G/${HOSTILE}/Kick`, `G/${HOSTILE}/Old`] }],
  },
  notes: [{ severity: "warn", title: `T ${HOSTILE}`, detail: `D ${SCRIPTY}` } as any],
  outputPreview: [{ stem: `St ${HOSTILE}`, count: 1, filename: `File ${HOSTILE}.wav` }],
});

describe("mapping.html: DOM-side escaping", () => {
  const { writes, node } = runPage(req);
  // Open the extras dialog so its markup (name input value, track picker, chips) is generated too.
  node("#xbtn").onclick();
  const all = writes.join("\n");

  it("rendered the hostile data at all (so the checks below are not vacuous)", () => {
    expect(writes.length).toBeGreaterThan(8);
    expect(all).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(all).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(all).toContain("&#39;&lt;b&gt;x&lt;/b&gt;&#39;");
  });

  it("never lets an element or attribute break out of any field", () => {
    expect(all).not.toMatch(/<img/i);
    expect(all).not.toMatch(/<script/i);
    expect(all).not.toContain("<b>x");
    expect(all).not.toContain(HOSTILE);   // raw, unescaped quote-then-tag payload
  });

  const E = "&quot;&gt;&lt;img src=x onerror=alert(1)&gt;";
  it.each([
    ["track name (cell and extras chip)", `Kick &lt;script&gt;`],
    ["group name", `Grp ${E}`],
    ["track key in a title attribute", `title="G/${E}/Old"`],
    ["device name", `Dev ${E}`],
    ["stem name in option value and text", `<option value="St ${E}"`],
    ["unknown assigned stem in the warning option", `⚠ Gone ${E} (not a stem)`],
    ["extra name in the name input", `value="Ex ${E}"`],
    ["extra name in the Output panel", `<span class="n">Ex ${E}</span>`],
    ["Output filename from the host preview", `File ${E}.wav`],
    ["reconstructed Master reference filename", `Song ${E} (MASTER REFERENCE).wav`],
  ])("escapes %s", (_what, expected) => {
    expect(all).toContain(expected);
  });

  it("escapes the finding title and detail", () => {
    const f = runPage(req);
    expect(f.writes.some((w) => w.includes(`T ${E}`) && w.includes("D &lt;script&gt;alert(2)&lt;/script&gt;"))).toBe(true);
  });

  it("puts the song in the name field through value, not markup", () => {
    expect(node("#song").value).toBe(req.song);
  });
});

describe("mapping.html: header and Output panel agree on counts", () => {
  // Two named stems, one track falls through to Backing, and one extra that holds only a muted track.
  const counted: MappingRequest = buildRequest({
    song: "Counts", tempDirectory: "/tmp/x",
    tracks: [
      { key: "Kick", name: "Kick", depth: 0, isGroup: false, muted: false, devices: [] },
      { key: "Bass", name: "Bass", depth: 0, isGroup: false, muted: false, devices: [] },
      { key: "Pad", name: "Pad", depth: 0, isGroup: false, muted: false, devices: [] },
      { key: "Old", name: "Old", depth: 0, isGroup: false, muted: true, devices: [] },
    ],
    stemNames: ["Drums", "Bass", "Backing"],
    current: {
      assignments: { Kick: "Drums", Bass: "Bass" },
      extras: [{ name: "Live", trackKeys: ["Kick"] }, { name: "Dead", trackKeys: ["Old"] }],
    },
    outputPreview: [],
  });

  it("both say 3 stems (Backing is non-empty) and 1 extra (the muted-only extra is not live)", () => {
    const { writes, node } = runPage(counted);
    expect(writes.find((w) => w.includes("stems +"))).toMatch(/<b>3<\/b> stems \+ <b>1<\/b> extras/);
    expect(node("#outh").textContent).toBe("Output — 3 stems + 1 extras");
  });

  it("both drop Backing from the count when nothing falls through", () => {
    const none = { ...counted, current: { ...counted.current,
      assignments: { Kick: "Drums", Bass: "Bass", Pad: "Bass" } } };
    const { writes, node } = runPage(none);
    expect(writes.find((w) => w.includes("stems +"))).toMatch(/<b>2<\/b> stems \+ <b>1<\/b> extras/);
    expect(node("#outh").textContent).toBe("Output — 2 stems + 1 extras");
  });
});

describe("mapping.html: the Output panel lists the plan, not the registry", () => {
  const names = Array.from({ length: 36 }, (_, i) => `Stem ${i + 1}`);
  const big: MappingRequest = buildRequest({
    song: "Plan", tempDirectory: "/tmp/x",
    tracks: [
      { key: "Kick", name: "Kick", depth: 0, isGroup: false, muted: false, devices: [] },
      { key: "Bass", name: "Bass", depth: 0, isGroup: false, muted: false, devices: [] },
      { key: "Pad", name: "Pad", depth: 0, isGroup: false, muted: false, devices: [] },
    ],
    stemNames: [...names, "Backing"],
    current: { assignments: { Kick: "Stem 3", Bass: "Stem 30" }, extras: [] },
    outputPreview: [],
  });
  const rows = (html: string) => (html.match(/<span class="n">/g) ?? []).length;

  it("has one row per stem with an assigned track, plus Backing and the Master reference", () => {
    const { node } = runPage(big);
    const html = String(node("#stemlist").innerHTML);
    const withTracks = new Set(Object.values(big.current.assignments)).size;
    expect(withTracks).toBe(2);
    expect(rows(html)).toBe(withTracks + 1 /* Backing: Pad falls through */ + 1 /* Master */);
    expect(html).toContain('<span class="n">Stem 3</span>');
    expect(html).not.toContain("Stem 4");
    expect(html).not.toMatch(/<span class="c">empty<\/span>/);
    expect(node("#outh").textContent).toBe("Output — 3 stems + 0 extras");
  });

  it("an assignment to a muted-only stem adds no row", () => {
    const asMuted = (t: MappingRequest["snapshot"]["tracks"][number]) => (t.key === "Bass" ? { ...t, muted: true, effectiveMuted: true, audible: false } : t);
    const muted = { ...big, snapshot: { ...big.snapshot, tracks: big.snapshot.tracks.map(asMuted) } };
    const html = String(runPage(muted).node("#stemlist").innerHTML);
    expect(rows(html)).toBe(1 + 1 + 1);
    expect(html).not.toContain("Stem 30");
  });
});

describe("mapping.html: the editable song name", () => {
  const base: MappingRequest = buildRequest({
    song: "Old Name", tempDirectory: "/tmp/x",
    tracks: [{ key: "Kick", name: "Kick", depth: 0, isGroup: false, muted: false, devices: [] }],
    stemNames: ["Drums", "Backing"], current: { assignments: { Kick: "Drums" }, extras: [{ name: "Vox", trackKeys: ["Kick"] }] },
    outputPreview: [{ stem: "Drums", count: 1, filename: "Old Name (Drums).wav" }],
  });

  function runWithResult(req: MappingRequest) {
    const sent: any[] = [];
    const page = runPageWith(req, (r: unknown) => sent.push(r));
    return { ...page, sent };
  }

  it("follows edits in the Output panel, for host-built and page-built filenames", () => {
    const { writes, node } = runWithResult(base);
    const song = node("#song");
    song.value = "New / Name";
    song.oninput();
    const last = writes.slice(-3).join("\n");
    expect(last).toContain("New _ Name (Drums).wav");
    expect(last).toContain("New _ Name (MASTER REFERENCE).wav");
    expect(last).toContain("Extras/New _ Name (Vox).wav");
    expect(last).not.toContain("Old Name");
  });

  it("returns the edited, trimmed song; an empty name cannot be submitted", () => {
    const { node, sent } = runWithResult(base);
    const song = node("#song");
    song.value = "  Edited  ";
    song.oninput();
    node("#ok").onclick();
    expect(sent.at(-1)).toMatchObject({ cancelled: false, song: "Edited" });
    song.value = "   ";
    song.oninput();
    expect(node("#ok").disabled).toBe(true);
    const n = sent.length;
    node("#ok").onclick();
    expect(sent.length).toBe(n);
  });
});

describe("mapping.html: the pre-flight panel is live", () => {
  // A group with a device and two children, plus a loose track.
  const tracks: PageTrack[] = [
    { key: "Grp", name: "Grp", depth: 0, isGroup: true, muted: false, devices: ["EQ Eight"] },
    { key: "Grp/Kick", name: "Kick", depth: 1, isGroup: false, muted: false, devices: [] },
    { key: "Grp/Snare", name: "Snare", depth: 1, isGroup: false, muted: false, devices: [] },
  ];
  const live = (assignments: Record<string, string> = {}, extra: Partial<MappingRequest> = {}) => buildRequest({
    song: "Live", tempDirectory: "/tmp/x", tracks, stemNames: ["Drums", "Vocals", "Backing"],
    current: { assignments, extras: [] }, outputPreview: [], ...extra,
  });
  const SPLIT = "Processed group is split across stems";
  const panel = (p: ReturnType<typeof runPage>) => String(p.node("#finds").innerHTML);
  const head = (p: ReturnType<typeof runPage>) => String(p.node("#findh").textContent);

  it("assigning the two children to Drums and Vocals warns; assigning both to Drums does not", () => {
    const page = runPage(live());
    page.pick(1, "Drums");
    page.pick(2, "Vocals");
    expect(panel(page)).toContain(SPLIT);
    expect(panel(page)).toMatch(/class="f warn"/);
    page.pick(2, "Drums");
    expect(panel(page)).not.toContain(SPLIT);
  });

  it("updates the header counts as stems are assigned and cleared", () => {
    const page = runPage(live());
    expect(head(page)).toBe("Pre-flight — 0 errors, 0 warnings");
    page.pick(1, "Drums");   // Snare falls through to Backing: the group is now split
    expect(head(page)).toBe("Pre-flight — 0 errors, 1 warning");
    page.pick(1, "");
    expect(head(page)).toBe("Pre-flight — 0 errors, 0 warnings");
  });

  it("clears an error about a stem the dialog was opened with once that track is reassigned", () => {
    const page = runPage(live({ "Grp/Kick": "Drumz", "Grp/Snare": "Drumz" }));
    expect(panel(page)).toContain("Unknown stem name");
    expect(head(page)).toMatch(/1 error/);
    page.pick(1, "Drums");
    page.pick(2, "Drums");
    expect(panel(page)).not.toContain("Unknown stem name");
    expect(head(page)).toMatch(/0 errors/);
  });

  it("shows host notes first, then the computed findings, and counts both", () => {
    const note = { severity: "warn" as const, rule: "n", title: "Host note", detail: "d" };
    const page = runPage(live({}, { notes: [note] }));
    expect(panel(page).indexOf("Host note")).toBeGreaterThanOrEqual(0);
    expect(panel(page).indexOf("Host note")).toBeLessThan(panel(page).indexOf("Main track"));
    expect(head(page)).toBe("Pre-flight — 0 errors, 1 warning");
  });

  it("survives a check that throws: one error finding, and Continue still works", () => {
    const sent: any[] = [];
    const boom = { ...CORE, check: () => { throw new Error("kaboom"); } };
    const page = runPageWith(live({ "Grp/Kick": "Drums" }), (r) => sent.push(r), boom);
    expect(panel(page)).toContain("The pre-flight check could not run");
    expect(panel(page)).toContain("kaboom");
    expect((panel(page).match(/class="f error"/g) ?? []).length).toBe(1);
    expect(head(page)).toBe("Pre-flight — 1 error, 0 warnings");
    // The rest of the dialog was still drawn: header, rows and the Output panel.
    expect(page.node("#outh").textContent).toMatch(/^Output — \d+ stems \+ 0 extras$/);
    expect(String(page.node("#stemlist").innerHTML)).toContain("Live (Drums).wav");
    expect(String(page.node("#meta").innerHTML)).toContain("audible tracks assigned");
    page.pick(2, "Vocals");   // the dialog stays interactive
    expect(head(page)).toBe("Pre-flight — 1 error, 0 warnings");
    page.node("#ok").onclick();
    expect(sent.at(-1)).toMatchObject({ cancelled: false, assignments: { "Grp/Kick": "Drums", "Grp/Snare": "Vocals" } });
  });

  it("survives a missing core and a malformed snapshot the same way", () => {
    const noCore = runPage(live(), null);
    expect(panel(noCore)).toContain("The pre-flight check could not run");
    const badSnap = runPage({ ...live(), snapshot: { ...live().snapshot, masterDevices: null as never } });
    expect(panel(badSnap)).toContain("The pre-flight check could not run");
  });

  it("hides the host's song-name note once the field holds another name, and brings it back at the prefill", () => {
    const note = { severity: "info" as const, rule: "song-name-default", title: "Set the song name", detail: "d" };
    const page = runPage(live({}, { song: "Untitled Set", notes: [note] }));
    const song = page.node("#song");
    const type = (v: string) => { song.value = v; song.oninput(); };
    expect(panel(page)).toContain("Set the song name");
    type("My Song");
    expect(panel(page)).not.toContain("Set the song name");
    type("   ");   // blank: still not a name
    expect(panel(page)).toContain("Set the song name");
    type("My Song");
    type("Untitled Set");
    expect(panel(page)).toContain("Set the song name");
    // Only that rule is hidden: another host note stays.
    const other = runPage(live({}, { song: "Untitled Set", notes: [note, { ...note, rule: "other", title: "Other note" }] }));
    other.node("#song").value = "Named";
    other.node("#song").oninput();
    expect(panel(other)).toContain("Other note");
    expect(panel(other)).not.toContain("Set the song name");
  });

  it("tolerates a request with no notes", () => {
    const page = runPage({ ...live(), notes: undefined as never });
    expect(head(page)).toBe("Pre-flight — 0 errors, 0 warnings");
  });
});
