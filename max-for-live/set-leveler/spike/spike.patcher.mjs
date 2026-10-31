// Throwaway. Builds dist/spike/Set Leveler Spike.amxd.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { box, button, label, makePatcher, message, writeAmxd } from "../scripts/build-amxd.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "dist", "spike");
rmSync("/tmp/set-leveler-spike.jsonl", { force: true });
mkdirSync(out, { recursive: true });
for (const f of ["spike-bridge.js", "spike-probe.js", "spike-node.js", "spike-probe-node.js", "spike-ui.html"]) {
  copyFileSync(join(here, f), join(out, f));
}

const ui = makePatcher({
  rect: [120, 120, 620, 420],
  title: "Set Leveler test window",
  boxes: [
    box("in", "inlet", 10, 10, { comment: "" }),
    box("rx", "r ---sl-to-web", 10, 40),
    box("lm", `loadmess readfile ${join(out, "spike-ui.html")}`, 230, 40),
    { id: "web", maxclass: "jweb", numinlets: 1, numoutlets: 1, outlettype: [""], rendermode: 0, patching_rect: [0, 0, 620, 420] },
    box("tx", "s ---sl-from-web", 10, 440),
  ],
  lines: [["rx", 0, "web", 0], ["lm", 0, "web", 0], ["web", 0, "tx", 0]],
});

const device = makePatcher({
  deviceWidth: 230,
  presentation: true,
  boxes: [
    box("pi", "plugin~", 10, 10),
    box("po", "plugout~", 10, 40),
    box("load", "live.thisdevice", 10, 80),
    box("fan", "t b b", 10, 110),
    box("wait", "del 2000", 240, 110),
    box("fan2", "t b b", 240, 125),
    message("start", "script start", 10, 140),
    message("hello", "hello", 240, 140),
    box("node", `node.script ${join(out, "spike-node.js")}`, 10, 180),
    box("bridge", `v8 ${join(out, "spike-bridge.js")}`, 240, 180),
    box("probe", "v8 spike-probe.js", 470, 180),
    box("pnode", "node.script spike-probe-node.js", 700, 180),
    box("fromweb", "r ---sl-from-web", 10, 220),
    box("toweb", "s ---sl-to-web", 10, 260),
    button("bRun", "1 Run checks", 240, 10, [10, 12, 210, 30]),
    message("run", "run", 240, 40),
    button("bOpen", "2 Open window", 370, 10, [10, 50, 210, 30]),
    message("open", "open", 370, 40),
    box("pc", "pcontrol", 370, 70),
    { id: "ui", maxclass: "newobj", text: "p ui", numinlets: 1, numoutlets: 0, outlettype: [], patching_rect: [370, 100, 80, 22], patcher: ui },
    label("note", "Set Leveler test device", [10, 90, 210, 22]),
  ],
  lines: [
    ["pi", 0, "po", 0], ["pi", 1, "po", 1],
    ["load", 0, "fan", 0],
    ["fan", 1, "start", 0], ["fan", 0, "wait", 0], ["wait", 0, "fan2", 0], ["fan2", 1, "hello", 0], ["fan2", 0, "probe", 0],
    ["start", 0, "node", 0], ["start", 0, "pnode", 0],
    ["hello", 0, "bridge", 0],
    ["bRun", 0, "run", 0], ["run", 0, "bridge", 0],
    ["bridge", 0, "node", 0], ["probe", 0, "node", 0],
    ["bOpen", 0, "open", 0], ["open", 0, "pc", 0], ["pc", 0, "ui", 0],
    ["fromweb", 0, "node", 0], ["node", 0, "toweb", 0],
  ],
});

writeAmxd(join(out, "Set Leveler Spike.amxd"), device);
console.log(join(out, "Set Leveler Spike.amxd"));
