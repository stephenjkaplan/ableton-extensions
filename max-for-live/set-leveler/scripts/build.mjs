// Builds dist/Set Leveler/. With --install, also copies it into Live's User Library.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { box, button, label, makePatcher, message, writeAmxd } from "./build-amxd.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "Set Leveler");
const INSTALL_DIR = join(homedir(), "Documents", "Ableton", "User Library", "Presets", "Audio Effects", "Max Audio Effect", "Set Leveler");
const WINDOW = [640, 760];

// The window shows only the page: everything else stays out of presentation mode.
function windowPatcher() {
  return makePatcher({
    rect: [120, 80, ...WINDOW],
    title: "Set Leveler",
    presentation: true,
    boxes: [
      box("in", "inlet", 10, WINDOW[1] + 20),
      box("rx", "r ---sl-to-web", 80, WINDOW[1] + 20),
      {
        id: "web", maxclass: "jweb", numinlets: 1, numoutlets: 1, outlettype: [""], rendermode: 0,
        patching_rect: [0, 0, ...WINDOW], presentation: 1, presentation_rect: [0, 0, ...WINDOW],
      },
      box("tx", "s ---sl-from-web", 300, WINDOW[1] + 20),
    ],
    lines: [["rx", 0, "web", 0], ["web", 0, "tx", 0]],
  });
}

function devicePatcher() {
  return makePatcher({
    deviceWidth: 170,
    presentation: true,
    boxes: [
      box("pi", "plugin~", 10, 10),
      box("po", "plugout~", 10, 40),
      box("load", "live.thisdevice", 10, 80),
      message("start", "script start", 10, 110),
      box("node", "node.script node-main.js", 10, 150),
      box("rt", "route to_live to_web", 10, 190),
      box("bridge", "v8 bridge.js", 10, 230),
      box("fromweb", "r ---sl-from-web", 240, 110),
      box("toweb", "s ---sl-to-web", 240, 230),
      button("bOpen", "Open Set Leveler", 460, 10, [10, 40, 150, 34]),
      box("fan", "t b b", 460, 40),
      message("open", "open", 460, 70),
      box("pc", "pcontrol", 460, 100),
      { id: "ui", maxclass: "newobj", text: "p ui", numinlets: 1, numoutlets: 0, outlettype: [], patching_rect: [460, 130, 80, 22], patcher: windowPatcher() },
      message("opened", "opened", 600, 70),
      label("note", "Set Leveler", [10, 12, 150, 22]),
    ],
    lines: [
      ["pi", 0, "po", 0], ["pi", 1, "po", 1],
      ["load", 0, "start", 0], ["start", 0, "node", 0],
      ["node", 0, "rt", 0], ["rt", 0, "bridge", 0], ["rt", 1, "toweb", 0],
      ["bridge", 0, "node", 0], ["fromweb", 0, "node", 0],
      ["bOpen", 0, "fan", 0], ["fan", 1, "opened", 0], ["fan", 0, "open", 0],
      ["opened", 0, "node", 0], ["open", 0, "pc", 0], ["pc", 0, "ui", 0],
    ],
  });
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, "src", "main.ts")],
  outfile: join(out, "node-main.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["max-api"],
  logLevel: "warning",
});
cpSync(join(root, "device", "bridge.js"), join(out, "bridge.js"));
cpSync(join(root, "device", "ui.html"), join(out, "ui.html"));
writeAmxd(join(out, "Set Leveler.amxd"), devicePatcher());
console.log(out);

if (process.argv.includes("--install")) {
  rmSync(INSTALL_DIR, { recursive: true, force: true });
  mkdirSync(dirname(INSTALL_DIR), { recursive: true });
  cpSync(out, INSTALL_DIR, { recursive: true });
  console.log(`Installed to ${INSTALL_DIR}`);
}
