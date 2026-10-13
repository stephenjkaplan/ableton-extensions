import * as esbuild from "esbuild";
import * as fs from "node:fs";
import { bundlePageCore } from "./build-page-core.js";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");

// Resolves `./page-core.js?bundle` to the browser bundle's source text (a string export). Nothing is written to disk.
const pageCoreBundle: esbuild.Plugin = {
  name: "page-core-bundle",
  setup(b) {
    b.onResolve({ filter: /\?bundle$/ }, (a) => ({ path: a.path, namespace: "page-core-bundle" }));
    b.onLoad({ filter: /.*/, namespace: "page-core-bundle" }, () => ({
      contents: `export default ${JSON.stringify(bundlePageCore())};`,
      loader: "js",
    }));
  },
};

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  sourcemap: !production,
  loader: { ".html": "text" },
  plugins: [pageCoreBundle],
});
