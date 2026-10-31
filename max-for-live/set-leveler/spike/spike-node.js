// Throwaway. Logs everything to a file so results don't depend on anyone reading the Max window.
const Max = require("max-api");
const fs = require("node:fs");
const LOG = "/tmp/set-leveler-spike.jsonl";
const write = (o) => fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");

write({ from: "node", kind: "hello", data: { node: process.version, file: __filename, cwd: process.cwd() } });
Max.addHandler("log", (s) => { try { write(JSON.parse(s)); } catch (e) { write({ from: "node", kind: "badlog", data: String(s) }); } });
Max.addHandler("sweep", (s) => write({ from: "v8", kind: "sweep", data: JSON.parse(s) }));
Max.addHandler("ui_loaded", (href) => write({ from: "jweb", kind: "loaded", data: String(href) }));
Max.addHandler("ui_ping", (n) => {
  write({ from: "jweb", kind: "ping", data: n });
  Max.outlet("ui_pong", `Node ${process.version} got click ${n}`);
});
