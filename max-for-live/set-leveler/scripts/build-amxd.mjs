// Writes a Max for Live Audio Effect (.amxd) from a patcher object, and helps build one.
import { writeFileSync } from "node:fs";

const AUDIO_EFFECT = 0x61616161; // "aaaa"

/** Header bytes match existing unfrozen devices: ampf, 4, type, meta, 4, 0, ptch, length, JSON, NUL. */
export function writeAmxd(outPath, patcher) {
  const json = Buffer.from(JSON.stringify({ patcher }, null, "\t") + "\n\0", "utf8");
  const head = Buffer.alloc(32);
  head.write("ampf", 0, "ascii");
  head.writeUInt32LE(4, 4);
  head.write("aaaa", 8, "ascii");
  head.write("meta", 12, "ascii");
  head.writeUInt32LE(4, 16);
  head.writeUInt32LE(0, 20);
  head.write("ptch", 24, "ascii");
  head.writeUInt32LE(json.length, 28);
  writeFileSync(outPath, Buffer.concat([head, json]));
}

/** A patcher with sensible window defaults. `boxes` come from box(), `lines` are [from, outlet, to, inlet]. */
export function makePatcher({ boxes, lines, rect = [100, 100, 700, 500], deviceWidth, presentation = false, title }) {
  const project = deviceWidth === undefined ? {} : {
    project: {
      version: 1, creationdate: 3590052786, modificationdate: 3590052786,
      viewrect: [0, 0, 300, 500], autoorganize: 1, hideprojectwindow: 1, showdependencies: 1, autolocalize: 0,
      contents: { patchers: {} }, layout: {}, searchpath: {}, detailsvisible: 0,
      amxdtype: AUDIO_EFFECT, readonly: 0, devpathtype: 0, devpath: ".", sortmode: 0,
    },
  };
  return {
    fileversion: 1,
    appversion: { major: 9, minor: 1, revision: 5, architecture: "x64", modernui: 1 },
    classnamespace: "box",
    rect,
    bglocked: 1,
    openinpresentation: presentation ? 1 : 0,
    default_fontsize: 12,
    default_fontface: 0,
    default_fontname: "Arial",
    gridonopen: 1,
    gridsize: [15, 15],
    toolbarvisible: 0,
    statusbarvisible: 0,
    ...(title ? { title } : {}),
    ...(deviceWidth === undefined ? {} : { devicewidth: deviceWidth }),
    boxes: boxes.map((b) => ({ box: b })),
    lines: lines.map(([from, out, to, inlet]) => ({ patchline: { source: [from, out], destination: [to, inlet] } })),
    ...project,
    autosave: 0,
  };
}

const SHAPES = {
  "plugin~": [1, 2, ["signal", "signal"]],
  "plugout~": [2, 0, []],
  "live.thisdevice": [1, 3, ["bang", "int", "int"]],
  "node.script": [1, 2, ["", ""]],
  v8: [1, 1, [""]],
  t: [1, 2, ["bang", "bang"]],
  s: [1, 0, []],
  r: [0, 1, [""]],
  pcontrol: [1, 1, [""]],
  loadmess: [1, 1, [""]],
  inlet: [0, 1, [""]],
  route: [1, 3, ["", "", ""]],
};

/** A box. `text` is a Max object's text. Other maxclasses pass their own fields through `extra`. */
export function box(id, text, x, y, extra = {}) {
  const [numinlets, numoutlets, outlettype] = SHAPES[text.split(" ")[0]] ?? [1, 1, [""]];
  return { id, maxclass: "newobj", text, numinlets, numoutlets, outlettype, patching_rect: [x, y, 200, 22], ...extra };
}

export const message = (id, text, x, y) =>
  ({ id, maxclass: "message", text, numinlets: 2, numoutlets: 1, outlettype: [""], patching_rect: [x, y, 200, 22] });

export const button = (id, text, x, y, rect) => ({
  id, maxclass: "textbutton", text, numinlets: 1, numoutlets: 3, outlettype: ["", "", "int"], parameter_enable: 0,
  patching_rect: [x, y, 120, 22], presentation: 1, presentation_rect: rect,
});

export const label = (id, text, rect) => ({
  id, maxclass: "comment", text, numinlets: 1, numoutlets: 0, linecount: 1,
  patching_rect: rect, presentation: 1, presentation_rect: rect,
});
