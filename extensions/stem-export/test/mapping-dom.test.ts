import { describe, expect, it } from "vitest";
import template from "../src/ui/mapping.html";
import type { MappingRequest } from "../src/ui/protocol.js";

/**
 * The page builds its table, dropdowns and chips with innerHTML, and that is where track names, stem
 * names, devices and findings actually land. There is no DOM library here, so the page script runs against
 * a recording stub: every element is a Proxy, and every innerHTML write is captured for inspection.
 */
function runPage(req: MappingRequest) {
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
  new Function("window", "document", "closeWithResult", script)(window, document, () => {});
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

  it("assigns the song to the heading through textContent, not markup", () => {
    expect(node("#song").textContent).toBe(req.song);
  });
});
