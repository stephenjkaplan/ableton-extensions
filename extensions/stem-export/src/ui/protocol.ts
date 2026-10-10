import type { Finding } from "../validate.js";
import mappingHtml from "./mapping.html";

/** What the host sends into the mapping webview (injected as `window.__REQUEST__`). */
export interface MappingRequest {
  song: string;
  tempDirectory: string;
  tracks: { key: string; name: string; depth: number; isGroup: boolean; muted: boolean; devices: string[] }[];
  stemNames: string[];
  current: { assignments: Record<string, string>; extras: { name: string; trackKeys: string[] }[] };
  findings: Finding[];
  outputPreview: { stem: string; count: number; filename: string }[];
}

/** What the webview hands back through `close_and_send`. */
export interface MappingResponse {
  cancelled: boolean;
  assignments: Record<string, string>; // trackKey -> stem
  extras: { name: string; trackKeys: string[] }[];
}

const MARKER = "<!--REQUEST-->";
const TITLE_MARKER = "<!--SONG-->";

/** Text for <title>: only `<` and anything that would parse as a character reference needs escaping. */
function titleText(s: string): string {
  return s.replace(/</g, "&lt;").replace(/&(?=#?\w+;)/g, "&amp;");
}

/** JSON that is safe inside a <script> element: no `</script>`, no `<!--`, no line separators. */
function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));
}

/** The payload for `data:text/html,<payload>`: the full page with the request injected, URI-encoded. */
export function encodeRequest(r: MappingRequest): string {
  if (!mappingHtml.includes(MARKER) || !mappingHtml.includes(TITLE_MARKER)) throw new Error("mapping.html is missing a request marker");
  const script = `<script>window.__REQUEST__=${scriptSafeJson(r)};</script>`;
  // Function replacement: the JSON may contain `$&`-style sequences that a string replacement would expand.
  const page = mappingHtml.replace(TITLE_MARKER, () => titleText(r.song)).replace(MARKER, () => script);
  return encodeURIComponent(page);
}

function fail(what: string): never {
  throw new Error(`Malformed mapping response: ${what}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates the webview's reply. Throws on anything unexpected; never returns a partial mapping. */
export function parseResponse(raw: string): MappingResponse {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return fail("not valid JSON");
  }
  if (!isRecord(v)) return fail("expected an object");
  if (typeof v.cancelled !== "boolean") return fail("`cancelled` must be a boolean");
  if (v.cancelled) return { cancelled: true, assignments: {}, extras: [] };

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

  return { cancelled: false, assignments, extras };
}
