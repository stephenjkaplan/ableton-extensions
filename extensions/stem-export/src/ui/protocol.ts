import type { Manifest } from "../manifest-core.js";
import type { SnapshotData } from "../snapshot.js";
import type { Finding, KeyTap } from "../validate.js";
import mappingHtml from "./mapping.html";
import pageCoreSource from "./page-core.js?bundle";

/** What the host sends into the mapping webview (injected as `window.__REQUEST__`). */
export interface MappingRequest {
  /** Prefill for the dialog's editable song-name field. */
  song: string;
  tempDirectory: string;
  stemNames: string[];
  current: { assignments: Record<string, string>; extras: { name: string; trackKeys: string[] }[] };
  /**
   * The Set as the host captured it, in plain data: the ONLY copy of the track list. The page lists its rows from
   * `snapshot.tracks` (depth is `groupPath.length`) and rebuilds the snapshot with `StemCore.snapshotFromData` to
   * run the real validator on every edit, so the pre-flight panel always reflects the CURRENT assignments.
   *
   * `effectiveMuted` is EFFECTIVE mutedness, decided by the host and never re-derived by the page: the track's
   * own mute OR any ancestor group's mute (true for group rows too). `audible` is the snapshot's own
   * (`!isGroup && !effectiveMuted`); the page uses it as is. Muted tracks are shown as held out and cannot be assigned.
   */
  snapshot: SnapshotData;
  /** The seed manifest (saved mapping, stale keys already pruned). The page layers the user's edits on it. */
  base: Manifest;
  /** Sidechain key taps the host read from the Set; an input to the validator. */
  taps: KeyTap[];
  /**
   * Host-only information the page cannot compute (for example the "set the song name" note). Shown ahead of the
   * findings the page computes itself. The host sends NO validation findings: the page derives those.
   */
  notes: Finding[];
  outputPreview: { stem: string; count: number; filename: string }[];
}

/** What the webview hands back through `close_and_send`. */
export interface MappingResponse {
  cancelled: boolean;
  /** The song name as confirmed (and possibly edited) in the dialog. Empty only when cancelled. */
  song: string;
  assignments: Record<string, string>; // trackKey -> stem
  extras: { name: string; trackKeys: string[] }[];
}

const REQUEST_MARKER = "<!--REQUEST-->";
const CORE_MARKER = "<!--CORE-->";

/** JSON that is safe inside a <script> element: no `</script>`, no `<!--`, no line separators. */
function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));
}

/**
 * The page bundle is inserted verbatim: escaping `</script` or `<!--` inside JS source is only correct in some
 * contexts (strings yes; regex with the u/v flag, String.raw, bare code no), so a bundle containing either is refused.
 */
function assertEmbeddable(coreSource: string): void {
  const found = /<\/script|<!--/i.exec(coreSource);
  if (!found) return;
  const what = found[0] === "<!--"
    ? "`<!--`, which opens an HTML comment inside the script element"
    : `\`${found[0]}\`, which would end the script element`;
  throw new Error(`The page bundle contains ${what}. Remove it from the bundle's source or its dependencies.`);
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/**
 * Fills both markers of `html` in ONE pass over the template, with function replacers. Replacement output is never
 * rescanned, so neither payload can be seen as (or corrupt) the other marker, and `$&`-style sequences in a payload
 * are inserted literally.
 */
export function injectIntoPage(html: string, requestScript: string, coreScript: string): string {
  for (const m of [REQUEST_MARKER, CORE_MARKER]) {
    if (count(html, m) !== 1) throw new Error(`mapping.html must contain ${m} exactly once`);
  }
  assertEmbeddable(coreScript);
  return html.replace(/<!--(?:REQUEST|CORE)-->/g, (m) => (m === REQUEST_MARKER ? requestScript : coreScript));
}

/** The payload for `data:text/html,<payload>`: the full page with the request and core injected, URI-encoded. */
export function encodeRequest(r: MappingRequest): string {
  // The request (song name included) reaches the page only through this JSON payload.
  const requestScript = `<script>window.__REQUEST__=${scriptSafeJson(r)};</script>`;
  return encodeURIComponent(injectIntoPage(mappingHtml, requestScript, pageCoreSource));
}

function fail(what: string): never {
  throw new Error(`Malformed mapping response: ${what}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates the webview's reply. Throws on anything unexpected; never returns a partial mapping. */
export function parseResponse(raw: string): MappingResponse {
  // Live may hand back an empty string when the window is closed without a result: that is a cancel.
  if (raw.trim() === "") return { cancelled: true, song: "", assignments: {}, extras: [] };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return fail("not valid JSON");
  }
  if (!isRecord(v)) return fail("expected an object");
  if (typeof v.cancelled !== "boolean") return fail("`cancelled` must be a boolean");
  if (v.cancelled) return { cancelled: true, song: "", assignments: {}, extras: [] };

  if (typeof v.song !== "string" || v.song.trim() === "") return fail("`song` must be a non-empty string");
  if (!isRecord(v.assignments)) return fail("`assignments` must be an object");
  const assignments: Record<string, string> = {};
  for (const [k, stem] of Object.entries(v.assignments)) {
    if (typeof stem !== "string" || stem === "") return fail(`assignment for "${k}" must be a non-empty string`);
    assignments[k] = stem;
  }

  if (!Array.isArray(v.extras)) return fail("`extras` must be an array");
  const extras = v.extras.map((e, i) => {
    if (!isRecord(e)) return fail(`extras[${i}] must be an object`);
    if (typeof e.name !== "string" || e.name.trim() === "") return fail(`extras[${i}].name must be a non-empty string`);
    if (!Array.isArray(e.trackKeys) || !e.trackKeys.every((k) => typeof k === "string")) {
      return fail(`extras[${i}].trackKeys must be an array of strings`);
    }
    return { name: e.name, trackKeys: e.trackKeys as string[] };
  });

  return { cancelled: false, song: v.song.trim(), assignments, extras };
}
