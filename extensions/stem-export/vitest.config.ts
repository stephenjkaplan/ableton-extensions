import * as fs from "node:fs";
import { defineConfig } from "vitest/config";
import { bundlePageCore } from "./build-page-core.js";

export default defineConfig({
  plugins: [
    {
      // Mirror build.ts's page-core-bundle plugin: `import x from "./page-core.js?bundle"` is the bundle's source text.
      name: "page-core-bundle",
      enforce: "pre",
      resolveId(id) {
        if (id.endsWith("?bundle")) return "\0page-core-bundle";
      },
      load(id) {
        if (id === "\0page-core-bundle") return `export default ${JSON.stringify(bundlePageCore())};`;
      },
    },
    {
      // Mirror build.ts's esbuild `{ ".html": "text" }` loader so `import html from "./x.html"` works in tests.
      name: "html-as-text",
      enforce: "pre",
      load(id) {
        if (id.endsWith(".html")) return `export default ${JSON.stringify(fs.readFileSync(id, "utf8"))};`;
      },
    },
  ],
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
