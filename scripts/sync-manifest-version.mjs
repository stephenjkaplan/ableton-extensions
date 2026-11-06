// A tool's version lives only in its package.json. Live needs it in manifest.json too, so packaging copies it there.
// Run from the tool's folder.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
writeFileSync("manifest.json", JSON.stringify({ ...manifest, version }, null, 4) + "\n");
