import { describe, expect, it } from "vitest";
import template from "../src/ui/mapping.html";
import type { MappingRequest } from "../src/ui/protocol.js";

/**
 * The page builds its table, dropdowns and chips with innerHTML, and that is where track names, stem
 * names, devices and findings actually land. There is no DOM library here, so the page script runs against
 * a recording stub: every element is a Proxy, and every innerHTML write is captured for inspection.
 */
function runPage(req: MappingRequest) { return runPageWith(req, () => {}); }
function runPageWith(req: MappingRequest, sink: (r: unknown) => void) {
  const script = template.split("<script>").pop()!.split("</script>")[0];
  const writes: string[] = [];
  const nodes = new Map<string, any>();

  const makeNode = (): any => {
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
        return true;
      },
      apply: () => makeNode(),
    });
    return node;
  };

  const document: any = {
    querySelector: (sel: string) => {
      if (!nodes.has(sel)) nodes.set(sel, makeNode());
      return nodes.get(sel);
    },
    querySelectorAll: () => makeNode(),
    createElement: () => makeNode(),
    addEventListener: () => {},
    body: makeNode(),
  };
  const window = { __REQUEST__: req };
  new Function("window", "document", "closeWithResult", script)(window, document, sink);
  return { writes, node: (sel: string) => document.querySelector(sel) };
}

const HOSTILE = `"><img src=x onerror=alert(1)>`;
const SCRIPTY = `<script>alert(2)</script>`;

const req: MappingRequest = {
  song: `Song ${HOSTILE}`,
  tempDirectory: "/tmp/x",
  tracks: [
    { key: `G/${HOSTILE}`, name: `Grp ${HOSTILE}`, depth: 0, isGroup: true, muted: false, devices: [] },
    { key: `G/${HOSTILE}/Kick`, name: `Kick ${SCRIPTY}`, depth: 1, isGroup: false, muted: false, devices: [`Dev ${HOSTILE}`] },
    { key: `G/${HOSTILE}/Old`, name: `Old '<b>x</b>'`, depth: 1, isGroup: false, muted: true, devices: [] },
  ],
  stemNames: [`St ${HOSTILE}`, "Backing"],
  current: {
    assignments: { [`G/${HOSTILE}/Kick`]: `Gone ${HOSTILE}` },   // not a known stem: rendered as a warning option
    extras: [{ name: `Ex ${HOSTILE}`, trackKeys: [`G/${HOSTILE}/Kick`, `G/${HOSTILE}/Old`] }],
  },
  findings: [{ severity: "warn", title: `T ${HOSTILE}`, detail: `D ${SCRIPTY}` } as any],
  outputPreview: [{ stem: `St ${HOSTILE}`, count: 1, filename: `File ${HOSTILE}.wav` }],
};

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
  const counted: MappingRequest = {
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
    findings: [], outputPreview: [],
  };

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

describe("mapping.html: the editable song name", () => {
  const base: MappingRequest = {
    song: "Old Name", tempDirectory: "/tmp/x",
    tracks: [{ key: "Kick", name: "Kick", depth: 0, isGroup: false, muted: false, devices: [] }],
    stemNames: ["Drums", "Backing"], current: { assignments: { Kick: "Drums" }, extras: [{ name: "Vox", trackKeys: ["Kick"] }] },
    findings: [], outputPreview: [{ stem: "Drums", count: 1, filename: "Old Name (Drums).wav" }],
  };

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
