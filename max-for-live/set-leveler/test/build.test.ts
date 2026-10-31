import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

const DIR = "dist/Set Leveler";
let raw: Buffer;
let patcher: { boxes: { box: Record<string, any> }[]; lines: { patchline: { source: [string, number]; destination: [string, number] } }[] };

beforeAll(() => {
  execFileSync("node", ["scripts/build.mjs"], { stdio: "pipe" });
  raw = readFileSync(`${DIR}/Set Leveler.amxd`);
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
    expect(readFileSync(`${DIR}/ui.html`, "utf8")).toContain("Set Leveler");
  });

  it("the page's script parses", () => {
    const html = readFileSync(`${DIR}/ui.html`, "utf8");
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
    expect(() => new Function(script)).not.toThrow();
  });

  it("the bridge writes nothing but gain", () => {
    const sets = readFileSync(`${DIR}/bridge.js`, "utf8").match(/\.set\("[^"]+"/g);
    expect(sets).toEqual(['.set("gain"']);
  });
});
