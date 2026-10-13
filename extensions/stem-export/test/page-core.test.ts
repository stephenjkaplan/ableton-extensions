import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { bundlePageCore } from "../build-page-core.js";
import { emptyManifest } from "../src/manifest-core.js";
import { encodeRequest, injectIntoPage, type MappingRequest } from "../src/ui/protocol.js";
import pageCoreSource from "../src/ui/page-core.js?bundle";

const bundle = bundlePageCore();

const REQ: MappingRequest = {
  song: "Song", tempDirectory: "/tmp", tracks: [], stemNames: [],
  current: { assignments: {}, extras: [] }, findings: [], outputPreview: [],
};

describe("bundlePageCore", () => {
  it("has no node: reference, defines StemCore, and stays small", () => {
    expect(bundle).not.toContain("node:");
    expect(bundle).toMatch(/StemCore\s*=/);
    expect(Buffer.byteLength(bundle)).toBeLessThan(25 * 1024);
  });

  it("is what the ?bundle import resolves to", () => {
    expect(pageCoreSource).toBe(bundle);
  });

  it("cannot end or comment out its script element", () => {
    expect(bundle.toLowerCase()).not.toContain("</script");
    expect(bundle).not.toContain("<!--");
  });

  it("evaluates with no globals into the four working functions", () => {
    const ctx = vm.createContext({});
    vm.runInContext(`${bundle};\nthis.__core = StemCore;`, ctx);
    const core = (ctx as { __core: Record<string, (...a: any[]) => any> }).__core;
    expect(Object.keys(core).sort()).toEqual(["check", "manifestFromResponse", "pruneStale", "snapshotFromData"]);

    const snap = core.snapshotFromData({
      song: "Song",
      tracks: [
        { key: "Drums", name: "Drums", groupPath: [], isGroup: true, muted: false, effectiveMuted: false, devices: [], audible: false },
        { key: "Drums/Kick", name: "Kick", groupPath: ["Drums"], isGroup: false, muted: false, effectiveMuted: false, devices: ["EQ"], audible: true },
      ],
      masterDevices: [],
    });
    expect(snap.byKey.get("Drums/Kick").name).toBe("Kick");
    expect(snap.descendantsOf("Drums").map((t: { key: string }) => t.key)).toEqual(["Drums/Kick"]);

    const m = core.manifestFromResponse(
      emptyManifest("Song"),
      { cancelled: false, song: "Song", assignments: { "Drums/Kick": "Drums" }, extras: [] },
      "Song",
    );
    expect(m.stems.Drums.trackKeys).toEqual(["Drums/Kick"]);
    const { resolution, findings } = core.check(snap, m, []);
    expect(resolution).toBeDefined();
    expect(Array.isArray(findings)).toBe(true);
    expect(core.pruneStale(m, snap).dropped).toEqual([]);

    // A clean mapping has no error findings.
    expect(findings.filter((f: { severity: string }) => f.severity === "error")).toEqual([]);

    // A stem the registry does not know is reported, by rule and severity: check really runs the validator.
    const bad = core.manifestFromResponse(
      emptyManifest("Song"),
      { cancelled: false, song: "Song", assignments: { "Drums/Kick": "Drumz" }, extras: [] },
      "Song",
    );
    const unknown = core.check(snap, bad, []).findings.filter((f: { rule: string }) => f.rule === "unknown-stem");
    expect(unknown).toHaveLength(1);
    expect(unknown[0].severity).toBe("error");
    expect(unknown[0].detail).toContain("Drumz");
  });
});

describe("page injection", () => {
  it("encodeRequest contains the bundle once and the request once", () => {
    const page = decodeURIComponent(encodeRequest(REQ));
    expect(page.split(pageCoreSource).length - 1).toBe(1);
    expect(page.split("window.__REQUEST__=").length - 1).toBe(1);
    expect(page).not.toContain("<!--CORE-->");
    expect(page).not.toContain("<!--REQUEST-->");
    // The core runs before the page's main script.
    expect(page.indexOf(pageCoreSource)).toBeLessThan(page.indexOf("const REQ = window.__REQUEST__"));
  });

  it("inserts payloads literally, even with $ sequences and marker text, without rescanning", () => {
    const html = "<head><!--REQUEST--><script><!--CORE--></script></head>";
    const core = "a$&b$1$'$`c";
    const request = "r$&<!--CORE-->$$";
    const page = injectIntoPage(html, request, core);
    expect(page).toBe(`<head>${request}<script>${core}</script></head>`);
  });

  it("refuses a core that would end or open a comment in its script element", () => {
    const html = "<!--REQUEST--><script><!--CORE--></script>";
    expect(() => injectIntoPage(html, "r", 'var a="</script>";')).toThrow(/`<\/script`.*end the script element/);
    expect(() => injectIntoPage(html, "r", 'var a="</SCRIPT>";')).toThrow(/`<\/SCRIPT`/);
    expect(() => injectIntoPage(html, "r", 'var a="<!--";')).toThrow(/`<!--`/);
  });

  it("passes a clean core through byte-for-byte", () => {
    const core = 'var a="x$&y",b=/a<b/u,c=String.raw`\\n`;';
    const page = injectIntoPage("<!--REQUEST--><script><!--CORE--></script>", "r", core);
    expect(page).toBe(`r<script>${core}</script>`);
  });

  it("rejects a template whose markers are missing or repeated", () => {
    expect(() => injectIntoPage("<!--REQUEST-->", "r", "c")).toThrow(/CORE/);
    expect(() => injectIntoPage("<!--CORE-->", "r", "c")).toThrow(/REQUEST/);
    expect(() => injectIntoPage("<!--REQUEST--><!--REQUEST--><!--CORE-->", "r", "c")).toThrow(/REQUEST/);
  });
});
