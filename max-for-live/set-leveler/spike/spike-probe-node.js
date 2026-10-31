// Throwaway. Only proves a node.script file beside the device is found by its bare name.
require("node:fs").appendFileSync("/tmp/set-leveler-spike.jsonl",
  JSON.stringify({ at: new Date().toISOString(), from: "node-probe", kind: "hello", data: __filename }) + "\n");
