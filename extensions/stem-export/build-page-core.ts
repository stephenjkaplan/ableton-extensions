import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("./src/ui/page-core.ts", import.meta.url));

/**
 * The single definition of how the mapping page's browser bundle is made: a minified IIFE assigning the global
 * `StemCore`. Used by both build.ts (esbuild plugin) and vitest.config.ts (vite plugin). Nothing is written to disk.
 */
export function bundlePageCore(): string {
  const result = esbuild.buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "StemCore",
    minify: true,
    legalComments: "none",
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}
