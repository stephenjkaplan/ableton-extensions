// Browser entry for the mapping dialog. Bundled by build-page-core.ts into one IIFE that assigns the global
// `StemCore`. Imports pure modules only (no node:*), so the page runs the real validator, not a copy.
export { snapshotFromData } from "../snapshot.js";
export { manifestFromResponse, check, pruneStale } from "../mapping-core.js";
