declare module "*.html" {
  const content: string;
  export default content;
}

declare module "*?bundle" {
  /** Source text of the minified browser bundle (global `StemCore`); see build-page-core.ts. */
  const source: string;
  export default source;
}
