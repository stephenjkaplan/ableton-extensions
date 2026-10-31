import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

const NAME = "Set Leveler (DJ Set)";
const DIR = `dist/${NAME}`;
let raw: Buffer;
let patcher: { boxes: { box: Record<string, any> }[]; lines: { patchline: { source: [string, number]; destination: [string, number] } }[] };

beforeAll(() => {
  execFileSync("node", ["scripts/build.mjs"], { stdio: "pipe" });
  raw = readFileSync(`${DIR}/${NAME}.amxd`);
  patcher = JSON.parse(raw.subarray(32).toString("utf8").replace(/\0$/, "")).patcher;
}, 60_000);

const texts = () => patcher.boxes.map((b) => String(b.box.text));

describe("the built device", () => {
  it("is an Audio Effect with a correct length", () => {
    expect(raw.subarray(0, 4).toString()).toBe("ampf");
    expect(raw.subarray(8, 12).toString()).toBe("aaaa");
    expect(raw.readUInt32LE(28)).toBe(raw.length - 32);
    expect(raw.at(-1)).toBe(0);
  });

  it("passes audio through", () => {
    expect(texts()).toContain("plugin~");
    expect(texts()).toContain("plugout~");
    const lines = patcher.lines.map((l) => l.patchline);
    const id = (t: string) => patcher.boxes.find((b) => b.box.text === t)!.box.id;
    for (const ch of [0, 1]) {
      expect(lines).toContainEqual({ source: [id("plugin~"), ch], destination: [id("plugout~"), ch] });
    }
  });

  it("finds its files by name, so it works once moved", () => {
    expect(texts()).toContain("node.script node-main.js");
    expect(texts()).toContain("v8 bridge.js");
  });

  it("only wires outlets and inlets that exist", () => {
    const check = (p: typeof patcher) => {
      const boxes = new Map(p.boxes.map((b) => [b.box.id, b.box]));
      for (const { patchline: { source: [from, out], destination: [to, inlet] } } of p.lines) {
        expect(out).toBeLessThan(boxes.get(from)!.numoutlets);
        expect(inlet).toBeLessThan(boxes.get(to)!.numinlets);
      }
    };
    check(patcher);
    for (const b of patcher.boxes) if (b.box.patcher) check(b.box.patcher);
  });

  it("opens a window showing only the page", () => {
    const ui = patcher.boxes.find((b) => b.box.patcher)!.box.patcher;
    expect(ui.openinpresentation).toBe(1);
    const shown = ui.boxes.filter((b: { box: { presentation?: number } }) => b.box.presentation === 1);
    expect(shown.map((b: { box: { maxclass: string } }) => b.box.maxclass)).toEqual(["jweb"]);
  });

  it("ships the Node bundle, bridge and page", () => {
    const node = readFileSync(`${DIR}/node-main.js`, "utf8");
    expect(node).toContain('require("max-api")');
    expect(readFileSync(`${DIR}/bridge.js`, "utf8")).toContain("function setgain");
    expect(readFileSync(`${DIR}/ui.html`, "utf8")).toContain(NAME);
  });

  it("the page's script parses", () => {
    const html = readFileSync(`${DIR}/ui.html`, "utf8");
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
    expect(() => new Function(script)).not.toThrow();
  });

  it("is named for DJ sets on the device and in its window", () => {
    expect(JSON.stringify(patcher.boxes.find((b) => b.box.id === "note")!.box.text)).toContain(NAME);
    expect(patcher.boxes.find((b) => b.box.patcher)!.box.patcher.title).toBe(NAME);
  });

  it("says up front which view it reads and which it changes", () => {
    const html = readFileSync(`${DIR}/ui.html`, "utf8");
    expect(html).toMatch(/<p class="assumes">[^<]*Arrangement[^<]*Session[^<]*<\/p>/);
  });

  it("has a Good to know toggle that stays out of the page's re-rendered area", () => {
    const html = readFileSync(`${DIR}/ui.html`, "utf8");
    expect(html).toMatch(/<details[\s\S]*<summary>Good to know<\/summary>/);
    expect(html.indexOf("<details")).toBeGreaterThan(html.indexOf('<div id="main">'));
    expect(html).toMatch(/master/);
  });

  it("packages a zip holding the device's whole folder", () => {
    execFileSync("node", ["scripts/build.mjs", "--package"], { stdio: "pipe" });
    const { version } = JSON.parse(readFileSync("package.json", "utf8"));
    const listing = execFileSync("unzip", ["-Z1", `set-leveler-dj-set-${version}.zip`]).toString();
    for (const f of [`${NAME}.amxd`, "node-main.js", "bridge.js", "ui.html"]) expect(listing).toContain(`${NAME}/${f}`);
  });

  it("uses no native dropdowns, which select by themselves on a quick click in Max's browser", () => {
    expect(readFileSync(`${DIR}/ui.html`, "utf8")).not.toMatch(/<select|<option/);
  });

  it("the bridge writes nothing but gain", () => {
    const sets = readFileSync(`${DIR}/bridge.js`, "utf8").match(/\.set\("[^"]+"/g);
    expect(sets).toEqual(['.set("gain"']);
  });
});
