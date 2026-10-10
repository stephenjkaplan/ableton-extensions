import * as fs from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
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
